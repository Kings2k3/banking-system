const { db } = require('../database');
const { staffForUser } = require('../services/staff');
const { identityOwnershipReady } = require('../migrations/003_identity_ownership');

const admin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
  }

  if (!identityOwnershipReady(db)) {
    return res.status(503).json({ error: 'Staff access requires the identity migration.' });
  }
  const session = db.prepare('SELECT staff_mfa_verified FROM auth_sessions WHERE id = ?').get(req.sessionId);
  if (!session?.staff_mfa_verified) {
    return res.status(403).json({ error: 'Staff MFA verification is required.' });
  }

  const staff = staffForUser(db, req.user.id);
  if (!staff) return res.status(403).json({ error: 'Staff access is inactive or unassigned.' });
  req.staff = staff;

  next();
};

module.exports = admin;
