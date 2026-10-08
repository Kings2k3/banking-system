const dotenv = require('dotenv');
const { createHash } = require('node:crypto');
dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';
const useResendSmtp = !!process.env.RESEND_API_KEY && !process.env.SMTP_HOST;
const smtpHost = process.env.SMTP_HOST || (useResendSmtp ? 'smtp.resend.com' : null);
const emailActionsEnabled = process.env.EMAIL_ACTIONS_ENABLED !== 'false';
const jwtSecret = requireEnv('JWT_SECRET', 'fallback_secret_for_development_only');
const staffMfaKey = process.env.STAFF_MFA_KEY || (isProduction ? '' :
  createHash('sha256').update(`payvexis-staff-mfa-v1:${jwtSecret}`).digest('hex'));
if (!/^[a-fA-F0-9]{64}$/.test(staffMfaKey)) {
  throw new Error('STAFF_MFA_KEY must be a separate 32-byte hex key.');
}
if (isProduction && emailActionsEnabled && (!smtpHost || !process.env.MAIL_FROM ||
    !/^https:\/\//.test(process.env.APP_BASE_URL || ''))) {
  throw new Error('Production email requires SMTP or RESEND_API_KEY, MAIL_FROM, and an HTTPS APP_BASE_URL.');
}

function requireEnv(name, fallback) {
  const value = process.env[name];
  if (!value && isProduction) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value || fallback;
}

module.exports = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: jwtSecret,
  STAFF_MFA_KEY: staffMfaKey,
  APP_BASE_URL: process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  EMAIL_ACTIONS_ENABLED: emailActionsEnabled,
  SMTP_HOST: smtpHost,
  SMTP_PORT: Number(process.env.SMTP_PORT || (useResendSmtp ? 465 : 587)),
  SMTP_SECURE: process.env.SMTP_SECURE === undefined ? useResendSmtp : process.env.SMTP_SECURE === 'true',
  SMTP_USER: process.env.SMTP_USER || (useResendSmtp ? 'resend' : null),
  SMTP_PASS: process.env.SMTP_PASS || (useResendSmtp ? process.env.RESEND_API_KEY : null),
  MAIL_FROM: process.env.MAIL_FROM || 'Payvexis Demo <no-reply@payvexis.invalid>',
  DB_PATH: process.env.DB_PATH || './server/payvexis.db',
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'admin@payvexis.com',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || null,
  DEMO_SEED: process.env.DEMO_SEED === 'true' && !isProduction,
  DEMO_INTERNAL_TRANSFERS: process.env.DEMO_INTERNAL_TRANSFERS === 'true' && !isProduction,
  DEMO_ADMIN_ADJUSTMENTS: process.env.DEMO_ADMIN_ADJUSTMENTS === 'true' && !isProduction,
  FRANKFURTER_API_BASE_URL: process.env.FRANKFURTER_API_BASE_URL || 'https://api.frankfurter.app'
};
