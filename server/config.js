const dotenv = require('dotenv');
dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

function requireEnv(name, fallback) {
  const value = process.env[name];
  if (!value && isProduction) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value || fallback;
}

module.exports = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: requireEnv('JWT_SECRET', 'fallback_secret_for_development_only'),
  DB_PATH: process.env.DB_PATH || './server/payvexis.db',
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'admin@payvexis.com',
  ADMIN_PASSWORD: requireEnv('ADMIN_PASSWORD', 'AdminPass123!'),
  FRANKFURTER_API_BASE_URL: process.env.FRANKFURTER_API_BASE_URL || 'https://api.frankfurter.app'
};
