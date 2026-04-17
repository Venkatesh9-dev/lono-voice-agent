// src/handlers/streamHandler.js
// FIX: Deepgram retry capped at 3 — no infinite loop
// FIX: Deepgram language 'multi' not hardcoded 'te' — catches Hindi/English mid-call
// FIX: all noise filters from v1 retained
// FIX: metrics tracking on every call event
// FIX [v2.1]: setupDeepgram() moved from 'connected' to 'start' event handler.
// FIX [v2.1]: Twilio fallback TwiML now re-includes <Start><Stream>.
// FIX [v2.2]: speakToUser() now sends audio as 160-byte (20ms) chunks with proper
//             Twilio 'mark' events. Previously one giant payload was sent — Twilio
//             silently truncates large media messages, so callers heard only the first
//             ~0.5 seconds ("dot lono finance emi") and nothing more.
//             Each chunk is sent as a separate 'media' message, followed by a 'mark'
//             event so Twilio knows when playback of each phrase is complete.
// FIX [v2.2]: isPlayingAudio flag prevents Deepgram transcripts from being processed
//             while the agent is speaking — stops the agent from interrupting itself.

const WebSocket = require('ws');
const twilio    = require('twilio');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { getAIResponse, generateCallSummary }    = require('../services/llmService');
const { textToSpeech, chunkAudio }              = require('../services/ttsService');
const sessionManager = require('../services/sessionManager');
const { logCallToSheets, logLeadToSheets }      = require('../services/sheetsService');
const { sendOwnerCallSummary }                  = require('../services/notificationService');
const logger = require('../utils/logger');

const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);

const MAX_CALL_SECONDS  = parseInt(process.env.MAX_CALL_DURATION_SECONDS) || 180;
const IDLE_TIMEOUT_MS   = (parseInt(process.env.IDLE_TIMEOUT_SECONDS) || 25) * 1000;
const DEBOUNCE_MS       = 1200;
const MIN_TRANSCRIPT    = 8;
const MIN_CONFIDENCE    = 0.75;
const MAX_DG_RETRIES    = 3;

const BYE_PATTERNS = [
  'bye', 'goodbye', 'thank you bye', 'thanks bye', 'not interested',
  'no thanks', 'stop calling', "that's all",
  'సరే సార్', 'థాంక్యూ', 'వద్దు', 'అక్కర్లేదు', 'సెలవు', 'ఇప్పుడు వద్దు',
  'ठीक है', 'धन्यवाद', 'नहीं चाहिए', 'बाय',
];

function detectBye(transcript) {
  const lower = transcript.toLowerCase();
  return BYE_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

function sanitize(text) {
  return text
    .replace(/[^\w\s\u0900-\u097F\u0C00-\u0C7F.,!?'%-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const activeConnections = new Map();
const twilioRest = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const GREETING       = 'నమస్తే సార్, నేను సిద్దిపేట బ్రాంచ్ నుంచి మాట్లాడుతున్నాను. మాది Lono Finance కంపెనీ సార్. మీరు ప్రస్తుతం ఏమైనా EMI కడుతున్నారా సార్?';
const GOODBYE_TEL    = 'సరే సార్, మీ సమయానికి థాంక్యూ సార్. ఫ్యూచర్‌లో అవసరం అయితే మాకు కాల్ చేయండి సార్. శుభదినం సార్.';
const TIMEOUT_TEL    = 'సార్, మీ సమయానికి థాంక్యూ సార్. మళ్ళీ కాల్ చేస్తాం సార్. శుభదినం.';
const IDLE_TEL       = 'సార్, మీరు వింటున్నారా? మీకు ఏదైనా సహాయం చేయగలనా సార్?';
const STT_FAIL_TEL   = 'సార్, కనెక్షన్‌లో సమస్య వస్తోంది. దయచేసి మళ్ళీ కాల్ చేయండి సార్. థాంక్యూ సార్.';

// FIX [v2.2]: Utility — send a single 160-byte mulaw chunk as a Twilio media message
function sendChunk(ws, streamSid, chunk) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    event:    'media',
    streamSid,
    media: { payload: chunk.toString('base64') },
  }));
}

// FIX [v2.2]: Send a Twilio 'mark' event — signals end of an audio sequence.
// Twilio fires a 'mark' callback on the WebSocket when it finishes playing
// all audio up to this point, enabling precise turn-taking.
function sendMark(ws, streamSid, label) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    event:    'mark',
    streamSid,
    mark: { name: label },
  }));
}

// FIX [v2.2]: Stream all 160-byte chunks to Twilio with a small inter-chunk delay.
// The delay (20ms = one mulaw frame duration) paces delivery to match real-time
// playback speed, preventing Twilio's jitter buffer from overflowing and dropping frames.
// Without this pacing, sending all chunks synchronously floods the WS send buffer
// and Twilio drops the excess — resulting in truncated audio.
async function streamAudioChunks(ws, streamSid, audioBuffer, markLabel) {
  const chunks = chunkAudio(audioBuffer);
  logger.debug('Streaming audio', { chunks: chunks.length, bytes: audioBuffer.length, markLabel });

  for (const chunk of chunks) {
    sendChunk(ws, streamSid, chunk);
    // 20ms inter-chunk pacing — matches mulaw frame duration at 8kHz
    await new Promise(r => setTimeout(r, 20));
  }

  // Send mark after all chunks — Twilio uses this to signal playback complete
  sendMark(ws, streamSid, markLabel);
}

function setupStreamHandler(wss) {
  wss.on('connection', (ws) => {
    logger.info('New WebSocket connection');

    let callSid          = null;
    let callerPhone      = null;
    let dgConnection     = null;
    let dgRetryCount     = 0;
    let isProcessing     = false;
    let isPlayingAudio   = false; // FIX [v2.2]: block STT processing while agent speaks
    let transcriptBuffer = '';
    let streamSid        = null;
    let sessionEnded     = false;
    let silenceTimer     = null;
    let idleTimer        = null;
    let maxCallTimer     = null;
    let markCounter      = 0;    // FIX [v2.2]: unique label per mark event

    // ── Deepgram — multilingual with retry cap ────────────────
    function setupDeepgram() {
      if (dgRetryCount >= MAX_DG_RETRIES) {
        logger.error('Deepgram max retries reached — ending call gracefully', { callSid });
        speakToUser(STT_FAIL_TEL).then(() => {
          setTimeout(() => handleCallEnd('stt_failure'), 3000);
        });
        return;
      }

      try {
        dgConnection = deepgramClient.listen.live({
          model:            'nova-2',
          language:         'multi',
          smart_format:     true,
          interim_results:  true,
          utterance_end_ms: 1500,
          vad_events:       true,
          endpointing:      300,
          encoding:         'mulaw',
          sample_rate:      8000,
          channels:         1,
        });

        dgConnection.on(LiveTranscriptionEvents.Open, () => {
          dgRetryCount = 0;
          logger.debug('Deepgram open', { callSid });
        });

        dgConnection.on(LiveTranscriptionEvents.UtteranceEnd, async () => {
          // FIX [v2.2]: ignore transcript while agent is speaking — prevents self-interruption
          if (isPlayingAudio) {
            transcriptBuffer = '';
            return;
          }
          const final = sanitize(transcriptBuffer.trim());
          if (final.length >= MIN_TRANSCRIPT && !isProcessing) {
            clearTimeout(silenceTimer);
            transcriptBuffer = '';
            await processUserInput(final);
          } else {
            transcriptBuffer = '';
          }
        });

        dgConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
          const alt        = data.channel?.alternatives?.[0];
          const transcript = alt?.transcript;
          const isFinal    = data.is_final;
          const confidence = alt?.confidence || 0;

          if (!transcript || !transcript.trim()) return;
          if (confidence < MIN_CONFIDENCE) return;

          // FIX [v2.2]: discard transcript while agent is speaking
          if (isPlayingAudio) return;

          resetIdleTimer();

          if (isFinal) {
            const clean = sanitize(transcript);
            if (!clean) return;
            transcriptBuffer += ' ' + clean;

            clearTimeout(silenceTimer);
            silenceTimer = setTimeout(async () => {
              if (isPlayingAudio) { transcriptBuffer = ''; return; }
              const final = sanitize(transcriptBuffer.trim());
              transcriptBuffer = '';
              if (final.length >= MIN_TRANSCRIPT && !isProcessing) {
                await processUserInput(final);
              }
            }, DEBOUNCE_MS);
          }
        });

        dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
          logger.error('Deepgram error', { error: err.message, callSid, dgRetryCount });
          dgRetryCount++;
          setTimeout(() => {
            if (!sessionEnded) setupDeepgram();
          }, 2000 * dgRetryCount);
        });

        dgConnection.on(LiveTranscriptionEvents.Close, () => {
          logger.debug('Deepgram closed', { callSid });
        });

      } catch (err) {
        logger.error('Deepgram setup failed', { error: err.message });
        dgRetryCount++;
        if (dgRetryCount < MAX_DG_RETRIES && !sessionEnded) {
          setTimeout(setupDeepgram, 2000);
        }
      }
    }

    // ── Idle Timer ────────────────────────────────────────────
    function resetIdleTimer() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(async () => {
        if (sessionEnded) return;
        const session = await sessionManager.getSession(callSid);
        if (!session) return;
        if ((session.idleWarningsSent || 0) === 0) {
          await sessionManager.updateSession(callSid, { idleWarningsSent: 1 });
          await speakToUser(IDLE_TEL);
          resetIdleTimer();
        } else {
          await speakToUser(TIMEOUT_TEL);
          setTimeout(() => handleCallEnd('idle_timeout'), 3000);
        }
      }, IDLE_TIMEOUT_MS);
    }

    // ── Process speech → LLM → TTS → caller ──────────────────
    async function processUserInput(transcript) {
      if (isProcessing || sessionEnded) return;
      isProcessing = true;

      try {
        logger.info('Processing', { callSid, chars: transcript.length });

        if (detectBye(transcript)) {
          logger.info('Bye detected', { callSid });
          await speakToUser(GOODBYE_TEL);
          await sessionManager.incrementMetric('calls_completed');
          setTimeout(() => handleCallEnd('caller_ended'), 3500);
          return;
        }

        const session = await sessionManager.getSession(callSid);
        if (!session) {
          logger.warn('Session not found', { callSid });
          return;
        }

        await sessionManager.addMessage(callSid, 'user', transcript);
        const aiResult = await getAIResponse(session, transcript);
        await sessionManager.addMessage(callSid, 'assistant', aiResult.text);

        if (aiResult.leadData) {
          await sessionManager.updateSession(callSid, {
            leadData: { ...(session.leadData || {}), ...aiResult.leadData }
          });
          await sessionManager.incrementMetric('leads_captured');
          logger.info('Lead captured', { callSid });
        }

        if (aiResult.status === 'not_interested') {
          await sessionManager.incrementMetric('not_interested');
          await sessionManager.updateSession(callSid, { outcome: 'not_interested' });
        }

        if (aiResult.transfer && process.env.ENABLE_HUMAN_TRANSFER === 'true') {
          await speakToUser(aiResult.text);
          await handleTransfer();
          return;
        }

        await speakToUser(aiResult.text);

        if (detectBye(aiResult.text)) {
          setTimeout(() => handleCallEnd('agent_ended'), 4000);
        }

      } catch (err) {
        logger.error('processUserInput error', { error: err.message, callSid });
      } finally {
        isProcessing = false;
      }
    }

    // ── TTS → send audio to caller ────────────────────────────
    // FIX [v2.2]: Now uses streamAudioChunks() instead of sending one large payload.
    // Sets isPlayingAudio=true during streaming so Deepgram transcripts are ignored
    // while the agent is speaking — prevents self-interruption and echo feedback loops.
    async function speakToUser(text, language = 'telugu') {
      if (!text || !streamSid || sessionEnded) return;
      try {
        const result = await textToSpeech(text, language);
        if (!result) return;

        if (result.isFallback) {
          // FIX [v2.1]: re-include <Start><Stream> so media stream survives fallback
          const wsHost = process.env.BASE_URL.replace(/^https?:\/\//, '');
          try {
            await twilioRest.calls(callSid).update({
              twiml: [
                '<Response>',
                `  <Say voice="${result.voice}" language="${result.langCode}">${escapeXml(result.text)}</Say>`,
                `  <Start><Stream url="wss://${wsHost}/call/stream"/></Start>`,
                '  <Pause length="3600"/>',
                '</Response>',
              ].join(''),
            });
          } catch (err) {
            logger.error('Twilio Say fallback failed', { error: err.message });
          }
          return;
        }

        if (ws.readyState !== WebSocket.OPEN) return;

        // FIX [v2.2]: Set flag before streaming — blocks STT callbacks during playback
        isPlayingAudio = true;
        const audioBuffer = Buffer.isBuffer(result) ? result : Buffer.from(result);
        const label = `speak-${++markCounter}`;

        try {
          await streamAudioChunks(ws, streamSid, audioBuffer, label);
          // Brief settling time after last chunk before re-enabling STT
          // Prevents the tail of TTS audio from being picked up as caller speech
          await new Promise(r => setTimeout(r, 300));
        } finally {
          // FIX [v2.2]: Always re-enable STT even if streaming throws
          isPlayingAudio = false;
          logger.debug('Audio playback complete', { label, callSid });
        }

      } catch (err) {
        logger.error('speakToUser error', { error: err.message });
        isPlayingAudio = false;
      }
    }

    async function handleTransfer() {
      if (!process.env.HUMAN_TRANSFER_NUMBER) return;
      try {
        await twilioRest.calls(callSid).update({
          twiml: `<Response><Dial>${process.env.HUMAN_TRANSFER_NUMBER}</Dial></Response>`
        });
        await sessionManager.updateSession(callSid, { outcome: 'transferred' });
        await sessionManager.incrementMetric('transfers');
        logger.info('Call transferred', { callSid });
      } catch (err) {
        logger.error('Transfer failed', { error: err.message });
      }
    }

    async function handleCallEnd(reason = 'completed') {
      if (sessionEnded) return;
      sessionEnded = true;
      clearTimeout(silenceTimer);
      clearTimeout(idleTimer);
      clearTimeout(maxCallTimer);

      logger.info('Call ending', { callSid, reason });

      try {
        await twilioRest.calls(callSid).update({ twiml: `<Response><Hangup/></Response>` });
      } catch (err) {
        logger.warn('Hangup REST failed', { error: err.message });
      }

      try {
        const finalSession = await sessionManager.endSession(callSid, reason);
        if (!finalSession) return;

        const summary = await generateCallSummary(finalSession);

        await Promise.allSettled([
          logCallToSheets(finalSession, summary),
          finalSession.leadData?.name ? logLeadToSheets(finalSession) : Promise.resolve(),
          sendOwnerCallSummary(finalSession, summary),
        ]);

        logger.info('Post-call done', { callSid, reason });

      } catch (err) {
        logger.error('handleCallEnd error', { error: err.message, callSid });
      } finally {
        activeConnections.delete(callSid);
        if (dgConnection) try { dgConnection.finish(); } catch {}
      }
    }

    // ── Twilio WebSocket message router ───────────────────────
    ws.on('message', async (rawMsg) => {
      try {
        const msg = JSON.parse(rawMsg);

        switch (msg.event) {
          case 'connected':
            // FIX [v2.1]: setupDeepgram moved to 'start' — callSid/streamSid null here
            logger.debug('Twilio stream connected — waiting for start event');
            break;

          case 'start':
            callSid     = msg.start?.callSid;
            streamSid   = msg.start?.streamSid;
            callerPhone = msg.start?.customParameters?.callerPhone || 'unknown';

            activeConnections.set(callSid, ws);

            try {
              await sessionManager.createSession(callSid, callerPhone, true);
              await sessionManager.incrementMetric('calls_answered');
            } catch (err) {
              logger.error('Session create failed', { error: err.message });
            }

            // FIX [v2.1]: Deepgram now started here — callSid and streamSid are set
            setupDeepgram();

            maxCallTimer = setTimeout(async () => {
              if (sessionEnded) return;
              await speakToUser(TIMEOUT_TEL);
              setTimeout(() => handleCallEnd('max_duration'), 3000);
            }, MAX_CALL_SECONDS * 1000);

            setTimeout(async () => {
              try {
                await speakToUser(GREETING);
                await sessionManager.addMessage(callSid, 'assistant', GREETING);
                setTimeout(() => resetIdleTimer(), 500);
              } catch (err) {
                logger.error('Greeting error', { error: err.message });
              }
            }, 1200);
            break;

          case 'media':
            if (dgConnection && msg.media?.payload) {
              try {
                dgConnection.send(Buffer.from(msg.media.payload, 'base64'));
              } catch (err) {
                logger.error('Deepgram send error', { error: err.message });
              }
            }
            break;

          // FIX [v2.2]: Handle Twilio 'mark' acknowledgement — logged for debugging
          case 'mark':
            logger.debug('Twilio mark received', { name: msg.mark?.name, callSid });
            break;

          case 'stop':
            await handleCallEnd('completed');
            break;
        }

      } catch (err) {
        logger.error('WebSocket message error', { error: err.message });
      }
    });

    ws.on('close', async () => {
      clearTimeout(silenceTimer);
      await handleCallEnd('ws_closed');
    });

    ws.on('error', (err) => {
      logger.error('WebSocket error', { error: err.message, callSid });
    });
  });
}

module.exports = { setupStreamHandler };