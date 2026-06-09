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
app.use(helmet());
app.use(cors({ origin: config.CORS_ORIGIN }));
app.use(express.json());

// Apply rate limiting to all /api routes
app.use('/api', apiLimiter);

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/exchange', require('./routes/exchange'));
app.use('/api/admin', require('./routes/admin'));

// Serve static frontend files
// This assumes the server folder is inside the project root
const projectRoot = path.join(__dirname, '..');
app.use(express.static(projectRoot));

// Fallback for 404s (e.g. if we add client-side routing later)
// Currently, standard HTML files are served by express.static
app.use((req, res) => {
  res.status(404).sendFile(path.join(projectRoot, 'index.html'));
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

// Start server if not running in serverless mode
if (require.main === module || !process.env.VERCEL) {
  app.listen(config.PORT, () => {
    console.log(`Server running on http://localhost:${config.PORT}`);
  });
}

// Export for Vercel serverless function
module.exports = app;
