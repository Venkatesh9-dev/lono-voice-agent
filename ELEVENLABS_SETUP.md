# ElevenLabs Configuration & Troubleshooting

## Required Environment Variables

```env
ELEVENLABS_API_KEY=your_api_key_here
ELEVENLABS_VOICE_ID=your_voice_id_here
```

## Getting Your Voice ID (Creator Subscription)

1. Log in to [ElevenLabs Dashboard](https://elevenlabs.io/app/voice-lab)
2. Go to **Voice Lab** → **My Voices**
3. Click on your custom cloned voice
4. Copy the **Voice ID** (looks like: `21m00Tcm4TlvDq8ikWAM` or similar)
5. Set `ELEVENLABS_VOICE_ID` in your `.env` file

## Troubleshooting

### Issue: Audio stops after "dot lono finance" and silence follows

**Root Cause:** ElevenLabs TTS is failing, so the system falls back to Twilio's Polly.Aditi (low quality, muffled)

### Check Logs for These Messages:

```
❌ USING TWILIO FALLBACK (Polly.Aditi) - ElevenLabs failed or misconfigured
❌ ElevenLabs TTS failed — falling back to Twilio <Say>
❌ ElevenLabs API error
❌ ELEVENLABS_API_KEY not set in environment
```

If you see these, ElevenLabs is NOT working properly.

### Fix Checklist:

1. **Verify API Key is set:**
   ```bash
   # In .env file:
   ELEVENLABS_API_KEY=sk_xxx...  # Should NOT be empty, blank, or contain xxxxx
   ```

2. **Verify Voice ID is set and correct:**
   ```bash
   # In .env file:
   ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM  # Use your Creator voice ID
   ```

3. **Test API Key validity:**
   - Go to https://elevenlabs.io/app/account/subscription
   - Verify your API key is active
   - Check if Creator subscription is active

4. **Check logs for the actual error:**
   - Look for `ElevenLabs API error` in logs
   - Common errors:
     - `401` = Invalid API key
     - `404` = Voice ID doesn't exist
     - `422` = Invalid request format (shouldn't happen with this code)

5. **Verify network connectivity:**
   - Make sure your server can reach `api.elevenlabs.io`
   - Check firewall/proxy settings

## Expected Behavior

When ElevenLabs is working correctly, logs should show:
```
ElevenLabs request { voiceId, textLength, language, langCode, model, outputFormat }
ElevenLabs TTS success { voiceId, language, textLength, audioBytes, format: 'ulaw_8000' }
Audio sent chunked { chars, bytes, chunks, language }
```

## Model Selection

Currently using: `eleven_turbo_v2_5`
- ✅ Supports `ulaw_8000` output format natively
- ✅ Faster and cheaper than multilingual_v2
- ✅ Good for Telugu, Hindi, English
- ✅ Works with Creator subscription

**Do NOT use `eleven_multilingual_v2`** - it has limited `ulaw_8000` support and causes failures.

## Voice Settings

Current voice settings optimized for clear Telugu speech:
```javascript
stability:         0.50    // Moderate stability
similarity_boost:  0.85    // High voice similarity
style:             0.25    // Slight stylization
use_speaker_boost: true    // Enhanced speaker profile
```

If audio sounds unnatural, try adjusting `stability` and `similarity_boost` values.

## Quick Test

Add this to test ElevenLabs directly (requires API key + voice ID to be set):

```javascript
const { textToSpeech } = require('./src/services/ttsService');

// Test Telugu text
const result = await textToSpeech('నమస్తే సార్', 'telugu');
if (result && !result.isFallback) {
  console.log('✅ ElevenLabs working:', result.length, 'bytes');
} else {
  console.log('❌ ElevenLabs failed - using Polly fallback');
}
```

## Summary

**The clear audio you want requires:**
1. Valid `ELEVENLABS_API_KEY` in `.env`
2. Correct `ELEVENLABS_VOICE_ID` from your Creator voice
3. Proper network access to `api.elevenlabs.io`

Without these, the system **always** falls back to Polly.Aditi (muffled, low quality).
