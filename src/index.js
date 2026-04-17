// src/index.js
// Lono Finance Voice Agent v2 — Production Grade
// FIX: TTS warmup on startup — common phrases cached before first call
// FIX: retry queue processor runs every 5 minutes
// FIX: /metrics endpoint via callRoutes

require('dotenv').config();
require('./utils/checkEnv');

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const callRoutes             = require('./routes/callRoutes');
const { setupStreamHandler } = require('./handlers/streamHandler');
const { initSheetHeaders }   = require('./services/sheetsService');
const { connectRedis, getDueRetries } = require('./services/sessionManager');
const { warmupTTSCache }     = require('./services/ttsService');
const { processRetryQueue }  = require('./scheduler/dialer');
const logger = require('./utils/logger');

const app    = express();
const server = http.createServer(app);

// ── Security ──────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      500,
  skip: (req) => req.path.startsWith('/call/stream'),
}));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── WebSocket — Twilio Media Streams ──────────────────────────
// FIX: WebSocket security — user-agent check removed
// Security is now handled by X-Twilio-Signature on the HTTP webhook
// WebSocket connections only happen after a valid Twilio webhook fires
const wss = new WebSocket.Server({ server, path: '/call/stream' });
setupStreamHandler(wss);

// ── Routes ────────────────────────────────────────────────────
app.use('/call', callRoutes);

app.get('/', (req, res) => res.json({
  status:    'ok',
  service:   'Lono Finance Voice Agent',
  version:   '2.0.0',
  language:  'Telugu (Primary) + Hindi + English',
  uptime:    Math.floor(process.uptime()),
  timestamp: new Date().toISOString(),
}));

app.get('/health', (req, res) => res.json({
  status:    'healthy',
  timestamp: new Date().toISOString(),
}));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  logger.error('Express error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start — Redis first, then warmup, then server ─────────────
const PORT = parseInt(process.env.PORT) || 3000;

async function start() {
  try {
    // 1. Connect Redis
    logger.info('Connecting to Redis...');
    await connectRedis();

    // 2. Start HTTP server
    await new Promise((resolve) => {
      server.listen(PORT, '0.0.0.0', resolve);
    });

    logger.info(`✅ Lono Finance Voice Agent v2.0 running on port ${PORT}`);
    logger.info(`   Outbound webhook: ${process.env.BASE_URL}/call/answered`);
    logger.info(`   Status callback:  ${process.env.BASE_URL}/call/status`);
    logger.info(`   Voicemail:        ${process.env.BASE_URL}/call/voicemail`);
    logger.info(`   Metrics:          ${process.env.BASE_URL}/call/metrics`);

    // 3. Non-blocking startup tasks
    Promise.allSettled([
      // Warm up TTS cache with common Telugu phrases
      warmupTTSCache().catch(err => logger.warn('TTS warmup failed', { error: err.message })),
      // Init Google Sheets headers
      initSheetHeaders().catch(() => logger.warn('Sheets unavailable')),
    ]);

    // 4. Process retry queue every 5 minutes
    setInterval(async () => {
      try {
        await processRetryQueue();
      } catch (err) {
        logger.error('Retry queue processing failed', { error: err.message });
      }
    }, 5 * 60 * 1000);

  } catch (err) {
    logger.error('Startup failed', { error: err.message });
    process.exit(1);
  }
}

start();

process.on('SIGTERM', () => {
  logger.info('SIGTERM — shutting down');
  server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

module.exports = { app, server };
