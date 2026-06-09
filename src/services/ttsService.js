// src/services/ttsService.js
//
// ─── FIX HISTORY ───────────────────────────────────────────────────────────────
//  v1 bug : language_code='te' sent → HTTP 400 on every model → agent silent.
//  v2 bug : language_code='te' still sent with eleven_multilingual_v2 → same 400.
//  v3 fix : language_code REMOVED entirely. ElevenLabs auto-detects Telugu from
//           Unicode script. output_format moved to URL query param. ✅
//  v3 fix : output_format moved from body → URL query param (?output_format=ulaw_8000)
//  v4 fix : Quota-aware warmup — stops immediately on quota_exceeded instead of
//           burning all remaining credits on warmup phrases that will all fail.
//           Live calls also short-circuit with a clear actionable error.
// ───────────────────────────────────────────────────────────────────────────────

const logger = require('../utils/logger');

const audioCache = new Map();
const MAX_CACHE  = 80;

// 160 bytes = exactly 20 ms of µ-law at 8 000 Hz mono
// Twilio media-stream spec: send 20 ms frames
const CHUNK_SIZE = 160;

// NOTE: Used for logging/caching only — NOT sent to ElevenLabs.
// ElevenLabs rejects language_code='te' on all models; auto-detection handles it.
const LANG_CODE = { telugu: 'te', hindi: 'hi', english: 'en' };

// Phrases pre-cached on startup so first live call has zero TTS latency.
const WARMUP_PHRASES = [
  { text: 'నమస్తే సార్, నేను సిద్దిపేట బ్రాంచ్ నుంచి మాట్లాడుతున్నాను. మాది Lono Finance కంపెనీ సార్. మీరు ప్రస్తుతం ఏమైనా EMI కడుతున్నారా సార్?', lang: 'telugu' },
  { text: 'క్షమించండి సార్, మళ్ళీ చెప్పగలరా?',                                                                                                           lang: 'telugu' },
  { text: 'సరే సార్, మీ సమయానికి థాంక్యూ సార్. శుభదినం సార్.',                                                                                           lang: 'telugu' },
  { text: 'సార్, మీరు వింటున్నారా? మీకు ఏదైనా సహాయం చేయగలనా సార్?',                                                                                    lang: 'telugu' },
  { text: 'సార్, మీ సమయానికి థాంక్యూ సార్. మళ్ళీ కాల్ చేస్తాం సార్. శుభదినం.',                                                                         lang: 'telugu' },
];

// ─── Error classification helpers ─────────────────────────────────────────────
function isQuotaError(err) {
  return err && err.message && err.message.includes('quota_exceeded');
}

function parseQuotaDetails(errMessage) {
  try {
    const match = errMessage.match(/You have (\d+) credits remaining, while (\d+) credits are required/);
    if (match) return { remaining: parseInt(match[1]), required: parseInt(match[2]) };
  } catch (_) {}
  return null;
}

// ─── Core ElevenLabs call ──────────────────────────────────────────────────────
async function textToSpeechElevenLabs(text, language = 'telugu') {
  const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

  if (!process.env.ELEVENLABS_VOICE_ID) {
    logger.warn('ELEVENLABS_VOICE_ID not set — using default voice', { defaultVoiceId: voiceId });
  }

  // FIX v3: output_format is a URL query param — ElevenLabs ignores it in the body.
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`;

  const body = {
    text,
    // eleven_turbo_v2_5: fastest multilingual model — best for real-time voice.
    // Telugu auto-detected from Unicode script — no language_code parameter needed.
    model_id: 'eleven_turbo_v2_5',
    voice_settings: {
      stability:         0.50,
      similarity_boost:  0.85,
      style:             0.25,
      use_speaker_boost: true,
    },
    // NOTE: language_code intentionally absent.
    // ElevenLabs returns HTTP 400 for language_code='te' on ALL models.
  };

  logger.debug('ElevenLabs request', {
    voiceId,
    textLength:   text.length,
    language,
    model:        body.model_id,
    outputFormat: 'ulaw_8000 (query param)',
  });

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 8000);

  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set in environment');

    const response = await fetch(url, {
      method:  'POST',
      headers: {
        'xi-api-key':   apiKey,
        'Content-Type': 'application/json',
        'Accept':       'audio/basic',
      },
      body:   JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('ElevenLabs API error', {
        status: response.status,
        error:  errorText,
        voiceId,
        language,
        model:  body.model_id,
      });
      throw new Error(`ElevenLabs ${response.status}: ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      logger.error('ElevenLabs returned empty audio buffer', { voiceId, language, textLength: text.length });
      throw new Error('ElevenLabs returned empty audio buffer');
    }

    const buf = Buffer.from(arrayBuffer);
    logger.info('✅ ElevenLabs TTS success', {
      voiceId,
      language,
      textLength: text.length,
      audioBytes: buf.length,
      format:     'ulaw_8000',
    });
    return buf;

  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ─── Twilio frame chunker ──────────────────────────────────────────────────────
// Split µ-law buffer into 160-byte (20 ms) frames for Twilio media streams.
// CRITICAL: Twilio silently truncates large single-payload media messages.
// Sending the whole buffer as one chunk = only first ~0.5 s plays.
function chunkAudio(buffer) {
  const chunks = [];
  for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
    chunks.push(buffer.slice(i, i + CHUNK_SIZE));
  }
  logger.debug('chunkAudio converted buffer to frames', {
    bufferSize:         buffer.length,
    frameSize:          CHUNK_SIZE,
    chunkCount:         chunks.length,
    expectedDurationMs: chunks.length * 20,
  });
  return chunks;
}

// ─── Public TTS entry point ────────────────────────────────────────────────────
async function textToSpeech(text, language = 'telugu') {
  if (!text || !text.trim()) {
    logger.warn('textToSpeech called with empty text', { language });
    return null;
  }

  logger.info('textToSpeech called', {
    textLength: text.length,
    language,
    hasApiKey:  !!process.env.ELEVENLABS_API_KEY,
    voiceIdSet: !!process.env.ELEVENLABS_VOICE_ID,
  });

  const cacheKey = `ulaw_8000:${language}:${text.substring(0, 120)}`;
  if (audioCache.has(cacheKey)) {
    logger.info('✅ TTS cache hit', { language, chars: text.length, cacheSize: audioCache.size });
    return audioCache.get(cacheKey);
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    const errorMsg = 'ELEVENLABS_API_KEY not configured — ElevenLabs TTS is MANDATORY';
    logger.error('❌ ' + errorMsg, {
      language,
      textLength:      text.length,
      requiredEnvVars: ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'],
    });
    throw new Error(errorMsg);
  }

  try {
    logger.info('📤 Calling ElevenLabs API...', { language, textLength: text.length });
    const buf = await textToSpeechElevenLabs(text, language);

    if (audioCache.size >= MAX_CACHE) {
      const removed = audioCache.keys().next().value;
      audioCache.delete(removed);
      logger.debug('Cache evicted oldest entry', { cacheSize: audioCache.size });
    }
    audioCache.set(cacheKey, buf);
    logger.info('✅ TTS audio cached', { language, audioBytes: buf.length, cacheSize: audioCache.size });
    return buf;

  } catch (err) {
    // FIX v4: Quota errors get a clear actionable message — not a generic failure
    if (isQuotaError(err)) {
      const details = parseQuotaDetails(err.message);
      logger.error('🚨 ELEVENLABS QUOTA EXHAUSTED — TOP UP REQUIRED', {
        message:   'Go to elevenlabs.io → Billing → Top up credits',
        remaining: details?.remaining ?? 'unknown',
        required:  details?.required  ?? 'unknown',
        impact:    'ALL voice calls will be SILENT until credits are added',
      });
    } else {
      logger.error('❌ ElevenLabs TTS FAILED', {
        error:        err.message,
        language,
        textLength:   text.length,
        voiceId:      process.env.ELEVENLABS_VOICE_ID || 'not-set',
        apiKeyPrefix: process.env.ELEVENLABS_API_KEY
          ? process.env.ELEVENLABS_API_KEY.substring(0, 10)
          : 'not-set',
      });
    }
    throw err;
  }
}

// ─── Startup warmup ────────────────────────────────────────────────────────────
// FIX v4: Stops immediately on quota_exceeded — no point burning remaining
//         credits on warmup phrases that will all fail anyway.
async function warmupTTSCache() {
  if (!process.env.ELEVENLABS_API_KEY) {
    logger.error('❌ No ElevenLabs key — TTS warmup FAILED. Set ELEVENLABS_API_KEY in .env');
    return;
  }
  if (!process.env.ELEVENLABS_VOICE_ID) {
    logger.warn('⚠️  ELEVENLABS_VOICE_ID not set — using default voice for warmup');
  }

  logger.info(`🔥 Warming up TTS cache with ${WARMUP_PHRASES.length} phrases...`);
  let warmed = 0;
  let failed = 0;

  for (let i = 0; i < WARMUP_PHRASES.length; i++) {
    const phrase = WARMUP_PHRASES[i];
    try {
      logger.debug('Warmup TTS phrase', { lang: phrase.lang, textLength: phrase.text.length });
      const result = await textToSpeech(phrase.text, phrase.lang);
      if (result) {
        warmed++;
        logger.info(`✅ Warmed phrase ${i + 1}/${WARMUP_PHRASES.length}`, { lang: phrase.lang });
      }
    } catch (err) {
      failed++;
      // FIX v4: Quota exceeded → abort immediately, don't waste remaining credits
      if (isQuotaError(err)) {
        const details = parseQuotaDetails(err.message);
        logger.error('🚨 WARMUP ABORTED — ELEVENLABS QUOTA EXHAUSTED', {
          action:    '👉 Go to elevenlabs.io → Billing → Top up credits NOW',
          remaining: details?.remaining ?? 'unknown',
          impact:    'Agent will be SILENT on all calls. Warmup skipped to preserve credits.',
          phrasesAttempted: i + 1,
          phrasesSkipped:   WARMUP_PHRASES.length - (i + 1),
        });
        return; // Stop immediately — no point continuing
      }
      logger.error(`❌ Warmup phrase ${i + 1} failed`, { lang: phrase.lang, error: err.message });
    }
    if (i < WARMUP_PHRASES.length - 1) {
      await new Promise(r => setTimeout(r, 600));
    }
  }

  if (failed === 0) {
    logger.info('🎉 TTS cache warmup complete', { phrasesCached: warmed, failed: 0 });
  } else {
    logger.error('⚠️  TTS cache warmup INCOMPLETE', { phrasesCached: warmed, failed });
  }
}

module.exports = { textToSpeech, warmupTTSCache, chunkAudio, CHUNK_SIZE };