const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../database');

const auth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required. Please log in.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, config.JWT_SECRET);
    
    // Check if user still exists and is not suspended
    const user = db.prepare('SELECT id, email, role, suspended FROM users WHERE id = ?').get(decoded.id);
    
    if (!user) {
      return res.status(401).json({ error: 'User no longer exists.' });
    }
    
    if (user.suspended) {
      return res.status(403).json({ error: 'Account suspended. Please contact support.' });
    }

    // Attach user payload to request
    req.user = {
      id: user.id,
      email: user.email,
      role: user.role
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token. Please log in again.' });
  }
};

module.exports = auth;
