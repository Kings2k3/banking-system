const express = require('express');
const { randomBytes, createHash } = require('node:crypto');
const { db } = require('../database');
const config = require('../config');
const { asyncHandler, logAuditAction } = require('../utils/helpers');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');
const { ledgerIsReady } = require('../migrations/001_ledger');
const { adminControlsReady } = require('../migrations/002_admin_controls');
const { requirePermission } = require('../services/staff');
const { proposeAdjustment, decideAdjustment, getRequest } = require('../services/adjustments');
const { sharedAccountsReady } = require('../migrations/005_shared_accounts');
const { adminWorkspaceReady } = require('../migrations/006_admin_workspace');

const router = express.Router();

// All admin routes require auth AND admin role
router.use(auth);
router.use(admin);

router.get('/me', (req, res) => {
  res.json({ userId: req.user.id, role: req.staff.role,
    permissions: req.staff.permissions, controlsReady: adminControlsReady(db),
    workspaceReady: adminWorkspaceReady(db),
    demoAdjustmentsEnabled: config.DEMO_ADMIN_ADJUSTMENTS });
});

router.get('/ledger/journals', requirePermission('ledger.read'), (req, res) => {
  if (!ledgerIsReady(db)) return res.status(503).json({ error: 'Ledger migration is not applied.' });
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const total = db.prepare('SELECT COUNT(*) AS count FROM ledger_journals').get().count;
  const journals = db.prepare(`SELECT id, reference, kind, requester_user_id AS requesterUserId,
    created_at AS createdAt FROM ledger_journals ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(limit, (page - 1) * limit);
  const postings = db.prepare(`SELECT p.amount_minor AS amountMinor, a.kind, a.currency,
    a.account_number AS accountNumber, a.user_id AS userId
    FROM ledger_postings p JOIN ledger_accounts a ON a.id = p.account_id
    WHERE p.journal_id = ? ORDER BY p.id`);
  for (const journal of journals) {
    journal.postings = postings.all(journal.id).map(posting => ({
      amountMinor: posting.amountMinor,
      kind: posting.kind,
      currency: posting.currency,
      accountMask: posting.kind === 'customer' ? posting.accountNumber.slice(-4) : 'opening clearing',
      userId: posting.userId
    }));
  }
  res.json({ journals, total, page, limit });
});

router.get('/adjustments', requirePermission('adjustments.read'), (req, res) => {
  if (!adminControlsReady(db)) return res.status(503).json({ error: 'Admin controls migration is not applied.' });
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
  const where = status ? 'WHERE status = ?' : '';
  const params = status ? [status] : [];
  const total = db.prepare(`SELECT COUNT(*) AS count FROM adjustment_requests ${where}`).get(...params).count;
  const ids = db.prepare(`SELECT id FROM adjustment_requests ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, (page - 1) * limit);
  res.json({ adjustments: ids.map(row => getRequest(db, row.id)), total, page, limit });
});

router.post('/adjustments', requirePermission('adjustments.propose'), asyncHandler(async (req, res) => {
  if (!config.DEMO_ADMIN_ADJUSTMENTS) {
    return res.status(503).json({ error: 'Demo adjustments are disabled. No balance changed.' });
  }
  const input = req.body || {};
  const adjustment = proposeAdjustment(db, {
    actorId: req.user.id, userId: input.userId,
    direction: input.type, amount: input.amount,
    reason: input.reason, senderName: input.senderName,
    idempotencyKey: req.get('Idempotency-Key'), ip: req.ip
  });
  res.status(201).json({ adjustment });
}));

router.post('/adjustments/:id/approve', requirePermission('adjustments.approve'), asyncHandler(async (req, res) => {
  if (!config.DEMO_ADMIN_ADJUSTMENTS) {
    return res.status(503).json({ error: 'Demo adjustments are disabled. No balance changed.' });
  }
  const adjustment = decideAdjustment(db, {
    actorId: req.user.id, requestId: req.params.id,
    decision: 'approve', note: req.body?.note, ip: req.ip
  });
  res.json({ adjustment });
}));

router.post('/adjustments/:id/reject', requirePermission('adjustments.approve'), asyncHandler(async (req, res) => {
  if (!config.DEMO_ADMIN_ADJUSTMENTS) {
    return res.status(503).json({ error: 'Demo adjustments are disabled.' });
  }
  const adjustment = decideAdjustment(db, {
    actorId: req.user.id, requestId: req.params.id,
    decision: 'reject', note: req.body?.note, ip: req.ip
  });
  res.json({ adjustment });
}));

router.get('/staff', requirePermission('staff.manage'), (req, res) => {
  if (!adminControlsReady(db)) return res.status(503).json({ error: 'Admin controls migration is not applied.' });
  const staff = db.prepare(`SELECT s.user_id AS id, s.staff_role AS role, s.active,
    s.created_at AS createdAt, u.email, u.first_name AS firstName, u.last_name AS lastName
    FROM staff_memberships s JOIN users u ON u.id = s.user_id ORDER BY s.user_id`).all();
  res.json({ staff: staff.map(person => ({ ...person, active: !!person.active })) });
});

router.post('/staff/invitations', requirePermission('staff.manage'), (req, res) => {
  if (!adminControlsReady(db)) return res.status(503).json({ error: 'Admin controls migration is not applied.' });
  const input = req.body || {};
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const role = input.role;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
      !['finance_operator', 'finance_approver', 'support', 'auditor'].includes(role)) {
    return res.status(400).json({ error: 'Provide a valid email and staff role.' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'This email already has an account.' });
  }
  const invitationCode = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(invitationCode).digest('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.transaction(() => {
    db.prepare("UPDATE staff_invitations SET revoked_at = datetime('now') WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL")
      .run(email);
    const id = db.prepare(`INSERT INTO staff_invitations
      (email, staff_role, token_hash, expires_at, created_by) VALUES (?, ?, ?, ?, ?)`)
      .run(email, role, hash, expiresAt, req.user.id).lastInsertRowid;
    logAuditAction(db, req.user.id, 'staff_invited', 'staff_invitation', id,
      `Invited ${email} as ${role}`, req.ip || '');
  }).immediate();
  res.status(201).json({ invitationCode, expiresAt, setupPage: 'staff-setup.html' });
});

router.patch('/staff/:id/role', requirePermission('staff.manage'), (req, res) => {
  if (!adminControlsReady(db)) return res.status(503).json({ error: 'Admin controls migration is not applied.' });
  const targetId = Number(req.params.id);
  const role = req.body?.role;
  if (!Number.isSafeInteger(targetId) || !['finance_operator', 'finance_approver', 'support', 'auditor'].includes(role)) {
    return res.status(400).json({ error: 'Invalid staff member or role.' });
  }
  if (targetId === req.user.id) return res.status(403).json({ error: 'You cannot change your own staff role.' });
  const target = db.prepare('SELECT staff_role FROM staff_memberships WHERE user_id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'Staff member not found.' });
  if (target.staff_role === 'owner') return res.status(403).json({ error: 'Owner roles require a separate governance process.' });
  db.transaction(() => {
    db.prepare('UPDATE staff_memberships SET staff_role = ? WHERE user_id = ?').run(role, targetId);
    db.prepare("UPDATE auth_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL").run(targetId);
    logAuditAction(db, req.user.id, 'staff_role_changed', 'user', targetId,
      `Changed staff role from ${target.staff_role} to ${role}`, req.ip || '');
  }).immediate();
  res.json({ success: true, role });
});

router.post('/staff/:id/active', requirePermission('staff.manage'), (req, res) => {
  if (!adminControlsReady(db)) return res.status(503).json({ error: 'Admin controls migration is not applied.' });
  const targetId = Number(req.params.id);
  if (!Number.isSafeInteger(targetId) || typeof req.body?.active !== 'boolean') {
    return res.status(400).json({ error: 'Invalid staff member or active state.' });
  }
  if (targetId === req.user.id) return res.status(403).json({ error: 'You cannot deactivate your own access.' });
  const target = db.prepare('SELECT staff_role FROM staff_memberships WHERE user_id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'Staff member not found.' });
  if (target.staff_role === 'owner') return res.status(403).json({ error: 'Owner access requires a separate governance process.' });
  db.transaction(() => {
    db.prepare('UPDATE staff_memberships SET active = ? WHERE user_id = ?').run(req.body.active ? 1 : 0, targetId);
    db.prepare("UPDATE auth_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL").run(targetId);
    logAuditAction(db, req.user.id, req.body.active ? 'staff_activated' : 'staff_deactivated',
      'user', targetId, `Staff access ${req.body.active ? 'enabled' : 'disabled'}`, req.ip || '');
  }).immediate();
  res.json({ success: true, active: req.body.active });
});

// Get system stats
router.get('/stats', requirePermission('stats.read'), asyncHandler(async (req, res) => {
  const totalUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'user'").get().count;
  const totalBalance = db.prepare("SELECT SUM(balance) as total FROM users WHERE role = 'user'").get().total || 0;
  const transactionCount = db.prepare("SELECT COUNT(*) as count FROM transactions").get().count;
  const suspendedCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'user' AND suspended = 1").get().count;

  res.json({ totalUsers, totalBalance, transactionCount, suspendedCount });
}));

// Get all users (paginated, searchable)
router.get('/users', requirePermission('users.read'), asyncHandler(async (req, res) => {
  const { search, status, sort = 'created_at_desc', page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let query = "SELECT id, email, first_name, last_name, account_number, balance, suspended, created_at FROM users WHERE role = 'user'";
  let countQuery = "SELECT COUNT(*) as total FROM users WHERE role = 'user'";
  const params = [];

  if (search) {
    const searchPattern = `%${search}%`;
    const searchClause = " AND (email LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR account_number LIKE ?)";
    query += searchClause;
    countQuery += searchClause;
    params.push(searchPattern, searchPattern, searchPattern, searchPattern);
  }

  if (status === 'suspended') {
    query += " AND suspended = 1";
    countQuery += " AND suspended = 1";
  } else if (status === 'active') {
    query += " AND suspended = 0";
    countQuery += " AND suspended = 0";
  }

  if (sort === 'balance_desc') query += " ORDER BY balance DESC";
  else if (sort === 'balance_asc') query += " ORDER BY balance ASC";
  else if (sort === 'created_at_asc') query += " ORDER BY created_at ASC";
  else query += " ORDER BY created_at DESC"; // default

  query += " LIMIT ? OFFSET ?";
  
  const total = db.prepare(countQuery).get(...params).total;
  const users = db.prepare(query).all(...params, limit, offset);

  res.json({ users, total, page: parseInt(page), limit: parseInt(limit),
    adjustmentsEnabled: adminControlsReady(db) && config.DEMO_ADMIN_ADJUSTMENTS &&
      req.staff.permissions.includes('adjustments.propose') });
}));

// Get specific user details
router.get('/users/:id', requirePermission('users.read'), asyncHandler(async (req, res) => {
  const userId = req.params.id;

  const user = db.prepare(`
    SELECT id, email, first_name, last_name, phone, dob, account_type, account_label, account_number, balance, suspended, created_at,
           is_joint, joint_first_name, joint_last_name, joint_email, joint_phone, joint_dob, joint_relationship
    FROM users WHERE id = ? AND role = 'user'
  `).get(userId);

  if (!user) return res.status(404).json({ error: 'User not found' });

  const cards = db.prepare('SELECT id, name, mask, status, frozen, card_limit FROM cards WHERE user_id = ?').all(userId);
  const transactions = db.prepare('SELECT id, type, category, merchant, amount, status, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(userId);

  const accounts = sharedAccountsReady(db) ? db.prepare(`SELECT a.id, a.display_name AS name,
    a.requested_type AS requestedType, a.ownership_kind AS ownershipKind,
    a.status, m.member_role AS memberRole, l.currency, l.balance_minor AS balanceMinor,
    substr(l.account_number, -4) AS mask
    FROM account_memberships m JOIN customer_accounts a ON a.id = m.account_id
    JOIN ledger_accounts l ON l.id = a.ledger_account_id
    WHERE m.user_id = ? AND m.status = 'active' ORDER BY a.id`).all(userId) : [];
  res.json({ user, cards, transactions, accounts });
}));

router.get('/accounts/:id', requirePermission('users.read'), (req, res) => {
  if (!sharedAccountsReady(db)) return res.status(503).json({ error: 'Shared accounts are unavailable.' });
  const account = db.prepare(`SELECT a.id, a.display_name AS name, a.requested_type AS requestedType,
    a.ownership_kind AS ownershipKind, a.status, l.currency, l.balance_minor AS balanceMinor,
    substr(l.account_number, -4) AS mask, p.rule AS signingRule
    FROM customer_accounts a JOIN ledger_accounts l ON l.id = a.ledger_account_id
    JOIN account_signing_policies p ON p.account_id = a.id WHERE a.id = ?`).get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  const members = db.prepare(`SELECT m.user_id AS userId, m.member_role AS role, m.status,
    u.email, u.first_name AS firstName, u.last_name AS lastName,
    u.email_verified_at AS emailVerifiedAt
    FROM account_memberships m JOIN users u ON u.id = m.user_id
    WHERE m.account_id = ? ORDER BY m.user_id`).all(account.id);
  const pendingTransfers = db.prepare(`SELECT id, amount_minor AS amountMinor, status,
    created_by AS createdBy, expires_at AS expiresAt
    FROM transfer_requests WHERE account_id = ? AND status = 'pending' ORDER BY id DESC`).all(account.id);
  res.json({ account, members, pendingTransfers });
});

// Suspend/Unsuspend user
router.put('/users/:id/suspend', requirePermission('users.suspend'), asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const adminId = req.user.id;
  const ipAddress = req.ip || req.connection.remoteAddress;

  const user = db.prepare("SELECT suspended, email FROM users WHERE id = ? AND role = 'user'").get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const newSuspendedState = user.suspended ? 0 : 1;
  db.prepare('UPDATE users SET suspended = ? WHERE id = ?').run(newSuspendedState, userId);

  const action = newSuspendedState ? 'suspend_user' : 'unsuspend_user';
  logAuditAction(db, adminId, action, 'user', userId, `Admin toggled suspension state for ${user.email}`, ipAddress);

  res.json({ success: true, suspended: !!newSuspendedState });
}));

// Delete user
router.delete('/users/:id', requirePermission('users.suspend'), asyncHandler(async (req, res) => {
  // Cascading deletion would erase financial records and their history.
  res.status(409).json({ error: 'Account deletion is unavailable. Suspend the account while a closure workflow is implemented.' });
}));

// Credit/Debit account
router.post('/users/:id/adjust', requirePermission('adjustments.propose'), (req, res) => {
  res.status(503).json({ error: 'Balance adjustments require the approved ledger workflow. No funds were changed.' });
});

// Freeze/Unfreeze any card
router.put('/cards/:id/freeze', requirePermission('cards.freeze'), asyncHandler(async (req, res) => {
  const cardId = req.params.id;
  const adminId = req.user.id;
  const ipAddress = req.ip || req.connection.remoteAddress;
  
  const card = db.prepare('SELECT frozen, mask, user_id FROM cards WHERE id = ?').get(cardId);
  if (!card) return res.status(404).json({ error: 'Card not found' });

  const newFrozenState = card.frozen ? 0 : 1;
  const newStatus = newFrozenState ? 'Frozen' : 'Active';

  db.prepare('UPDATE cards SET frozen = ?, status = ? WHERE id = ?').run(newFrozenState, newStatus, cardId);

  const action = newFrozenState ? 'freeze_card' : 'unfreeze_card';
  logAuditAction(db, adminId, action, 'card', cardId, `Admin ${newFrozenState ? 'froze' : 'unfroze'} card ${card.mask}`, ipAddress);

  res.json({ success: true, frozen: !!newFrozenState });
}));

// Get audit logs
router.get('/audit', requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const { action, admin_id, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let query = `
    SELECT a.id, a.action, a.target_type, a.target_id, a.details, a.ip_address, a.created_at, u.email as admin_email 
    FROM audit_log a
    JOIN users u ON a.admin_id = u.id
    WHERE 1=1
  `;
  let countQuery = "SELECT COUNT(*) as total FROM audit_log WHERE 1=1";
  const params = [];

  if (action) {
    query += " AND a.action = ?";
    countQuery += " AND action = ?";
    params.push(action);
  }

  if (admin_id) {
    query += " AND a.admin_id = ?";
    countQuery += " AND admin_id = ?";
    params.push(admin_id);
  }

  query += " ORDER BY a.created_at DESC LIMIT ? OFFSET ?";
  
  const total = db.prepare(countQuery).get(...params).total;
  const logs = db.prepare(query).all(...params, limit, offset);

  res.json({ logs, total, page: parseInt(page), limit: parseInt(limit) });
}));

router.use(require('./admin-workspace'));

module.exports = router;
