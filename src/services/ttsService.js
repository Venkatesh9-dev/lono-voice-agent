// src/services/ttsService.js
// FIX CRITICAL: ElevenLabs must return ulaw_8000 format for Twilio Media Streams
// Twilio Media Streams ONLY accepts mulaw 8kHz audio — NOT MP3
// Previous code requested audio/mpeg which Twilio cannot decode = silence
// FIX: output_format set to 'ulaw_8000' — Twilio plays it perfectly
// FIX: Accept header changed to 'audio/basic' (mulaw mime type)
// FIX: timeout reduced to 5s — fail fast to fallback
// FIX: startup cache warmup for common Telugu phrases

const logger = require('../utils/logger');

const audioCache = new Map();
const MAX_CACHE  = 80;

// Common Telugu phrases — pre-cached at startup for zero-latency responses
const WARMUP_PHRASES = [
  { text: 'నమస్తే సార్, నేను సిద్దిపేట బ్రాంచ్ నుంచి మాట్లాడుతున్నాను. మాది Lono Finance కంపెనీ సార్. మీరు ప్రస్తుతం ఏమైనా EMI కడుతున్నారా సార్?', lang: 'telugu' },
  { text: 'క్షమించండి సార్, మళ్ళీ చెప్పగలరా?', lang: 'telugu' },
  { text: 'సరే సార్, మీ సమయానికి థాంక్యూ సార్. ఫ్యూచర్‌లో అవసరం అయితే మాకు కాల్ చేయండి సార్. శుభదినం సార్.', lang: 'telugu' },
  { text: 'సార్, మీరు వింటున్నారా? మీకు ఏదైనా సహాయం చేయగలనా సార్?', lang: 'telugu' },
  { text: 'సార్, మీ సమయానికి థాంక్యూ సార్. మళ్ళీ కాల్ చేస్తాం సార్. శుభదినం.', lang: 'telugu' },
];

const LANG_CODE = { telugu: 'te', hindi: 'hi', english: 'en' };

async function textToSpeechElevenLabs(text, language = 'telugu') {
  const voiceId  = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  const langCode = LANG_CODE[language] || 'te';

  const body = {
    text,
    model_id: 'eleven_multilingual_v2',
    voice_settings: {
      stability:         0.45,
      similarity_boost:  0.85,
      style:             0.30,
      use_speaker_boost: true,
    },
    language_code: langCode,
    // CRITICAL FIX: must be ulaw_8000 for Twilio Media Streams
    // MP3 (audio/mpeg) cannot be decoded by Twilio's media stream pipeline
    // ulaw_8000 = mulaw codec at 8kHz — exactly what Twilio expects
    output_format: 'ulaw_8000',
  };

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method:  'POST',
        headers: {
          'xi-api-key':   process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          // FIX: Accept mulaw audio — was 'audio/mpeg' (MP3) which Twilio cannot play
          'Accept': 'audio/basic',
        },
        body:   JSON.stringify(body),
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`ElevenLabs ${response.status}: ${errText}`);
    }

    const buf = Buffer.from(await response.arrayBuffer());
    logger.debug('ElevenLabs TTS success', {
      language,
      chars:  text.length,
      bytes:  buf.length,
      format: 'ulaw_8000',
    });
    return buf;

  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// Twilio fallback — only used if ElevenLabs fails completely
// Returns a marker object — streamHandler handles it via REST <Say>
function makeTwilioFallback(text, language) {
  return {
    isFallback: true,
    text,
    voice:    'Polly.Aditi',
    // Twilio Polly has no native Telugu voice — English is the only safe fallback
    langCode: language === 'hindi' ? 'hi-IN' : 'en-IN',
  };
}

async function textToSpeech(text, language = 'telugu') {
  if (!text || !text.trim()) return null;

  const cacheKey = `${language}:${text.substring(0, 120)}`;
  if (audioCache.has(cacheKey)) {
    logger.debug('TTS cache hit', { language, chars: text.length });
    return audioCache.get(cacheKey);
  }

  if (process.env.ELEVENLABS_API_KEY) {
    try {
      const buf = await textToSpeechElevenLabs(text, language);

      // Cache management
      if (audioCache.size >= MAX_CACHE) {
        audioCache.delete(audioCache.keys().next().value);
      }
      audioCache.set(cacheKey, buf);

      return buf;
    } catch (err) {
      logger.warn('ElevenLabs failed — using Twilio fallback', { error: err.message });
    }
  }

  // Fallback — ElevenLabs unavailable
  return makeTwilioFallback(text, language);
}

// Pre-warm cache on startup — common phrases serve from memory instantly
async function warmupTTSCache() {
  if (!process.env.ELEVENLABS_API_KEY) {
    logger.warn('ElevenLabs key not set — skipping TTS warmup');
    return;
  }

  logger.info('Warming up TTS cache with common Telugu phrases...');
  let warmed = 0;

  for (const phrase of WARMUP_PHRASES) {
    try {
      await textToSpeech(phrase.text, phrase.lang);
      warmed++;
      await new Promise(r => setTimeout(r, 600)); // small delay between calls
    } catch (err) {
      logger.warn('TTS warmup failed for phrase', { error: err.message });
    }
  }

  logger.info(`TTS cache ready`, { phrasesCached: warmed });
}

module.exports = { textToSpeech, warmupTTSCache };