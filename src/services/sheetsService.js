// src/services/sheetsService.js
// Logs every call and interested lead to Google Sheets
// Client (Lono) sees live leads in their sheet

const { google } = require('googleapis');
const logger = require('../utils/logger');

function getSheetsClient() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    throw new Error('Google Sheets credentials not configured');
  }
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key:  process.env.GOOGLE_PRIVATE_KEY
        .replace(/\\n/g, '\n')
        .replace(/^"|"$/g, ''),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// Log every call to "All Calls" tab
async function logCallToSheets(session, summary) {
  if (process.env.ENABLE_SHEETS_LOGGING !== 'true') return;
  if (!process.env.GOOGLE_SHEETS_ID) return;

  const tabName = process.env.GOOGLE_SHEET_TAB_NAME || 'All Calls';

  try {
    const sheets = getSheetsClient();
    const now    = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    await sheets.spreadsheets.values.append({
      spreadsheetId:    process.env.GOOGLE_SHEETS_ID,
      range:            `${tabName}!A:K`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          now,
          session.callerPhone ? '***' + String(session.callerPhone).slice(-4) : 'Unknown',
          session.leadData?.name        || '-',
          session.leadData?.emi_amount  || '-',
          session.leadData?.loan_type   || '-',
          session.leadData?.interest_rate || '-',
          session.leadData?.status      || session.outcome || '-',
          session.language              || 'telugu',
          session.duration              || 0,
          summary                       || '-',
          session.callSid,
        ]]
      }
    });
    logger.info('Call logged to Sheets');
  } catch (err) {
    logger.error('Sheets logging failed', { error: err.message });
  }
}

// Log only interested leads to "Hot Leads" tab
async function logLeadToSheets(session) {
  if (!process.env.GOOGLE_SHEETS_ID) return;
  if (!session.leadData?.name) return;

  try {
    const sheets = getSheetsClient();
    const now    = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    await sheets.spreadsheets.values.append({
      spreadsheetId:    process.env.GOOGLE_SHEETS_ID,
      range:            `Hot Leads!A:H`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          now,
          session.leadData.name,
          session.callerPhone || 'Unknown',
          session.leadData.emi_amount   || '-',
          session.leadData.loan_type    || '-',
          session.leadData.interest_rate || '-',
          'New — Call Required',           // Status for employee
          session.callSid,
        ]]
      }
    });
    logger.info('Hot lead logged to Sheets', { name: session.leadData.name });
  } catch (err) {
    logger.error('Lead logging failed', { error: err.message });
  }
}

// Initialize sheet headers — run once on startup
async function initSheetHeaders() {
  if (!process.env.GOOGLE_SHEETS_ID) return;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) return;

  try {
    const sheets  = getSheetsClient();
    const tabName = process.env.GOOGLE_SHEET_TAB_NAME || 'All Calls';

    await sheets.spreadsheets.values.update({
      spreadsheetId:    process.env.GOOGLE_SHEETS_ID,
      range:            `${tabName}!A1:K1`,
      valueInputOption: 'RAW',
      resource: {
        values: [[
          'Timestamp', 'Phone (masked)', 'Customer Name',
          'EMI Amount', 'Loan Type', 'Interest Rate',
          'Outcome', 'Language', 'Duration (sec)',
          'Summary', 'Call SID'
        ]]
      }
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId:    process.env.GOOGLE_SHEETS_ID,
      range:            `Hot Leads!A1:H1`,
      valueInputOption: 'RAW',
      resource: {
        values: [[
          'Timestamp', 'Customer Name', 'Phone Number',
          'EMI Amount', 'Loan Type', 'Current Interest Rate',
          'Status', 'Call SID'
        ]]
      }
    });

    logger.info('Google Sheets headers initialized');
  } catch (err) {
    logger.warn('Could not init sheet headers', { error: err.message });
  }
}

module.exports = { logCallToSheets, logLeadToSheets, initSheetHeaders };
