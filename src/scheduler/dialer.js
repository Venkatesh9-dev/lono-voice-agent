// src/scheduler/dialer.js
// FIX: concurrency control — max concurrent calls via semaphore
// FIX: call deduplication — skips numbers already called today
// FIX: Redis-based retry queue (not setTimeout)
// FIX: proper backpressure — waits for slot before dialing

require('dotenv').config();

const fs     = require('fs');
const path   = require('path');
const csv    = require('csv-parser');
const twilio = require('twilio');
const logger = require('../utils/logger');
const {
  markAsDialed,
  wasAlreadyDialed,
  getRetryCount,
  enqueueRetry,
  getDueRetries,
  incrementMetric,
} = require('../services/sessionManager');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const START_HOUR    = parseInt(process.env.CALLING_START_HOUR) || 7;
const END_HOUR      = parseInt(process.env.CALLING_END_HOUR)   || 24;
const MAX_RETRIES   = parseInt(process.env.MAX_RETRIES_PER_NUMBER) || 1;

// FIX: concurrency limiter — max simultaneous calls
// Twilio allows up to 2 concurrent calls per number on standard plan
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_CALLS) || 3;

// Simple semaphore for concurrency control
class Semaphore {
  constructor(max) {
    this.max     = max;
    this.current = 0;
    this.queue   = [];
  }
  acquire() {
    return new Promise((resolve) => {
      if (this.current < this.max) {
        this.current++;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }
  release() {
    this.current--;
    if (this.queue.length > 0) {
      this.current++;
      const next = this.queue.shift();
      next();
    }
  }
}

function isCallingHours() {
  const ist  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const hour = ist.getHours();
  const day  = ist.getDay();
  if (day === 0) { logger.warn('Sunday — skipping calls'); return false; }
  return hour >= START_HOUR && hour < END_HOUR;
}

function normalizePhone(phone) {
  let n = String(phone).replace(/\D/g, '');
  if (n.length === 10) n = '91' + n;
  if (!n.startsWith('+')) n = '+' + n;
  return n;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function dialNumber(phone, name, sem) {
  const normalized = normalizePhone(phone);

  // FIX: deduplication check
  if (await wasAlreadyDialed(normalized)) {
    logger.info('Skipping — already called today', { phone: '***' + normalized.slice(-4) });
    return { skipped: true, phone: normalized };
  }

  // FIX: check retry count before dialing
  const retries = await getRetryCount(normalized);
  if (retries >= MAX_RETRIES) {
    logger.info('Skipping — max retries reached', { phone: '***' + normalized.slice(-4) });
    return { skipped: true, phone: normalized };
  }

  // FIX: acquire semaphore slot before dialing (concurrency control)
  await sem.acquire();

  try {
    await markAsDialed(normalized);
    await incrementMetric('calls_initiated');

    logger.info('Dialing', {
      phone: '***' + normalized.slice(-4),
      name,
      concurrent: sem.current,
    });

    const call = await client.calls.create({
      to:   normalized,
      from: process.env.TWILIO_PHONE_NUMBER,
      url:  `${process.env.BASE_URL}/call/answered`,
      statusCallback:              `${process.env.BASE_URL}/call/status`,
      statusCallbackMethod:        'POST',
      statusCallbackEvent:         ['initiated', 'answered', 'completed'],
      machineDetection:            'DetectMessageEnd',
      asyncAmdStatusCallback:      `${process.env.BASE_URL}/call/voicemail`,
      asyncAmdStatusCallbackMethod: 'POST',
      timeout: 30,
    });

    logger.info('Call initiated', { callSid: call.sid, phone: '***' + normalized.slice(-4) });
    return { success: true, callSid: call.sid, phone: normalized };

  } catch (err) {
    logger.error('Dial failed', { error: err.message, phone: '***' + normalized.slice(-4) });

    // FIX: enqueue retry in Redis (not setTimeout — survives restarts)
    if (retries < MAX_RETRIES) {
      await enqueueRetry(normalized, Date.now() + 30 * 60 * 1000);
      logger.info('Retry enqueued in Redis', { phone: '***' + normalized.slice(-4) });
    }

    return { success: false, error: err.message, phone: normalized };

  } finally {
    // FIX: always release semaphore even on error
    sem.release();
  }
}

async function runDialer(csvFilePath, options = {}) {
  const { dryRun = false, limit = null } = options;

  if (!isCallingHours() && !dryRun) {
    logger.error(`Outside calling hours (${START_HOUR}AM–${END_HOUR}PM IST). Exiting.`);
    process.exit(1);
  }

  if (!fs.existsSync(csvFilePath)) {
    logger.error(`CSV not found: ${csvFilePath}`);
    process.exit(1);
  }

  // Read and deduplicate leads from CSV
  const seen  = new Set();
  const leads = [];

  await new Promise((resolve, reject) => {
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on('data', (row) => {
        const phone = row.phone || row.Phone || row.NUMBER || row.number;
        const name  = row.name  || row.Name  || row.NAME  || 'Customer';
        if (!phone) return;
        const normalized = normalizePhone(phone.trim());

        // FIX: CSV-level deduplication
        if (!seen.has(normalized)) {
          seen.add(normalized);
          leads.push({ phone: normalized, name: name.trim() });
        }
      })
      .on('end', resolve)
      .on('error', reject);
  });

  const toCall = limit ? leads.slice(0, limit) : leads;

  logger.info('Dialer starting', {
    totalInCSV:   leads.length,
    toCall:       toCall.length,
    maxConcurrent: MAX_CONCURRENT,
    dryRun,
  });

  const sem     = new Semaphore(MAX_CONCURRENT);
  const results = { success: 0, failed: 0, skipped: 0 };
  const promises = [];

  for (const lead of toCall) {
    if (!isCallingHours() && !dryRun) {
      logger.warn('Outside calling hours — stopping');
      break;
    }

    if (dryRun) {
      logger.info('[DRY RUN] Would call', { phone: lead.phone, name: lead.name });
      results.success++;
      continue;
    }

    // FIX: launch all calls concurrently up to MAX_CONCURRENT
    // Semaphore prevents more than MAX_CONCURRENT running at once
    const p = dialNumber(lead.phone, lead.name, sem).then(result => {
      if (result.skipped)      results.skipped++;
      else if (result.success) results.success++;
      else                     results.failed++;
    });
    promises.push(p);

    // Small delay between initiating calls (avoid Twilio rate limit on create)
    await sleep(500);
  }

  // Wait for all calls to be initiated
  await Promise.allSettled(promises);

  logger.info('Dialer complete', results);
  return results;
}

// Process Redis retry queue — call this on a schedule (e.g. every 5 minutes)
async function processRetryQueue() {
  if (!isCallingHours()) return;

  const dueRetries = await getDueRetries();
  if (dueRetries.length === 0) return;

  logger.info('Processing retry queue', { count: dueRetries.length });
  const sem = new Semaphore(MAX_CONCURRENT);

  for (const { phone } of dueRetries) {
    await dialNumber(phone, 'Customer', sem);
    await sleep(500);
  }
}

// CLI entry point
if (require.main === module) {
  const args    = process.argv.slice(2);
  const fileArg = args.find(a => a.startsWith('--file='))?.split('=')[1]
                || args[args[args.indexOf('--file') + 1] ? args.indexOf('--file') + 1 : 0];
  const dryRun  = args.includes('--dry-run');
  const retries = args.includes('--process-retries');
  const limit   = args.find(a => a.startsWith('--limit='))?.split('=')[1];

  const { connectRedis } = require('../services/sessionManager');

  connectRedis().then(async () => {
    if (retries) {
      await processRetryQueue();
    } else {
      if (!fileArg) {
        console.error('Usage: node dialer.js --file=leads.csv [--dry-run] [--limit=100]');
        process.exit(1);
      }
      await runDialer(path.resolve(process.cwd(), fileArg), {
        dryRun,
        limit: limit ? parseInt(limit) : null,
      });
    }
    process.exit(0);
  }).catch(err => {
    logger.error('Dialer failed', { error: err.message });
    process.exit(1);
  });
}

module.exports = { runDialer, dialNumber, processRetryQueue };
