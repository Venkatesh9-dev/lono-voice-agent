// src/handlers/streamHandler.js
//
// REWRITE: Deepgram removed — replaced with ElevenLabs Scribe STT
// ElevenLabs handles both TTS and STT — no third-party STT service needed.
//
// STT pipeline:
//   Twilio µ-law audio → energy VAD → silence detected →
//   µ-law decode → WAV packaging → ElevenLabs Scribe API → transcript
//
// Why this works:
//   ElevenLabs Scribe (scribe_v1) supports Telugu, accepts WAV, returns text.
//   VAD (voice activity detection) buffers speech and flushes on silence.
//   No WebSocket STT connection = no connection failures, no retries, no drops.

const WebSocket = require('ws');
const twilio    = require('twilio');
const { getAIResponse, generateCallSummary } = require('../services/llmService');
const { textToSpeech, chunkAudio }           = require('../services/ttsService');
const sessionManager                          = require('../services/sessionManager');
const { logCallToSheets, logLeadToSheets }   = require('../services/sheetsService');
const { sendOwnerCallSummary }               = require('../services/notificationService');
const logger = require('../utils/logger');

const MAX_CALL_SECONDS = parseInt(process.env.MAX_CALL_DURATION_SECONDS) || 180;
const IDLE_TIMEOUT_MS  = (parseInt(process.env.IDLE_TIMEOUT_SECONDS) || 25) * 1000;
const MIN_TRANSCRIPT   = 3;

// ── VAD tuning ────────────────────────────────────────────────
// Twilio µ-law 8 kHz mono — 160 bytes per 20 ms frame
// RMS energy of decoded PCM: silence ≈ 0–100, soft speech ≈ 200–800, normal ≈ 800+
const SILENCE_THRESHOLD_RMS  = 250; // below = silence; tune up if false triggers
const MIN_SPEECH_MS           = 300; // ignore utterances shorter than this
const SILENCE_TO_END_MS       = 800; // silence duration that ends an utterance

const BYE_PATTERNS = [
  'bye', 'goodbye', 'thank you bye', 'thanks bye', 'not interested',
  'no thanks', 'stop calling', "that's all",
  'సరే సార్', 'థాంక్యూ', 'వద్దు', 'అక్కర్లేదు', 'సెలవు', 'ఇప్పుడు వద్దు',
  'ठीक है', 'धन्यवाद', 'नहीं चाहिए', 'बाय',
];

function detectBye(text) {
  const lower = text.toLowerCase();
  return BYE_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

function sanitize(text) {
  return text
    .replace(/[^\w\s\u0900-\u097F\u0C00-\u0C7F.,!?'%-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── µ-law decode ──────────────────────────────────────────────
function ulawToLinear(uVal) {
  uVal = ~uVal & 0xFF;
  const sign     = uVal & 0x80;
  const exponent = (uVal >> 4) & 0x07;
  const mantissa = uVal & 0x0F;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

// ── RMS energy of a µ-law buffer ──────────────────────────────
function getRmsEnergy(buf) {
  let sum = 0;
  for (const byte of buf) {
    const s = ulawToLinear(byte);
    sum += s * s;
  }
  return Math.sqrt(sum / buf.length);
}

// ── µ-law buffer → WAV buffer ─────────────────────────────────
function buildWav(ulawBuf) {
  const sampleRate    = 8000;
  const numChannels   = 1;
  const bitsPerSample = 16;
  const byteRate      = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign    = numChannels * bitsPerSample / 8;
  const dataSize      = ulawBuf.length * 2; // 16-bit = 2 bytes

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);              // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  const pcm = Buffer.allocUnsafe(dataSize);
  for (let i = 0; i < ulawBuf.length; i++) {
    pcm.writeInt16LE(ulawToLinear(ulawBuf[i]), i * 2);
  }
  return Buffer.concat([header, pcm]);
}

// ── ElevenLabs Scribe STT call ────────────────────────────────
async function elevenLabsSTT(ulawBuf) {
  const wavBuf    = buildWav(ulawBuf);
  const boundary  = 'EL' + Date.now().toString(36);

  const parts = [
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`
    ),
    wavBuf,
    Buffer.from('\r\n'),
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model_id"\r\n\r\nscribe_v1\r\n`
    ),
    // Telugu language code — Scribe supports it (unlike TTS API)
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="language_code"\r\n\r\nte\r\n`
    ),
    Buffer.from(`--${boundary}--\r\n`),
  ];

  const body = Buffer.concat(parts);

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 10000); // 10s STT timeout

  try {
    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method:  'POST',
      headers: {
        'xi-api-key':   process.env.ELEVENLABS_API_KEY,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`ElevenLabs STT ${response.status}: ${err}`);
    }

    const result = await response.json();
    return (result.text || '').trim();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

const activeConnections = new Map();
const twilioRest = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const GREETING    = 'నమస్తే సార్, నేను సిద్దిపేట బ్రాంచ్ నుంచి మాట్లాడుతున్నాను. మాది Lono Finance కంపెనీ సార్. మీరు ప్రస్తుతం ఏమైనా EMI కడుతున్నారా సార్?';
const GOODBYE_TEL = 'సరే సార్, మీ సమయానికి థాంక్యూ సార్. ఫ్యూచర్‌లో అవసరం అయితే మాకు కాల్ చేయండి సార్. శుభదినం సార్.';
const TIMEOUT_TEL = 'సార్, మీ సమయానికి థాంక్యూ సార్. మళ్ళీ కాల్ చేస్తాం సార్. శుభదినం.';
const IDLE_TEL    = 'సార్, మీరు వింటున్నారా? మీకు ఏదైనా సహాయం చేయగలనా సార్?';

function setupStreamHandler(wss) {
  wss.on('connection', (ws) => {
    logger.info('New WebSocket connection');

    let callSid      = null;
    let streamSid    = null;
    let callerPhone  = null;
    let sessionEnded = false;
    let isProcessing = false;
    let idleTimer    = null;
    let maxCallTimer = null;

    // VAD state
    let speechChunks   = [];
    let speechStart    = 0;
    let isSpeaking     = false;
    let vadTimer       = null;

    // ── Idle timer ────────────────────────────────────────────
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

    // ── VAD: receive one 20ms µ-law frame ─────────────────────
    async function onAudioFrame(audioData) {
      if (isProcessing || sessionEnded) return;

      const energy = getRmsEnergy(audioData);

      if (energy > SILENCE_THRESHOLD_RMS) {
        // ── Speech active ──
        if (!isSpeaking) {
          isSpeaking   = true;
          speechChunks = [];
          speechStart  = Date.now();
          logger.debug('🎙️  Speech detected', { callSid, energy: Math.round(energy) });
        }
        clearTimeout(vadTimer);
        speechChunks.push(Buffer.from(audioData));
        resetIdleTimer();

      } else if (isSpeaking) {
        // ── Trailing silence ──
        speechChunks.push(Buffer.from(audioData)); // keep trailing silence for natural audio
        clearTimeout(vadTimer);

        vadTimer = setTimeout(async () => {
          if (!isSpeaking || sessionEnded) return;
          isSpeaking = false;

          const duration = Date.now() - speechStart;
          if (duration < MIN_SPEECH_MS) {
            logger.debug('⚠️  Utterance too short, skipping', { callSid, ms: duration });
            speechChunks = [];
            return;
          }

          const buf = Buffer.concat(speechChunks);
          speechChunks = [];
          logger.info('🎙️  Utterance complete — transcribing', {
            callSid,
            ms: duration,
            bytes: buf.length,
          });
          await transcribeAndProcess(buf);
        }, SILENCE_TO_END_MS);
      }
    }

    // ── STT → Claude → TTS ────────────────────────────────────
    async function transcribeAndProcess(ulawBuf) {
      if (isProcessing || sessionEnded) return;
      isProcessing = true;
      try {
        logger.info('📤 Calling ElevenLabs STT...', { callSid, bytes: ulawBuf.length });
        const raw = await elevenLabsSTT(ulawBuf);

        if (!raw || raw.length < MIN_TRANSCRIPT) {
          logger.warn('⚠️  Empty transcript, ignoring', { callSid, raw });
          return;
        }

        const transcript = sanitize(raw);
        logger.info('✅ STT transcript', { callSid, transcript });
        await processUserInput(transcript);

      } catch (err) {
        logger.error('❌ STT error', { callSid, error: err.message });
      } finally {
        isProcessing = false;
      }
    }

    // ── Transcript → LLM → speak response ────────────────────
    async function processUserInput(transcript) {
      if (sessionEnded) return;
      try {
        logger.info('📥 Processing user input', { callSid, transcript });

        if (detectBye(transcript)) {
          await speakToUser(GOODBYE_TEL);
          await sessionManager.incrementMetric('calls_completed');
          setTimeout(() => handleCallEnd('caller_ended'), 3500);
          return;
        }

        const session = await sessionManager.getSession(callSid);
        if (!session) return;

        await sessionManager.addMessage(callSid, 'user', transcript);

        logger.info('🤖 Calling Claude...', { callSid });
        const aiResult = await getAIResponse(session, transcript);
        logger.info('✅ Claude response', { callSid, length: aiResult.text.length });

        await sessionManager.addMessage(callSid, 'assistant', aiResult.text);

        if (aiResult.leadData) {
          await sessionManager.updateSession(callSid, {
            leadData: { ...(session.leadData || {}), ...aiResult.leadData }
          });
          await sessionManager.incrementMetric('leads_captured');
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
        logger.error('❌ processUserInput error', { callSid, error: err.message });
      }
    }

    // ── TTS → send audio frames to Twilio ────────────────────
    async function speakToUser(text, language = 'telugu') {
      if (!text || !streamSid || sessionEnded) {
        logger.warn('⚠️  speakToUser skipped', {
          callSid, hasText: !!text, hasStreamSid: !!streamSid, sessionEnded,
        });
        return;
      }
      try {
        logger.info('🎤 Speaking to user', { callSid, textLength: text.length });
        const buf = await textToSpeech(text, language);
        if (!buf) return;

        if (ws.readyState !== WebSocket.OPEN) return;

        const chunks = chunkAudio(buf);
        logger.info(`📤 Sending ${chunks.length} audio frames to Twilio`, { callSid });

        for (const chunk of chunks) {
          if (ws.readyState !== WebSocket.OPEN || sessionEnded) break;
          ws.send(JSON.stringify({
            event:    'media',
            streamSid,
            media: { payload: chunk.toString('base64') },
          }));
          await sleep(20); // pace at 8kHz mulaw real-time
        }
        logger.info('✅ Audio sent', { callSid, textLength: text.length });

      } catch (err) {
        logger.error('❌ speakToUser error', { callSid, error: err.message });
        throw err;
      }
    }

    async function handleTransfer() {
      if (!process.env.HUMAN_TRANSFER_NUMBER) return;
      try {
        await twilioRest.calls(callSid).update({
          twiml: `<Response><Dial>${process.env.HUMAN_TRANSFER_NUMBER}</Dial></Response>`,
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
      clearTimeout(idleTimer);
      clearTimeout(maxCallTimer);
      clearTimeout(vadTimer);

      logger.info('Call ending', { callSid, reason });

      try {
        await twilioRest.calls(callSid).update({ twiml: '<Response><Hangup/></Response>' });
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
        logger.error('handleCallEnd error', { callSid, error: err.message });
      } finally {
        activeConnections.delete(callSid);
      }
    }

    // ── Twilio WebSocket event router ─────────────────────────
    ws.on('message', async (rawMsg) => {
      try {
        const msg = JSON.parse(rawMsg);
        switch (msg.event) {

          case 'connected':
            logger.debug('Twilio stream connected — waiting for start');
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

            logger.info('✅ Stream started — ElevenLabs STT+TTS active (no Deepgram)', {
              callSid,
              streamSid,
            });

            maxCallTimer = setTimeout(async () => {
              if (sessionEnded) return;
              await speakToUser(TIMEOUT_TEL);
              setTimeout(() => handleCallEnd('max_duration'), 3000);
            }, MAX_CALL_SECONDS * 1000);

            // Greet caller after 1200ms (let stream stabilise)
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
            if (msg.media?.payload) {
              const audioData = Buffer.from(msg.media.payload, 'base64');
              await onAudioFrame(audioData);
            }
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
      clearTimeout(idleTimer);
      clearTimeout(maxCallTimer);
      clearTimeout(vadTimer);
      await handleCallEnd('ws_closed');
    });

    ws.on('error', (err) => {
      logger.error('WebSocket error', { callSid, error: err.message });
    });
  });
}

module.exports = { setupStreamHandler };