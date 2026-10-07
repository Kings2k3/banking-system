const express = require('express');
const { db } = require('../database');
const { requirePermission } = require('../services/staff');
const { logAuditAction } = require('../utils/helpers');
const { adminWorkspaceReady } = require('../migrations/006_admin_workspace');

const router = express.Router();

function requireWorkspace(req, res, next) {
  if (!adminWorkspaceReady(db)) {
    return res.status(503).json({ error: 'Apply the admin workspace migration first.' });
  }
  next();
}

function customer(id) {
  const number = Number(id);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return db.prepare("SELECT id, email FROM users WHERE id = ? AND role = 'user'").get(number);
}

function account(id) {
  const number = Number(id);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return db.prepare(`SELECT a.id, a.display_name AS name, a.ownership_kind AS ownershipKind,
    a.status, l.balance_minor AS balanceMinor, l.currency,
    substr(l.account_number, -4) AS mask
    FROM customer_accounts a JOIN ledger_accounts l ON l.id = a.ledger_account_id
    WHERE a.id = ?`).get(number);
}

router.get('/users/:id/workspace', requirePermission('users.read'), requireWorkspace, (req, res) => {
  const person = customer(req.params.id);
  if (!person) return res.status(404).json({ error: 'Customer not found.' });
  const accounts = db.prepare(`SELECT a.id, a.display_name AS name, a.ownership_kind AS ownershipKind,
    a.status, m.member_role AS memberRole, l.balance_minor AS balanceMinor, l.currency,
    substr(l.account_number, -4) AS mask,
    COALESCE(r.debit_blocked, 0) AS debitBlocked,
    COALESCE(r.credit_blocked, 0) AS creditBlocked,
    COALESCE(r.reason, '') AS restrictionReason, r.updated_at AS restrictionUpdatedAt
    FROM account_memberships m JOIN customer_accounts a ON a.id = m.account_id
    JOIN ledger_accounts l ON l.id = a.ledger_account_id
    LEFT JOIN account_restrictions r ON r.account_id = a.id
    WHERE m.user_id = ? AND m.status = 'active' ORDER BY a.id`).all(person.id);
  const memberQuery = db.prepare(`SELECT m.user_id AS userId, m.member_role AS role,
    m.status, u.email, u.first_name AS firstName, u.last_name AS lastName,
    u.email_verified_at AS emailVerifiedAt
    FROM account_memberships m JOIN users u ON u.id = m.user_id
    WHERE m.account_id = ? ORDER BY m.user_id`);
  for (const item of accounts) item.members = memberQuery.all(item.id);
  const accountIds = accounts.map(item => item.id);
  const recentActivity = accountIds.length ? db.prepare(`SELECT t.id, t.customer_account_id AS accountId,
    t.type, t.merchant, t.amount, t.reference, t.status, t.created_at AS createdAt
    FROM transactions t WHERE t.customer_account_id IN (${accountIds.map(() => '?').join(',')})
    ORDER BY t.id DESC LIMIT 30`).all(...accountIds) : [];
  const recentAccountEvents = accountIds.length ? db.prepare(`SELECT id, account_id AS accountId,
    actor_user_id AS actorUserId, event_type AS type, details, created_at AS createdAt
    FROM account_events WHERE account_id IN (${accountIds.map(() => '?').join(',')})
    ORDER BY id DESC LIMIT 30`).all(...accountIds) : [];
  const notes = req.staff.permissions.includes('users.notes.read') ? db.prepare(`SELECT n.id,
    n.body, n.created_at AS createdAt, u.email AS authorEmail
    FROM customer_notes n JOIN users u ON u.id = n.staff_user_id
    WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 30`).all(person.id) : [];
  const now = new Date().toISOString();
  const activeCount = db.prepare(`SELECT COUNT(*) AS n FROM auth_sessions
    WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`).get(person.id, now).n;
  const activeSessions = db.prepare(`SELECT created_at AS createdAt, expires_at AS expiresAt
    FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC LIMIT 10`).all(person.id, now);
  res.json({ customer: person, accounts, recentActivity, recentAccountEvents, notes,
    sessions: { activeCount, recent: activeSessions } });
});

router.post('/users/:id/notes', requirePermission('users.notes.write'), requireWorkspace, (req, res) => {
  const person = customer(req.params.id);
  if (!person) return res.status(404).json({ error: 'Customer not found.' });
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (body.length < 3 || body.length > 2000) {
    return res.status(400).json({ error: 'Note must be 3 to 2000 characters.' });
  }
  const id = db.transaction(() => {
    const result = db.prepare(`INSERT INTO customer_notes (user_id, staff_user_id, body)
      VALUES (?, ?, ?)`).run(person.id, req.user.id, body);
    logAuditAction(db, req.user.id, 'customer_note_added', 'user', person.id,
      `Note ${result.lastInsertRowid} added`, req.ip || '');
    return result.lastInsertRowid;
  }).immediate();
  res.status(201).json({ id });
});

router.post('/users/:id/sessions/revoke', requirePermission('users.sessions.revoke'),
  requireWorkspace, (req, res) => {
    const person = customer(req.params.id);
    if (!person) return res.status(404).json({ error: 'Customer not found.' });
    const revoked = db.transaction(() => {
      const result = db.prepare(`UPDATE auth_sessions SET revoked_at = datetime('now')
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`)
        .run(person.id, new Date().toISOString());
      logAuditAction(db, req.user.id, 'customer_sessions_revoked', 'user', person.id,
        `Revoked ${result.changes} sessions`, req.ip || '');
      return result.changes;
    }).immediate();
    res.json({ revoked });
  });

router.patch('/accounts/:id/restrictions', requirePermission('users.restrict'),
  requireWorkspace, (req, res) => {
    const target = account(req.params.id);
    if (!target) return res.status(404).json({ error: 'Account not found.' });
    const { debitBlocked, creditBlocked } = req.body || {};
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (typeof debitBlocked !== 'boolean' || typeof creditBlocked !== 'boolean' ||
        reason.length < 10 || reason.length > 300) {
      return res.status(400).json({ error: 'Choose both restrictions and provide a reason of 10 to 300 characters.' });
    }
    db.transaction(() => {
      db.prepare(`INSERT INTO account_restrictions
        (account_id, debit_blocked, credit_blocked, reason, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(account_id) DO UPDATE SET debit_blocked = excluded.debit_blocked,
          credit_blocked = excluded.credit_blocked, reason = excluded.reason,
          updated_by = excluded.updated_by, updated_at = datetime('now')`)
        .run(target.id, debitBlocked ? 1 : 0, creditBlocked ? 1 : 0, reason, req.user.id);
      logAuditAction(db, req.user.id, 'account_restrictions_changed', 'account', target.id,
        `Debit blocked: ${debitBlocked}; credit blocked: ${creditBlocked}; reason: ${reason}`, req.ip || '');
    }).immediate();
    res.json({ accountId: target.id, debitBlocked, creditBlocked, reason });
  });

const OPERATION_SQL = `
  SELECT 'shared_transfer' AS type, r.id, l.user_id AS customerId,
    u.email AS customerEmail, r.account_id AS accountId,
    r.amount_minor AS amountMinor, 'debit' AS direction,
    CASE WHEN r.status = 'pending' AND strftime('%s', r.expires_at) <= strftime('%s', 'now')
      THEN 'expired' ELSE r.status END AS financialStatus,
    r.created_at AS createdAt, j.reference AS reference, r.expires_at AS expiresAt,
    r.created_by AS requestedBy
  FROM transfer_requests r JOIN customer_accounts a ON a.id = r.account_id
  JOIN ledger_accounts l ON l.id = a.ledger_account_id
  JOIN users u ON u.id = l.user_id
  LEFT JOIN ledger_journals j ON j.id = r.journal_id
  UNION ALL
  SELECT 'adjustment', r.id, r.user_id, u.email, a.id, r.amount_minor,
    r.direction, r.status, r.created_at, j.reference, NULL, r.proposed_by
  FROM adjustment_requests r JOIN users u ON u.id = r.user_id
  JOIN ledger_accounts l ON l.user_id = u.id AND l.kind = 'customer'
  JOIN customer_accounts a ON a.ledger_account_id = l.id
  LEFT JOIN ledger_journals j ON j.id = r.journal_id`;

function operation(type, id) {
  const number = Number(id);
  if (!['shared_transfer', 'adjustment'].includes(type) ||
      !Number.isSafeInteger(number) || number <= 0) return null;
  return db.prepare(`SELECT o.*, COALESCE(v.state, 'unreviewed') AS reviewState,
    v.updated_at AS reviewUpdatedAt FROM (${OPERATION_SQL}) o
    LEFT JOIN operation_reviews v ON v.operation_type = o.type AND v.operation_id = o.id
    WHERE o.type = ? AND o.id = ?`).get(type, number);
}

router.get('/operations', requirePermission('operations.read'), requireWorkspace, (req, res) => {
  const type = ['shared_transfer', 'adjustment'].includes(req.query.type) ? req.query.type : null;
  const status = ['pending', 'posted', 'approved', 'rejected', 'expired'].includes(req.query.status)
    ? req.query.status : null;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const clauses = [];
  const params = [];
  if (type) { clauses.push('o.type = ?'); params.push(type); }
  if (status) { clauses.push('o.financialStatus = ?'); params.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const from = `FROM (${OPERATION_SQL}) o LEFT JOIN operation_reviews v
    ON v.operation_type = o.type AND v.operation_id = o.id ${where}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params).n;
  const operations = db.prepare(`SELECT o.*, COALESCE(v.state, 'unreviewed') AS reviewState
    ${from} ORDER BY o.createdAt DESC, o.type DESC, o.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, (page - 1) * limit);
  res.json({ operations, total, page, limit });
});

router.get('/operations/:type/:id', requirePermission('operations.read'), requireWorkspace,
  (req, res) => {
    const item = operation(req.params.type, req.params.id);
    if (!item) return res.status(404).json({ error: 'Operation not found.' });
    const events = db.prepare(`SELECT e.id, e.state, e.note, e.created_at AS createdAt,
      u.email AS staffEmail FROM operation_review_events e
      JOIN users u ON u.id = e.staff_user_id
      WHERE e.operation_type = ? AND e.operation_id = ? ORDER BY e.id DESC`)
      .all(item.type, item.id);
    const approvals = item.type === 'shared_transfer' ? db.prepare(`SELECT p.user_id AS userId,
      p.role_at_approval AS role, p.created_at AS createdAt, u.email
      FROM transfer_approvals p JOIN users u ON u.id = p.user_id
      WHERE p.request_id = ? ORDER BY p.created_at, p.user_id`).all(item.id) : [];
    res.json({ operation: item, reviewEvents: events, approvals });
  });

router.post('/operations/:type/:id/review', requirePermission('operations.review'),
  requireWorkspace, (req, res) => {
    const item = operation(req.params.type, req.params.id);
    if (!item) return res.status(404).json({ error: 'Operation not found.' });
    const state = req.body?.state;
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!['investigating', 'resolved'].includes(state) || note.length < 10 || note.length > 1000) {
      return res.status(400).json({ error: 'Choose a review state and provide a note of 10 to 1000 characters.' });
    }
    db.transaction(() => {
      db.prepare(`INSERT INTO operation_reviews (operation_type, operation_id, state, updated_by, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(operation_type, operation_id) DO UPDATE SET state = excluded.state,
          updated_by = excluded.updated_by, updated_at = datetime('now')`)
        .run(item.type, item.id, state, req.user.id);
      db.prepare(`INSERT INTO operation_review_events
        (operation_type, operation_id, state, note, staff_user_id) VALUES (?, ?, ?, ?, ?)`)
        .run(item.type, item.id, state, note, req.user.id);
      logAuditAction(db, req.user.id, 'operation_review_updated', item.type, item.id,
        `Review state: ${state}`, req.ip || '');
    }).immediate();
    res.json({ operation: operation(item.type, item.id) });
  });

module.exports = router;
