// src/utils/checkEnv.js
require('dotenv').config();

const REQUIRED = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'DEEPGRAM_API_KEY',
  'ANTHROPIC_API_KEY',
  'ELEVENLABS_API_KEY',
  'REDIS_URL',
  'BASE_URL',
  'ADMIN_API_KEY',
  'BUSINESS_NAME',
  'OWNER_WHATSAPP',
  'HUMAN_TRANSFER_NUMBER',
];

const OPTIONAL = [
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
  'GOOGLE_SHEETS_ID',
];

function checkEnv() {
  const missing  = REQUIRED.filter(k => !process.env[k] || process.env[k].includes('your_') || process.env[k].includes('xxxxx'));
  const warnings = OPTIONAL.filter(k => !process.env[k]);

  if (warnings.length) console.warn(`\n⚠️  Google Sheets not configured — lead logging disabled:\n   ${warnings.join(', ')}\n`);
  if (missing.length) {
    console.error(`\n❌ Missing required env vars:\n   ${missing.join('\n   ')}\n`);
    process.exit(1);
  }
  console.log('✅ All environment variables are set correctly.\n');
}

checkEnv();
module.exports = { checkEnv };
