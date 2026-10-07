const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const config = require('./config');
const { initDB, db } = require('./database');
const errorHandler = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');

// Initialize database schema
initDB();

const app = express();

// Security and utility middleware
// Configure helmet with a CSP that allows Google Translate and Google Fonts
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://translate.google.com", "https://translate.googleapis.com"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "https:", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://translate.google.com", "https://www.google.com", "https://translate.googleapis.com"],
      fontSrc: ["'self'", "https:", "data:"],
      connectSrc: ["'self'", "https://translate.googleapis.com", "https://api.frankfurter.app"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"]
    }
  }
}));
app.use(cors({ origin: config.CORS_ORIGIN }));
app.use(express.json());

// Apply rate limiting to all /api routes
app.use('/api', apiLimiter);

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/accounts', require('./routes/shared-accounts'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/exchange', require('./routes/exchange'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/support', require('./routes/support'));

// Only these browser assets may be served from the project root. In particular,
// server/, docs/, .env, package files and database files are never web assets.
const projectRoot = path.join(__dirname, '..');
const publicAssets = new Set([
  'index.html', 'features.html', 'security.html', 'support.html', 'card.html',
  'login.html', 'open-account.html', 'verify-email.html', 'recover-account.html',
  'dashboard.html', 'dashboard-activity.html',
  'dashboard-cards.html', 'dashboard-support.html', 'dashboard-members.html',
  'account-invite.html', 'admin.html', 'staff-setup.html',
  'script.js', 'card.js', 'login.js', 'open-account.js', 'dashboard.js',
  'dashboard-activity.js', 'dashboard-cards.js', 'dashboard-support.js',
  'admin.js', 'auth-client.js', 'translate.js', 'staff-setup.js',
  'verify-email.js', 'recover-account.js', 'account-invite.js', 'dashboard-members.js',
  'style.css', 'admin.css', 'translate.css', 'tailwind/output.css'
]);
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const asset = req.path === '/' ? 'index.html' : req.path.slice(1);
  if (!publicAssets.has(asset)) return next();
  return res.sendFile(asset, { root: projectRoot });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint not found' });
  return res.status(404).send('Page not found');
});

// Global error handler MUST be the last middleware
app.use(errorHandler);

// Graceful shutdown handling
const gracefulShutdown = () => {
  console.log('Received kill signal, shutting down gracefully.');
  db.close();
  process.exit(0);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Start server
if (require.main === module) {
  app.listen(config.PORT, () => {
    console.log(`Server running on http://localhost:${config.PORT}`);
  });
}

module.exports = app;
