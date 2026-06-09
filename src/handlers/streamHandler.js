// src/handlers/streamHandler.js
//
// MULTILINGUAL: Telugu (primary) + Hindi + English
// STT  — ElevenLabs Scribe, auto language detection (no language_code lock)
// TTS  — ElevenLabs, language matched to what the caller spoke
// LLM  — Claude responds in detected caller language
//
// Language detection:
//   Telugu  → Unicode U+0C00–U+0C7F dominant
//   Hindi   → Unicode U+0900–U+097F dominant
//   English → fallback
//
// Language is detected per utterance and stored in session.
// Greeting is always Telugu (outbound Telugu market), then adapts to caller.

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
// Start very low — we need the energy log below to calibrate for this phone line
const SILENCE_THRESHOLD_RMS = 50;  // raise if noise triggers false positives
const MIN_SPEECH_MS          = 200; // skip utterances shorter than this
const SILENCE_TO_END_MS      = 800; // silence duration to flush utterance

// ── BYE detection (all three languages) ──────────────────────
const BYE_PATTERNS = [
  // English
  'bye', 'goodbye', 'not interested', 'no thanks', 'stop calling',
  "that's all", 'no need',
  // Telugu
  'సరే సార్', 'థాంక్యూ', 'వద్దు', 'అక్కర్లేదు', 'సెలవు',
  'ఇప్పుడు వద్దు', 'వెళ్తాను',
  // Hindi
  'ठीक है', 'धन्यवाद', 'नहीं चाहिए', 'बाय', 'नहीं', 'छोड़िए',
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

// ── Language detection from transcript ───────────────────────
// Counts Unicode character blocks and picks the dominant script.
function detectLanguage(text) {
  const teluguChars = (text.match(/[\u0C00-\u0C7F]/g) || []).length;
  const hindiChars  = (text.match(/[\u0900-\u097F]/g) || []).length;
  const total       = text.replace(/\s+/g, '').length || 1;

  const teluguRatio = teluguChars / total;
  const hindiRatio  = hindiChars  / total;

  if (teluguRatio > 0.25) return 'telugu';
  if (hindiRatio  > 0.25) return 'hindi';
  return 'english';
}

// ── Per-language agent messages ───────────────────────────────
const MESSAGES = {
  telugu: {
    goodbye: 'సరే సార్, మీ సమయానికి థాంక్యూ సార్. ఫ్యూచర్‌లో అవసరం అయితే మాకు కాల్ చేయండి సార్. శుభదినం సార్.',
    timeout: 'సార్, మీ సమయానికి థాంక్యూ సార్. మళ్ళీ కాల్ చేస్తాం సార్. శుభదినం.',
    idle:    'సార్, మీరు వింటున్నారా? మీకు ఏదైనా సహాయం చేయగలనా సార్?',
  },
  hindi: {
    goodbye: 'ठीक है सर, आपके समय के लिए धन्यवाद। भविष्य में जरूरत हो तो हमें कॉल करें। शुभ दिन सर।',
    timeout: 'सर, आपके समय के लिए धन्यवाद। हम फिर कॉल करेंगे। शुभ दिन।',
    idle:    'सर, क्या आप सुन रहे हैं? क्या मैं आपकी कोई मदद कर सकता हूँ?',
  },
  english: {
    goodbye: 'Okay sir, thank you for your time. Please call us if you need anything in the future. Have a good day sir.',
    timeout: 'Sir, thank you for your time. We will call again. Have a good day.',
    idle:    'Sir, are you there? Can I help you with anything?',
  },
};

// Greeting is always Telugu — outbound agent targets Telugu market
const GREETING = 'నమస్తే సార్, నేను సిద్దిపేట బ్రాంచ్ నుంచి మాట్లాడుతున్నాను. మాది Lono Finance కంపెనీ సార్. మీరు ప్రస్తుతం ఏమైనా EMI కడుతున్నారా సార్?';

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
  for (const byte of buf) { const s = ulawToLinear(byte); sum += s * s; }
  return Math.sqrt(sum / buf.length);
}

// ── µ-law buffer → WAV buffer (16-bit PCM, 8 kHz mono) ───────
function buildWav(ulawBuf) {
  const sampleRate    = 8000;
  const numChannels   = 1;
  const bitsPerSample = 16;
  const byteRate      = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign    = numChannels * bitsPerSample / 8;
  const dataSize      = ulawBuf.length * 2;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
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

// ── ElevenLabs Scribe STT — NO language_code lock ─────────────
// Auto-detect language so Telugu, Hindi, and English all work correctly.
async function elevenLabsSTT(ulawBuf) {
  const wavBuf   = buildWav(ulawBuf);
  const boundary = 'EL' + Date.now().toString(36);

  const parts = [
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`
    ),
    wavBuf,
    Buffer.from('\r\n'),
    // model
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model_id"\r\n\r\nscribe_v1\r\n`
    ),
    // NO language_code — auto-detection handles Telugu/Hindi/English
    Buffer.from(`--${boundary}--\r\n`),
  ];

  const body       = Buffer.concat(parts);
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 10000);

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

// ─────────────────────────────────────────────────────────────
function setupStreamHandler(wss) {
  wss.on('connection', (ws) => {
    logger.info('New WebSocket connection');

    let callSid        = null;
    let streamSid      = null;
    let callerPhone    = null;
    let sessionEnded   = false;
    let isProcessing   = false;
    let idleTimer      = null;
    let maxCallTimer   = null;
    let currentLang    = 'telugu'; // tracks caller's language; updates per utterance

    // VAD state
    let speechChunks   = [];
    let speechStart    = 0;
    let isSpeaking     = false;
    let vadTimer       = null;

    // Diagnostic: track frame count and peak energy seen
    let frameCount   = 0;
    let peakEnergy   = 0;

    // ── Idle timer ────────────────────────────────────────────
    function resetIdleTimer() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(async () => {
        if (sessionEnded) return;
        const session = await sessionManager.getSession(callSid);
        if (!session) return;
        const msgs = MESSAGES[currentLang] || MESSAGES.telugu;
        if ((session.idleWarningsSent || 0) === 0) {
          await sessionManager.updateSession(callSid, { idleWarningsSent: 1 });
          await speakToUser(msgs.idle, currentLang);
          resetIdleTimer();
        } else {
          await speakToUser(msgs.timeout, currentLang);
          setTimeout(() => handleCallEnd('idle_timeout'), 3000);
        }
      }, IDLE_TIMEOUT_MS);
    }

    // ── VAD: receive one 20 ms µ-law frame ────────────────────
    async function onAudioFrame(audioData) {
      frameCount++;
      const energy = getRmsEnergy(audioData);

      // Track peak energy
      if (energy > peakEnergy) peakEnergy = energy;

      // DIAGNOSTIC: log energy every 200 frames (~4 seconds)
      // Use this to calibrate SILENCE_THRESHOLD_RMS for this phone line
      if (frameCount % 200 === 0) {
        logger.info('🔊 Audio energy sample', {
          callSid,
          currentEnergy: Math.round(energy),
          peakEnergy:    Math.round(peakEnergy),
          threshold:     SILENCE_THRESHOLD_RMS,
          isSpeaking,
          isProcessing,
          frames:        frameCount,
        });
      }

      if (isProcessing || sessionEnded) return;

      const energy = getRmsEnergy(audioData);

      if (energy > SILENCE_THRESHOLD_RMS) {
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
        speechChunks.push(Buffer.from(audioData));
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
            callSid, ms: duration, bytes: buf.length,
          });
          await transcribeAndProcess(buf);
        }, SILENCE_TO_END_MS);
      }
    }

    // ── STT → language detect → Claude → TTS ─────────────────
    async function transcribeAndProcess(ulawBuf) {
      if (isProcessing || sessionEnded) return;
      isProcessing = true;
      try {
        logger.info('📤 Calling ElevenLabs STT (auto-detect language)...', {
          callSid, bytes: ulawBuf.length,
        });

        const raw = await elevenLabsSTT(ulawBuf);

        if (!raw || raw.length < MIN_TRANSCRIPT) {
          logger.warn('⚠️  Empty or too short transcript', { callSid, raw });
          return;
        }

        const transcript = sanitize(raw);

        // Detect language and update session
        const detectedLang = detectLanguage(transcript);
        if (detectedLang !== currentLang) {
          logger.info(`🌐 Language switched: ${currentLang} → ${detectedLang}`, {
            callSid, transcript,
          });
          currentLang = detectedLang;
          await sessionManager.updateSession(callSid, { language: detectedLang });
        }

        logger.info('✅ STT transcript', {
          callSid,
          transcript,
          detectedLang,
        });

        await processUserInput(transcript, detectedLang);

      } catch (err) {
        logger.error('❌ STT error', { callSid, error: err.message });
      } finally {
        isProcessing = false;
      }
    }

    // ── Transcript → LLM → speak ──────────────────────────────
    async function processUserInput(transcript, lang) {
      if (sessionEnded) return;
      const msgs = MESSAGES[lang] || MESSAGES.telugu;

      try {
        logger.info('📥 Processing user input', { callSid, transcript, lang });

        if (detectBye(transcript)) {
          await speakToUser(msgs.goodbye, lang);
          await sessionManager.incrementMetric('calls_completed');
          setTimeout(() => handleCallEnd('caller_ended'), 3500);
          return;
        }

        const session = await sessionManager.getSession(callSid);
        if (!session) return;

        await sessionManager.addMessage(callSid, 'user', transcript);

        logger.info('🤖 Calling Claude...', { callSid, lang });
        const aiResult = await getAIResponse(session, transcript);
        logger.info('✅ Claude response', {
          callSid, length: aiResult.text.length, lang,
        });

        await sessionManager.addMessage(callSid, 'assistant', aiResult.text);

        if (aiResult.leadData) {
          await sessionManager.updateSession(callSid, {
            leadData: { ...(session.leadData || {}), ...aiResult.leadData },
          });
          await sessionManager.incrementMetric('leads_captured');
          logger.info('👤 Lead captured', { callSid, leadData: aiResult.leadData });
        }

        if (aiResult.status === 'not_interested') {
          await sessionManager.incrementMetric('not_interested');
          await sessionManager.updateSession(callSid, { outcome: 'not_interested' });
        }

        if (aiResult.transfer && process.env.ENABLE_HUMAN_TRANSFER === 'true') {
          await speakToUser(aiResult.text, lang);
          await handleTransfer();
          return;
        }

        // Respond in detected language
        await speakToUser(aiResult.text, lang);

        if (detectBye(aiResult.text)) {
          setTimeout(() => handleCallEnd('agent_ended'), 4000);
        }

      } catch (err) {
        logger.error('❌ processUserInput error', { callSid, error: err.message });
      }
    }

    // ── TTS → Twilio audio frames ─────────────────────────────
    // lang: 'telugu' | 'hindi' | 'english' — matched to caller's detected language
    async function speakToUser(text, lang = 'telugu') {
      if (!text || !streamSid || sessionEnded) {
        logger.warn('⚠️  speakToUser skipped', {
          callSid, hasText: !!text, hasStreamSid: !!streamSid, sessionEnded,
        });
        return;
      }
      try {
        logger.info('🎤 Speaking to user', { callSid, lang, textLength: text.length });
        const buf = await textToSpeech(text, lang);
        if (!buf) return;

        if (ws.readyState !== WebSocket.OPEN) return;

        const chunks = chunkAudio(buf);
        logger.info(`📤 Sending ${chunks.length} audio frames`, {
          callSid, lang, bytes: buf.length,
        });

        for (const chunk of chunks) {
          if (ws.readyState !== WebSocket.OPEN || sessionEnded) break;
          ws.send(JSON.stringify({
            event:    'media',
            streamSid,
            media: { payload: chunk.toString('base64') },
          }));
          await sleep(20); // 8 kHz µ-law = 160 bytes per 20 ms
        }

        logger.info('✅ Audio sent', { callSid, lang, textLength: text.length });
      } catch (err) {
        logger.error('❌ speakToUser error', { callSid, lang, error: err.message });
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
        await twilioRest.calls(callSid).update({
          twiml: '<Response><Hangup/></Response>',
        });
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

            logger.info('✅ Stream started — ElevenLabs STT+TTS (multilingual)', {
              callSid, streamSid,
            });

            maxCallTimer = setTimeout(async () => {
              if (sessionEnded) return;
              const msgs = MESSAGES[currentLang] || MESSAGES.telugu;
              await speakToUser(msgs.timeout, currentLang);
              setTimeout(() => handleCallEnd('max_duration'), 3000);
            }, MAX_CALL_SECONDS * 1000);

            // Greet in Telugu after 1200ms
            setTimeout(async () => {
              try {
                await speakToUser(GREETING, 'telugu');
                await sessionManager.addMessage(callSid, 'assistant', GREETING);
                setTimeout(() => resetIdleTimer(), 500);
              } catch (err) {
                logger.error('Greeting error', { error: err.message });
              }
            }, 1200);
            break;

          case 'media':
            if (msg.media?.payload) {
              await onAudioFrame(Buffer.from(msg.media.payload, 'base64'));
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