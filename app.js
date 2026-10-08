// Vercel's Express entrypoint. The server starts its own listener only when
// server/index.js is launched directly for local development.
require('express');
module.exports = require('./server/index');
