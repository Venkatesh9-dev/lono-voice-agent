// src/routes/callRoutes.js
// FIX: proper Twilio request signature validation (not just user-agent)
// FIX: voicemail number from env var (not hardcoded)
// FIX: /metrics endpoint for monitoring
// FIX [v2.1]: replaced 5x <Pause length="60"> loop with single <Pause length="3600">

const express = require('express');
const twilio  = require('twilio');
const { sendMissedCallAlert }  = require('../services/notificationService');
const {
  enqueueRetry,
  getRetryCount,
  incrementRetryCount,
  getDueRetries,
  getMetrics,
  incrementMetric,
} = require('../services/sessionManager');
const logger = require('../utils/logger');

const router = express.Router();

// ── Twilio signature validation ───────────────────────────────
function validateTwilio(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();

  const signature = req.headers['x-twilio-signature'] || '';
  const url       = `${process.env.BASE_URL}${req.originalUrl}`;

  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );

  if (!isValid) {
    logger.warn('SECURITY: Invalid Twilio signature rejected', {
      url,
      ip: req.ip,
      ua: req.headers['user-agent']?.slice(0, 50),
    });
    return res.status(403).send('Forbidden');
  }

  next();
}

// ── POST /call/answered — outbound call connected ─────────────
router.post('/answered', (req, res) => {
  const callSid     = req.body.CallSid || 'unknown';
  const callerPhone = req.body.To      || 'unknown';

  logger.info('Outbound call answered', { callSid });

  const twiml  = new twilio.twiml.VoiceResponse();
  const start  = twiml.start();
const stream = start.stream({
  url: `wss://${process.env.BASE_URL.replace('https://', '')}/call/stream`,
});
  stream.parameter({ name: 'callerPhone', value: callerPhone });
  stream.parameter({ name: 'callSid',     value: callSid });

  // FIX [v2.1]: Single 3600s pause — old 5×60s loop capped calls at 300s.
  // MAX_CALL_SECONDS (default 180s) or handleCallEnd() ends the call first.
  twiml.pause({ length: 3600 });

  res.type('text/xml').send(twiml.toString());
});

// ── POST /call/incoming — inbound (for testing) ───────────────
router.post('/incoming', validateTwilio, (req, res) => {
  const callSid     = req.body.CallSid || 'unknown';
  const callerPhone = req.body.From    || 'unknown';

  logger.info('Inbound call', { callSid });

  const twiml  = new twilio.twiml.VoiceResponse();
  const start  = twiml.start();
  const stream = start.stream({ url: `wss://${req.headers.host}/call/stream` });
  stream.parameter({ name: 'callerPhone', value: callerPhone });
  stream.parameter({ name: 'callSid',     value: callSid });

  twiml.pause({ length: 3600 });

  res.type('text/xml').send(twiml.toString());
});

// ── POST /call/voicemail — answering machine detected ─────────
router.post('/voicemail', validateTwilio, async (req, res) => {
  const { CallSid, To, AnsweredBy } = req.body;

  logger.info('Answering machine detected', { CallSid, AnsweredBy });
  await incrementMetric('voicemails');

  if (process.env.ENABLE_VOICEMAIL_MESSAGE !== 'true') {
    return res.type('text/xml').send('<Response><Hangup/></Response>');
  }

  const callbackNumber = process.env.LONO_CALLBACK_NUMBER || process.env.TWILIO_PHONE_NUMBER;

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { voice: 'Polly.Aditi', language: 'en-IN' },
    `Hello, this is a call from Lono Finance. We have some important information about your loan EMI. Please call us back at ${callbackNumber}. Thank you.`
  );
  twiml.hangup();

  res.type('text/xml').send(twiml.toString());
});

// ── POST /call/status — Twilio status callbacks ───────────────
router.post('/status', validateTwilio, async (req, res) => {
  const { CallSid, CallStatus, To, AnsweredBy, CallDuration } = req.body;

  logger.info('Call status', { CallSid, CallStatus, AnsweredBy, duration: CallDuration });

  if (CallStatus === 'answered') {
    await incrementMetric('calls_answered');
  }

  if (['no-answer', 'busy', 'failed'].includes(CallStatus) && To) {
    const retries    = await getRetryCount(To);
    const maxRetries = parseInt(process.env.MAX_RETRIES_PER_NUMBER) || 1;

    if (retries < maxRetries) {
      await enqueueRetry(To, Date.now() + 30 * 60 * 1000);
      await incrementRetryCount(To);
      logger.info('Retry enqueued', {
        phone:   '***' + String(To).slice(-4),
        attempt: retries + 1,
        reason:  CallStatus,
      });
    } else {
      logger.info('Max retries reached', { phone: '***' + String(To).slice(-4) });
      await sendMissedCallAlert(To);
    }
  }

  res.sendStatus(200);
});

// ── GET /metrics ──────────────────────────────────────────────
router.get('/metrics', async (req, res) => {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const metrics = await getMetrics();
    res.json({ ok: true, metrics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /leads ────────────────────────────────────────────────
router.get('/leads', (req, res) => {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({
    sheetsUrl: `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEETS_ID}`,
    tabs:      ['All Calls', 'Hot Leads'],
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;