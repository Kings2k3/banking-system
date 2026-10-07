const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const nodemailer = require('nodemailer');
const config = require('../config');

const transport = config.SMTP_HOST ? nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE,
  requireTLS: !config.SMTP_SECURE,
  auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined
}) : null;

async function deliverMail({ to, subject, text }) {
  if (transport) {
    await transport.sendMail({ from: config.MAIL_FROM, to, subject, text });
    return 'smtp';
  }
  if (process.env.NODE_ENV === 'production') throw new Error('SMTP is required in production.');
  const folder = path.join(path.dirname(path.resolve(config.DB_PATH)), 'dev-mailbox');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, `${Date.now()}-${randomUUID()}.json`),
    JSON.stringify({ to, subject, text, createdAt: new Date().toISOString() }, null, 2),
    { mode: 0o600, flag: 'wx' });
  return 'dev-mailbox';
}

function actionLink(page, token) {
  return `${config.APP_BASE_URL.replace(/\/$/, '')}/${page}#token=${encodeURIComponent(token)}`;
}

module.exports = { deliverMail, actionLink };
