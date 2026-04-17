// src/services/notificationService.js
// WhatsApp alerts to Lono owner for missed calls

const twilio = require('twilio');
const logger = require('../utils/logger');

let _client;
function getClient() {
  if (!_client) _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return _client;
}

async function sendMissedCallAlert(callerPhone) {
  if (process.env.ENABLE_MISSED_CALL_WHATSAPP !== 'true') return;
  if (!process.env.OWNER_WHATSAPP) return;
  if (!callerPhone || callerPhone === 'unknown') return;

  try {
    await getClient().messages.create({
      from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
      to:   `whatsapp:${process.env.OWNER_WHATSAPP}`,
      body: `📞 *Lono Finance — Missed Call*\n\nPhone: ***${String(callerPhone).slice(-4)}\nTime: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n_Please follow up manually._`,
    });
    logger.info('Missed call WhatsApp sent');
  } catch (err) {
    logger.error('Missed call WhatsApp failed', { error: err.message });
  }
}

async function sendOwnerCallSummary(session, summary) {
  if (!process.env.OWNER_WHATSAPP) return;

  const hasLead = session.leadData?.name;
  const emoji   = hasLead ? '🟢' : '🔴';
  const status  = hasLead ? 'Interested Lead' : (session.outcome || 'Completed');

  try {
    await getClient().messages.create({
      from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
      to:   `whatsapp:${process.env.OWNER_WHATSAPP}`,
      body:
        `${emoji} *Lono Finance — Call Summary*\n\n` +
        `📱 Phone: ***${String(session.callerPhone || '').slice(-4)}\n` +
        `👤 Name: ${session.leadData?.name || 'Not captured'}\n` +
        `💰 EMI: ${session.leadData?.emi_amount || '-'}\n` +
        `🏦 Loan Type: ${session.leadData?.loan_type || '-'}\n` +
        `📊 Interest: ${session.leadData?.interest_rate || '-'}\n` +
        `✅ Status: ${status}\n` +
        `⏱ Duration: ${session.duration || 0}s\n` +
        `📋 Summary: ${summary}`,
    });
    logger.info('Owner call summary sent');
  } catch (err) {
    logger.error('Owner summary failed', { error: err.message });
  }
}

module.exports = { sendMissedCallAlert, sendOwnerCallSummary };
