const { adminControlsReady } = require('../migrations/002_admin_controls');

const ROLE_PERMISSIONS = Object.freeze({
  owner: ['stats.read', 'users.read', 'users.suspend', 'cards.freeze', 'ledger.read',
    'adjustments.read', 'adjustments.propose', 'adjustments.approve', 'audit.read', 'staff.manage',
    'users.notes.read', 'users.notes.write', 'users.restrict', 'users.sessions.revoke',
    'operations.read', 'operations.review'],
  finance_operator: ['stats.read', 'users.read', 'ledger.read', 'adjustments.read',
    'adjustments.propose', 'operations.read', 'operations.review'],
  finance_approver: ['stats.read', 'users.read', 'ledger.read', 'adjustments.read',
    'adjustments.approve', 'operations.read'],
  support: ['stats.read'],
  auditor: ['stats.read', 'ledger.read', 'adjustments.read', 'audit.read', 'operations.read']
});

function staffForUser(db, userId) {
  if (!adminControlsReady(db)) {
    return { role: 'legacy_admin', permissions: ROLE_PERMISSIONS.owner };
  }
  const membership = db.prepare('SELECT staff_role, active FROM staff_memberships WHERE user_id = ?').get(userId);
  if (!membership || !membership.active) return null;
  return { role: membership.staff_role, permissions: ROLE_PERMISSIONS[membership.staff_role] || [] };
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.staff?.permissions.includes(permission)) {
      return res.status(403).json({ error: 'Your staff role does not allow this action.' });
    }
    next();
  };
}

module.exports = { ROLE_PERMISSIONS, staffForUser, requirePermission };
