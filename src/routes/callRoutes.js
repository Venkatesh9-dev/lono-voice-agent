// src/routes/callRoutes.js
// FIX CRITICAL: <Start><Stream> → <Connect><Stream> in /answered and /incoming
//               <Start><Stream> is receive-only — Twilio silently drops all
//               audio injected back via WebSocket. Agent spoke but caller heard
//               nothing. <Connect><Stream> enables full bidirectional audio.
// FIX CRITICAL: /answered WebSocket URL now uses req.headers.host (not BASE_URL)
// FIX HIGH: /answered now has validateTwilio middleware — was open to anyone

const express = require('express');
const twilio  = require('twilio');
const { sendMissedCallAlert } = require('../services/notificationService');
const {
  enqueueRetry,
  getRetryCount,
  incrementRetryCount,
  getMetrics,
  incrementMetric,
} = require('../services/sessionManager');
const logger = require('../utils/logger');

const router = express.Router();

// ── Twilio signature validation ───────────────────────────────
function validateTwilio(req, res, next) {
  if (process.env.NODE_ENV !== 'production') {
    logger.debug('✅ Skipping Twilio signature validation (development mode)');
    return next();
  }

  const signature = req.headers['x-twilio-signature'] || '';
  const url       = `${process.env.BASE_URL}${req.originalUrl}`;

  logger.debug('🔐 Validating Twilio signature', { url, signaturePresent: !!signature });

  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );

  if (!isValid) {
    logger.error('🚨 SECURITY: Invalid Twilio signature detected', {
      url,
      ip: req.ip,
      signature: signature.substring(0, 20) + '...',
    });
    return res.status(403).send('Forbidden');
  }
  logger.debug('✅ Twilio signature valid');
  next();
}

// ── POST /call/answered — outbound call connected ─────────────
// FIX CRITICAL: <Connect><Stream> replaces <Start><Stream>
// <Start><Stream> = non-blocking, receive-only — injected audio is DROPPED
// <Connect><Stream> = blocking, bidirectional — agent CAN speak to caller
router.post('/answered', validateTwilio, (req, res) => {
  const callSid     = req.body.CallSid || 'unknown';
  const callerPhone = req.body.To      || 'unknown';

  logger.info('📞 Outbound call answered - connecting to WebSocket stream', {
    callSid,
    callerPhone: '***' + String(callerPhone).slice(-4),
  });

  const twiml   = new twilio.twiml.VoiceResponse();
  // FIX: connect() not start() — bidirectional audio requires <Connect><Stream>
  const connect = twiml.connect();
  const stream  = connect.stream({
    // FIX: use req.headers.host — always correct regardless of BASE_URL format
    url: `wss://${req.headers.host}/call/stream`,
  });
  stream.parameter({ name: 'callerPhone', value: callerPhone });
  stream.parameter({ name: 'callSid',     value: callSid });
  // NOTE: No twiml.pause() needed — <Connect> is blocking; call stays alive
  // until the WebSocket closes or handleCallEnd() sends <Hangup>

  res.type('text/xml').send(twiml.toString());
});

// ── POST /call/incoming — inbound (for testing / demo) ────────
// FIX CRITICAL: same <Connect><Stream> fix applied here
router.post('/incoming', validateTwilio, (req, res) => {
  const callSid     = req.body.CallSid || 'unknown';
  const callerPhone = req.body.From    || 'unknown';

  logger.info('📱 Inbound call - connecting to WebSocket stream', {
    callSid,
    callerPhone: '***' + String(callerPhone).slice(-4),
  });

  const twiml   = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  const stream  = connect.stream({
    url: `wss://${req.headers.host}/call/stream`,
  });
  stream.parameter({ name: 'callerPhone', value: callerPhone });
  stream.parameter({ name: 'callSid',     value: callSid });

  res.type('text/xml').send(twiml.toString());
});

// ── POST /call/voicemail — answering machine detected ─────────
router.post('/voicemail', validateTwilio, async (req, res) => {
  const { CallSid, AnsweredBy } = req.body;

  logger.warn('🤖 Answering machine detected', { CallSid, AnsweredBy });
  await incrementMetric('voicemails');

  if (process.env.ENABLE_VOICEMAIL_MESSAGE !== 'true') {
    logger.debug('⚠️  Voicemail message disabled - hanging up', { CallSid });
    return res.type('text/xml').send('<Response><Hangup/></Response>');
  }

  const callbackNumber = process.env.LONO_CALLBACK_NUMBER || process.env.TWILIO_PHONE_NUMBER;

  logger.info('📞 Playing voicemail message with callback number', { callbackNumber });
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { voice: 'Polly.Aditi', language: 'en-IN' },
    `Hello, this is a call from Lono Finance. We have important information about your loan EMI. Please call us back at ${callbackNumber}. Thank you.`
  );
  twiml.hangup();

  res.type('text/xml').send(twiml.toString());
});

// ── POST /call/status — Twilio status callbacks ───────────────
router.post('/status', validateTwilio, async (req, res) => {
  const { CallSid, CallStatus, To, AnsweredBy, CallDuration } = req.body;

  logger.info('📊 Call status update', {
    CallSid,
    CallStatus,
    callerPhone: '***' + String(To).slice(-4),
    duration:   CallDuration,
    answeredBy: AnsweredBy,
  });

  if (CallStatus === 'answered') {
    logger.info('✅ Call answered - incrementing metric', { CallSid });
    await incrementMetric('calls_answered');
  }

  if (['no-answer', 'busy', 'failed'].includes(CallStatus) && To) {
    logger.warn(`⚠️  Call ${CallStatus} - checking retry policy`, {
      CallSid,
      callerPhone: '***' + String(To).slice(-4),
    });
    const retries    = await getRetryCount(To);
    const maxRetries = parseInt(process.env.MAX_RETRIES_PER_NUMBER) || 1;

    if (retries < maxRetries) {
      logger.info('📋 Enqueueing retry', {
        callerPhone: '***' + String(To).slice(-4),
        attempt:    retries + 1,
        maxRetries,
        reason:     CallStatus,
      });
      await enqueueRetry(To, Date.now() + 30 * 60 * 1000);
      await incrementRetryCount(To);
    } else {
      logger.warn('🔴 Max retries reached - sending missed call alert', {
        callerPhone:   '***' + String(To).slice(-4),
        totalAttempts: retries + 1,
      });
      await sendMissedCallAlert(To);
    }
  }

  res.sendStatus(200);
});

// ── GET /metrics ──────────────────────────────────────────────
router.get('/metrics', async (req, res) => {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    logger.warn('🚨 Unauthorized metrics request', { ip: req.ip });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    logger.info('📊 Fetching metrics', { ip: req.ip });
    const metrics = await getMetrics();
    res.json({ ok: true, metrics });
  } catch (err) {
    logger.error('❌ Metrics fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /leads ────────────────────────────────────────────────
router.get('/leads', (req, res) => {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    logger.warn('🚨 Unauthorized leads request', { ip: req.ip });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  logger.info('📋 Returning leads Google Sheets URL', { ip: req.ip });
  res.json({
    sheetsUrl: `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEETS_ID}`,
    tabs:      ['All Calls', 'Hot Leads'],
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;