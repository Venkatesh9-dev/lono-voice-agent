// src/services/ttsService.js
// FIX CRITICAL: output_format=ulaw_8000 moved to request BODY (not URL param)
// FIX CRITICAL: chunkAudio() is now actually used — see streamHandler.js
// FIX: eleven_turbo_v2_5 used (supports ulaw_8000 natively + faster + cheaper)
// FIX: cache key includes format to prevent stale format collisions
// FIX: warmup phrases cached correctly with new format

const logger = require('../utils/logger');

const audioCache = new Map();
const MAX_CACHE  = 80;

// 160 bytes = exactly 20ms of mulaw at 8000Hz mono
// Twilio media stream spec: send 20ms frames
const CHUNK_SIZE = 160;

const LANG_CODE = { telugu: 'te', hindi: 'hi', english: 'en' };

const WARMUP_PHRASES = [
  { text: 'నమస్తే సార్, నేను సిద్దిపేట బ్రాంచ్ నుంచి మాట్లాడుతున్నాను. మాది Lono Finance కంపెనీ సార్. మీరు ప్రస్తుతం ఏమైనా EMI కడుతున్నారా సార్?', lang: 'telugu' },
  { text: 'క్షమించండి సార్, మళ్ళీ చెప్పగలరా?', lang: 'telugu' },
  { text: 'సరే సార్, మీ సమయానికి థాంక్యూ సార్. శుభదినం సార్.', lang: 'telugu' },
  { text: 'సార్, మీరు వింటున్నారా? మీకు ఏదైనా సహాయం చేయగలనా సార్?', lang: 'telugu' },
  { text: 'సార్, మీ సమయానికి థాంక్యూ సార్. మళ్ళీ కాల్ చేస్తాం సార్. శుభదినం.', lang: 'telugu' },
];

async function textToSpeechElevenLabs(text, language = 'telugu') {
  const voiceId  = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  const langCode = LANG_CODE[language] || 'te';

  if (!process.env.ELEVENLABS_VOICE_ID) {
    logger.warn('ELEVENLABS_VOICE_ID not set — using default voice', { defaultVoiceId: voiceId });
  }

  const body = {
    text,
    // FIX: eleven_turbo_v2_5 — fully supports ulaw_8000, faster, cheaper than multilingual_v2
    // eleven_multilingual_v2 has limited output format support — caused 422 errors
    model_id: 'eleven_turbo_v2_5',
    voice_settings: {
      stability:         0.50,
      similarity_boost:  0.85,
      style:             0.25,
      use_speaker_boost: true,
    },
    language_code: langCode,
    // FIX CRITICAL: output_format in BODY not URL query param
    // ElevenLabs /stream endpoint reads this from request body
    // URL query param is silently ignored — was causing MP3 response = silence in Twilio
    output_format: 'ulaw_8000',
  };

  // FIX: use /stream endpoint (not /text-to-speech/{id}) — streams faster
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
  logger.debug('ElevenLabs request', {
    voiceId,
    textLength: text.length,
    language,
    langCode,
    model: body.model_id,
    outputFormat: body.output_format,
  });

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 5000);

  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error('ELEVENLABS_API_KEY not set in environment');
    }

    const response = await fetch(url, {
      method:  'POST',
      headers: {
        'xi-api-key':   apiKey,
        'Content-Type': 'application/json',
        'Accept':       'audio/basic', // mulaw MIME type
      },
      body:   JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      const errMsg = `ElevenLabs ${response.status}: ${errorText}`;
      logger.error('ElevenLabs API error', {
        status: response.status,
        error: errorText,
        voiceId,
        language,
        model: body.model_id,
      });
      throw new Error(errMsg);
    }

    const arrayBuffer = await response.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      logger.error('ElevenLabs returned empty audio buffer', {
        voiceId,
        language,
        textLength: text.length,
      });
      throw new Error('ElevenLabs returned empty audio buffer');
    }

    const buf = Buffer.from(arrayBuffer);
    logger.info('ElevenLabs TTS success', {
      voiceId,
      language,
      textLength: text.length,
      audioBytes: buf.length,
      format: 'ulaw_8000',
    });
    return buf;

  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// Split mulaw buffer into 160-byte (20ms) frames for Twilio
// CRITICAL: Twilio silently truncates large single-payload media messages
// Sending the whole buffer as one chunk = only first ~0.5s plays
function chunkAudio(buffer) {
  const chunks = [];
  for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
    chunks.push(buffer.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
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

  // FIX: cache key includes format — prevents stale format collisions
  const cacheKey = `ulaw_8000:${language}:${text.substring(0, 120)}`;
  if (audioCache.has(cacheKey)) {
    logger.debug('TTS cache hit', { language, chars: text.length });
    return audioCache.get(cacheKey);
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    logger.warn('ELEVENLABS_API_KEY not configured — using Twilio fallback', {
      language,
      textLength: text.length,
    });
    return makeTwilioFallback(text, language);
  }

  try {
    const buf = await textToSpeechElevenLabs(text, language);
    if (audioCache.size >= MAX_CACHE) audioCache.delete(audioCache.keys().next().value);
    audioCache.set(cacheKey, buf);
    return buf;
  } catch (err) {
    logger.error('ElevenLabs TTS failed — falling back to Twilio <Say>', {
      error: err.message,
      language,
      textLength: text.length,
      voiceId: process.env.ELEVENLABS_VOICE_ID || 'default',
    });
    return makeTwilioFallback(text, language);
  }
}

async function warmupTTSCache() {
  if (!process.env.ELEVENLABS_API_KEY) {
    logger.warn('No ElevenLabs key — skipping TTS warmup');
    return;
  }
  logger.info('Warming up TTS cache...');
  let warmed = 0;
  for (const phrase of WARMUP_PHRASES) {
    try {
      await textToSpeech(phrase.text, phrase.lang);
      warmed++;
      await new Promise(r => setTimeout(r, 600));
    } catch (err) {
      logger.warn('TTS warmup failed', { error: err.message });
    }
  }
  logger.info('TTS cache ready', { phrasesCached: warmed });
}

module.exports = { textToSpeech, warmupTTSCache, chunkAudio, CHUNK_SIZE };