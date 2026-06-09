const dotenv = require('dotenv');
dotenv.config();

module.exports = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'fallback_secret_for_development_only',
  DB_PATH: process.env.VERCEL ? '/tmp/payvexis.db' : (process.env.DB_PATH || './server/payvexis.db'),
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'admin@payvexis.com',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'AdminPass123!',
  FRANKFURTER_API_BASE_URL: process.env.FRANKFURTER_API_BASE_URL || 'https://api.frankfurter.app'
};
