// src/utils/logger.js
const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'lono-voice-agent' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const m = { ...meta };
          delete m.service;
          const s = Object.keys(m).length ? ' ' + JSON.stringify(m) : '';
          return `[${timestamp}] ${level}: ${message}${s}`;
        })
      )
    })
  ]
});

module.exports = logger;
