// src/services/ttsService.js
// FIX: reduced timeout 8s → 5s
// FIX: startup cache warmup for common Telugu phrases (serves from memory <1ms)
// FIX: language_code correctly mapped
// FIX [v2.1]: ElevenLabs output_format=ulaw_8000 — returns mulaw directly, no transcoding needed
// FIX [v2.1]: LANG_CODE Telugu was 'en', now correctly 'te'

const logger = require('../utils/logger');

const audioCache = new Map();
const MAX_CACHE  = 80;

// FIX: common phrases pre-cached at startup — zero ElevenLabs latency for these
const WARMUP_PHRASES = [
  { text: 'నమస్తే సార్, నేను సిద్దిపేట బ్రాంచ్ నుంచి మాట్లాడుతున్నాను. మాది Lono Finance కంపెనీ సార్. మీరు ప్రస్తుతం ఏమైనా EMI కడుతున్నారా సార్?', lang: 'telugu' },
  { text: 'క్షమించండి సార్, మళ్ళీ చెప్పగలరా?', lang: 'telugu' },
  { text: 'సరే సార్, మీ సమయానికి థాంక్యూ సార్. ఫ్యూచర్‌లో అవసరం అయితే మాకు కాల్ చేయండి సార్. శుభదినం సార్.', lang: 'telugu' },
  { text: 'సార్, మీరు వింటున్నారా? మీకు ఏదైనా సహాయం చేయగలనా సార్?', lang: 'telugu' },
  { text: 'సార్, మీ సమయానికి థాంక్యూ సార్. మళ్ళీ కాల్ చేస్తాం సార్. శుభదినం.', lang: 'telugu' },
];

// FIX [v2.1]: Telugu was incorrectly mapped to 'en' — now correctly 'te'
// ElevenLabs eleven_multilingual_v2 uses ISO 639-1 language codes
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
  };

  // FIX [v2.1]: Request mulaw 8kHz directly from ElevenLabs via output_format query param.
  // Twilio Media Streams require mulaw 8kHz — ElevenLabs supports this natively.
  // Previously we sent raw MP3 bytes which Twilio cannot decode, causing silence/static.
  // No transcoding library needed — the returned buffer is ready to base64 and send.
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`;

  // FIX: reduced from 8s to 5s — fail fast, don't keep caller waiting
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method:  'POST',
      headers: {
        'xi-api-key':   process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        // FIX [v2.1]: Accept audio/basic (mulaw) instead of audio/mpeg (mp3)
        'Accept':       'audio/basic',
      },
      body:   JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`ElevenLabs ${response.status}: ${err}`);
    }

    // Returned buffer is raw mulaw 8kHz — send directly to Twilio, no conversion needed
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

function makeTwilioFallback(text, language) {
  return {
    isFallback: true,
    text,
    voice:    'Polly.Aditi',
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
      if (audioCache.size >= MAX_CACHE) audioCache.delete(audioCache.keys().next().value);
      audioCache.set(cacheKey, buf);
      logger.debug('TTS via ElevenLabs', { language, chars: text.length, bytes: buf.length });
      return buf;
    } catch (err) {
      logger.warn('ElevenLabs failed — Twilio fallback', { error: err.message });
    }
  }

  return makeTwilioFallback(text, language);
}

// FIX: pre-warm cache at server startup for common phrases
async function warmupTTSCache() {
  if (!process.env.ELEVENLABS_API_KEY) return;
  logger.info('Warming up TTS cache...');
  let warmed = 0;
  for (const phrase of WARMUP_PHRASES) {
    try {
      await textToSpeech(phrase.text, phrase.lang);
      warmed++;
      await new Promise(r => setTimeout(r, 500)); // small delay between warmup calls
    } catch (err) {
      logger.warn('TTS warmup failed for phrase', { error: err.message });
    }
  }
  logger.info(`TTS cache warmed up`, { phrases: warmed });
}

module.exports = { textToSpeech, warmupTTSCache };