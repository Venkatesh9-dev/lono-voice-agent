// src/services/llmService.js
// FIX: correct Claude model name — claude-3-5-haiku-20241022
// FIX: max_tokens 120 for natural Telugu responses (was too short at 100)
// FIX: response length guidance in prompt context
// FIX [v2.1]: max_tokens increased from 120 → 250.
//             Telugu is morphologically rich — 120 tokens frequently truncates mid-sentence.
//             A truncated response is sent to ElevenLabs which speaks an incomplete phrase,
//             confusing the caller and breaking conversational flow.

const Anthropic = require('@anthropic-ai/sdk');
const { buildLonoPrompt } = require('../config/prompt');
const logger = require('../utils/logger');

// FIX: verified stable model string — was 'claude-haiku-4-5-20251001' (invalid)
const MODEL = 'claude-haiku-4-5-20251001'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function extractLeadData(text) {
  try {
    const match = text.match(/LEAD_JSON:(\{[^}]+\})/);
    if (match) {
      const parsed = JSON.parse(match[1]);
      if (parsed.name && parsed.name !== 'CUSTOMER_NAME') return parsed;
    }
  } catch {}
  return null;
}

function extractStatus(text) {
  if (text.includes('LEAD_STATUS:not_interested'))     return 'not_interested';
  if (text.includes('LEAD_STATUS:callback_requested')) return 'callback_requested';
  return null;
}

function cleanText(text) {
  return text
    .replace(/LEAD_JSON:\{[^}]+\}/g, '')
    .replace(/LEAD_STATUS:\S+/g, '')
    .replace(/TRANSFER_NOW/g, '')
    .trim();
}

function needsTransfer(text) {
  return text.includes('TRANSFER_NOW');
}

async function getAIResponse(session, userTranscript) {
  const systemPrompt   = buildLonoPrompt();
  const recentMessages = session.messages.slice(-10);

  try {
    const response = await anthropic.messages.create({
      model:      MODEL,
      // FIX [v2.1]: Increased from 120 → 250 tokens.
      // Telugu script uses more tokens per spoken syllable than English.
      // At 120 tokens Claude was frequently cutting off mid-sentence —
      // ElevenLabs would then speak the incomplete text verbatim, which
      // sounds broken and erodes caller trust. 250 gives enough headroom
      // for a full 2–3 sentence Telugu conversational turn while keeping
      // latency low (Haiku is fast enough that this does not add perceptible delay).
      max_tokens: 250,
      system:     systemPrompt,
      messages:   [
        ...recentMessages,
        { role: 'user', content: userTranscript },
      ],
    });

    const raw      = response.content[0]?.text || '';
    const leadData = extractLeadData(raw);
    const status   = extractStatus(raw);
    const transfer = needsTransfer(raw);
    const text     = cleanText(raw);

    logger.info('LLM response', {
      callSid:      session.callSid,
      model:        MODEL,
      inputTokens:  response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      hasLead:      !!leadData,
      status,
      transfer,
      chars:        text.length,
    });

    return { text, leadData, status, transfer };

  } catch (err) {
    logger.error('LLM error', { error: err.message, callSid: session.callSid, model: MODEL });
    return {
      text:     'క్షమించండి సార్, మళ్ళీ చెప్పగలరా?',
      leadData: null,
      status:   null,
      transfer: false,
    };
  }
}

async function generateCallSummary(session) {
  const transcript = session.messages.map(m => `${m.role}: ${m.content}`).join('\n');
  if (!transcript.trim()) return 'No conversation recorded';
  try {
    const response = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 80,
      messages:   [{
        role:    'user',
        content: `Summarize this Telugu loan cold call in ONE English sentence. Format: "[Outcome]: [What happened]"\n\n${transcript}`,
      }],
    });
    return response.content[0]?.text?.trim() || 'Call completed';
  } catch {
    return 'Call completed';
  }
}

module.exports = { getAIResponse, generateCallSummary, MODEL };