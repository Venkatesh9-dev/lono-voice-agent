// src/services/sessionManager.js
// FIX: optimistic locking on session updates (version field)
// FIX: Redis-based retry queue (survives restarts)
// FIX: call deduplication via Redis Set

const Redis  = require('ioredis');
const logger = require('../utils/logger');

const SESSION_TTL    = 3600;
const COMPLETED_TTL  = 86400 * 7;
const MAX_LOCK_RETRY = 3;

let redis;

function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      tls: process.env.REDIS_URL?.startsWith('rediss://') ? {} : undefined,
      retryStrategy: (times) => times > 10 ? null : Math.min(times * 200, 3000),
      maxRetriesPerRequest: 3,
      lazyConnect: false,
      enableOfflineQueue: true,
    });
    redis.on('error',   (err) => logger.error('Redis error', { error: err.message }));
    redis.on('connect', ()    => logger.info('Redis connected'));
    redis.on('close',   ()    => logger.warn('Redis connection closed'));
  }
  return redis;
}

async function connectRedis() {
  await getRedis().ping();
  logger.info('Redis pre-connection successful');
}

// ── Session Management ────────────────────────────────────────

async function createSession(callSid, callerPhone, isOutbound = false) {
  const session = {
    callSid,
    callerPhone,
    isOutbound,
    language:         'telugu',
    messages:         [],
    leadData:         {},
    startTime:        Date.now(),
    outcome:          'in_progress',
    transferRequested: false,
    idleWarningsSent:  0,
    version:           1,   // FIX: optimistic locking version
  };
  await getRedis().setex(`call:${callSid}`, SESSION_TTL, JSON.stringify(session));
  logger.info('Session created', { callSid, isOutbound });
  return session;
}

async function getSession(callSid) {
  try {
    const data = await getRedis().get(`call:${callSid}`);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.error('getSession error', { error: err.message });
    return null;
  }
}

// FIX: optimistic locking — checks version before writing
// Retries up to MAX_LOCK_RETRY times if version mismatch
async function updateSession(callSid, updates) {
  for (let attempt = 0; attempt < MAX_LOCK_RETRY; attempt++) {
    try {
      const session = await getSession(callSid);
      if (!session) return null;

      const updated = {
        ...session,
        ...updates,
        version: (session.version || 1) + 1,
      };

      // Atomic compare-and-set using Redis WATCH
      const r = getRedis();
      await r.watch(`call:${callSid}`);
      const current = await r.get(`call:${callSid}`);
      const parsed  = current ? JSON.parse(current) : null;

      // Version mismatch — another process updated first, retry
      if (!parsed || parsed.version !== session.version) {
        await r.unwatch();
        logger.debug('Session version conflict — retrying', { callSid, attempt });
        await new Promise(res => setTimeout(res, 10 * (attempt + 1)));
        continue;
      }

      const multi = r.multi();
      multi.setex(`call:${callSid}`, SESSION_TTL, JSON.stringify(updated));
      const results = await multi.exec();

      if (results === null) {
        // Transaction failed — retry
        continue;
      }

      return updated;

    } catch (err) {
      logger.error('updateSession error', { error: err.message, attempt });
      if (attempt === MAX_LOCK_RETRY - 1) return null;
    }
  }
  return null;
}

async function addMessage(callSid, role, content) {
  try {
    // addMessage is append-only — lower race risk, simple get/set is fine
    const session = await getSession(callSid);
    if (!session) return null;
    session.messages.push({ role, content });
    if (session.messages.length > 20) session.messages = session.messages.slice(-20);
    session.version = (session.version || 1) + 1;
    await getRedis().setex(`call:${callSid}`, SESSION_TTL, JSON.stringify(session));
    return session;
  } catch (err) {
    logger.error('addMessage error', { error: err.message });
    return null;
  }
}

async function endSession(callSid, outcome = 'completed') {
  try {
    const session = await getSession(callSid);
    if (!session) return null;
    const duration     = Math.round((Date.now() - session.startTime) / 1000);
    const finalSession = { ...session, outcome, duration, endTime: Date.now() };
    await getRedis().setex(`call:${callSid}:done`, COMPLETED_TTL, JSON.stringify(finalSession));
    await getRedis().del(`call:${callSid}`);
    logger.info('Session ended', { callSid, outcome, duration });
    return finalSession;
  } catch (err) {
    logger.error('endSession error', { error: err.message });
    return null;
  }
}

// ── Redis-Based Retry Queue (survives restarts) ───────────────
// FIX: replaces setTimeout-based retry with persistent Redis queue

const RETRY_QUEUE_KEY = 'lono:retry:queue';
const RETRY_DELAY_MS  = 30 * 60 * 1000; // 30 minutes

async function enqueueRetry(phone, scheduledAt) {
  const entry = JSON.stringify({ phone, scheduledAt: scheduledAt || Date.now() + RETRY_DELAY_MS });
  await getRedis().rpush(RETRY_QUEUE_KEY, entry);
  logger.info('Retry enqueued', { phone: '***' + String(phone).slice(-4) });
}

async function getDueRetries() {
  const now     = Date.now();
  const all     = await getRedis().lrange(RETRY_QUEUE_KEY, 0, -1);
  const due     = [];
  const notDue  = [];

  for (const item of all) {
    try {
      const parsed = JSON.parse(item);
      if (parsed.scheduledAt <= now) due.push(parsed);
      else notDue.push(item);
    } catch {}
  }

  // Rewrite queue with only not-due items
  if (due.length > 0) {
    await getRedis().del(RETRY_QUEUE_KEY);
    if (notDue.length > 0) {
      await getRedis().rpush(RETRY_QUEUE_KEY, ...notDue);
    }
  }

  return due;
}

// ── Call Deduplication ────────────────────────────────────────
// FIX: prevents same number being called twice from CSV

const DIALED_SET_KEY = 'lono:dialed:today';

async function markAsDialed(phone) {
  await getRedis().sadd(DIALED_SET_KEY, phone);
  await getRedis().expire(DIALED_SET_KEY, 86400); // resets daily
}

async function wasAlreadyDialed(phone) {
  return await getRedis().sismember(DIALED_SET_KEY, phone) === 1;
}

async function clearDialedSet() {
  await getRedis().del(DIALED_SET_KEY);
  logger.info('Dialed set cleared');
}

// ── Per-number retry count ────────────────────────────────────
async function getRetryCount(phone) {
  const val = await getRedis().get(`retry:count:${phone}`);
  return val ? parseInt(val) : 0;
}

async function incrementRetryCount(phone) {
  await getRedis().incr(`retry:count:${phone}`);
  await getRedis().expire(`retry:count:${phone}`, 86400);
}

// ── Simple metrics in Redis ───────────────────────────────────
async function incrementMetric(key) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  await getRedis().incr(`lono:metrics:${date}:${key}`);
  await getRedis().expire(`lono:metrics:${date}:${key}`, 86400 * 7);
}

async function getMetrics() {
  const date = new Date().toISOString().slice(0, 10);
  const keys = ['calls_initiated', 'calls_answered', 'calls_completed',
                 'leads_captured', 'not_interested', 'voicemails', 'transfers'];
  const result = {};
  for (const k of keys) {
    const val = await getRedis().get(`lono:metrics:${date}:${k}`);
    result[k] = val ? parseInt(val) : 0;
  }
  result.date = date;
  result.conversion_rate = result.calls_answered > 0
    ? ((result.leads_captured / result.calls_answered) * 100).toFixed(1) + '%'
    : '0%';
  return result;
}

module.exports = {
  connectRedis,
  createSession, getSession, updateSession, addMessage, endSession,
  enqueueRetry, getDueRetries,
  markAsDialed, wasAlreadyDialed, clearDialedSet,
  getRetryCount, incrementRetryCount,
  incrementMetric, getMetrics,
};
