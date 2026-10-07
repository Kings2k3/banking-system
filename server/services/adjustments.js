const { createHash, randomUUID } = require('node:crypto');
const { adminControlsReady } = require('../migrations/002_admin_controls');
const { identityOwnershipReady } = require('../migrations/003_identity_ownership');
const { sharedAccountsReady } = require('../migrations/005_shared_accounts');
const { toMinorUnits, projectionMatches } = require('./ledger');
const { checkLedgerPosting } = require('./restrictions');
const { logAuditAction } = require('../utils/helpers');

const MAX_ADJUSTMENT_MINOR = 1_000_000; // USD 10,000 per decision in this first workflow.

function fail(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function getRequest(db, id) {
  return db.prepare(`SELECT a.id, a.user_id AS userId, a.direction, a.amount_minor AS amountMinor,
    a.reason, a.sender_name AS senderName, a.status, a.proposed_by AS proposedBy,
    a.decided_by AS decidedBy, a.decision_note AS decisionNote, a.journal_id AS journalId,
    a.created_at AS createdAt, a.decided_at AS decidedAt,
    u.email AS customerEmail, p.email AS proposerEmail, d.email AS approverEmail,
    j.reference AS journalReference
    FROM adjustment_requests a
    JOIN users u ON u.id = a.user_id
    JOIN users p ON p.id = a.proposed_by
    LEFT JOIN users d ON d.id = a.decided_by
    LEFT JOIN ledger_journals j ON j.id = a.journal_id
    WHERE a.id = ?`).get(id);
}

function proposeAdjustment(db, { actorId, userId, direction, amount, reason, senderName, idempotencyKey, ip }) {
  if (!adminControlsReady(db)) fail(503, 'Apply the admin controls migration before proposing adjustments.');
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) fail(400, 'Choose a customer account.');
  if (!['credit', 'debit'].includes(direction)) fail(400, 'Choose credit or debit.');
  const amountMinor = toMinorUnits(amount);
  if (amountMinor > MAX_ADJUSTMENT_MINOR) fail(400, 'This workflow is limited to USD 10,000 per adjustment.');
  const cleanReason = typeof reason === 'string' ? reason.trim() : '';
  const cleanSender = typeof senderName === 'string' ? senderName.trim() : '';
  if (cleanReason.length < 10 || cleanReason.length > 500 || cleanSender.length > 120) {
    fail(400, 'Provide a reason of 10 to 500 characters and a sender name under 120 characters.');
  }
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
    fail(400, 'A unique adjustment request key is required.');
  }
  const targetId = Number(userId);
  const requestHash = createHash('sha256').update(JSON.stringify([
    targetId, direction, amountMinor, cleanReason, cleanSender
  ])).digest('hex');

  return db.transaction(() => {
    const previous = db.prepare(`SELECT id, request_hash FROM adjustment_requests
      WHERE proposed_by = ? AND idempotency_key = ?`).get(actorId, idempotencyKey);
    if (previous) {
      if (previous.request_hash !== requestHash) fail(409, 'This request key was already used for a different proposal.');
      return getRequest(db, previous.id);
    }
    const target = db.prepare(`SELECT u.id, l.id AS ledger_id, l.balance_minor, u.balance
      FROM users u JOIN ledger_accounts l ON l.user_id = u.id AND l.kind = 'customer'
      WHERE u.id = ? AND u.role = 'user'`).get(targetId);
    if (!target) fail(404, 'Customer account not found in the ledger.');
    if (identityOwnershipReady(db) && !db.prepare(`SELECT 1 FROM customer_accounts a
      JOIN account_memberships m ON m.account_id = a.id
      WHERE a.ledger_account_id = ? AND m.user_id = ?
        AND m.member_role = 'owner' AND m.status = 'active'`).get(target.ledger_id, targetId)) {
      fail(409, 'Customer account ownership requires review.');
    }
    if (!projectionMatches(db, target.ledger_id, target.balance_minor, target.balance)) {
      fail(409, 'Account balance requires reconciliation before an adjustment.');
    }
    const id = db.prepare(`INSERT INTO adjustment_requests
      (user_id, direction, amount_minor, reason, sender_name, proposed_by, idempotency_key, request_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(targetId, direction, amountMinor, cleanReason, cleanSender, actorId, idempotencyKey, requestHash).lastInsertRowid;
    logAuditAction(db, actorId, 'adjustment_proposed', 'adjustment', id,
      `${direction} ${amountMinor} USD cents for user ${targetId}; reason: ${cleanReason}`, ip || '');
    return getRequest(db, id);
  }).immediate();
}

function decideAdjustment(db, { actorId, requestId, decision, note, ip }) {
  if (!adminControlsReady(db)) fail(503, 'Apply the admin controls migration before deciding adjustments.');
  if (!Number.isSafeInteger(Number(requestId)) || Number(requestId) <= 0) fail(400, 'Invalid adjustment ID.');
  if (!['approve', 'reject'].includes(decision)) fail(400, 'Choose approve or reject.');
  const cleanNote = typeof note === 'string' ? note.trim() : '';
  if (cleanNote.length > 500 || (decision === 'reject' && cleanNote.length < 5)) {
    fail(400, 'A rejection needs a reason of at least 5 characters; notes may not exceed 500.');
  }

  return db.transaction(() => {
    const proposal = db.prepare('SELECT * FROM adjustment_requests WHERE id = ?').get(Number(requestId));
    if (!proposal) fail(404, 'Adjustment proposal not found.');
    if (proposal.proposed_by === actorId) fail(403, 'The proposer cannot decide their own adjustment.');
    if (proposal.status !== 'pending') {
      if (proposal.decided_by === actorId &&
          proposal.status === (decision === 'approve' ? 'approved' : 'rejected')) return getRequest(db, proposal.id);
      fail(409, 'This adjustment has already been decided.');
    }

    let journalId = null;
    if (decision === 'approve') {
      const target = db.prepare(`SELECT l.id, l.balance_minor, l.account_number, u.balance
        FROM ledger_accounts l JOIN users u ON u.id = l.user_id
        WHERE l.user_id = ? AND l.kind = 'customer' AND u.role = 'user'`).get(proposal.user_id);
      const clearing = db.prepare("SELECT id, balance_minor FROM ledger_accounts WHERE kind = 'adjustment_clearing'").get();
      if (!target || !clearing) fail(409, 'Ledger account is unavailable.');
      if (identityOwnershipReady(db) && !db.prepare(`SELECT 1 FROM customer_accounts a
        JOIN account_memberships m ON m.account_id = a.id
        WHERE a.ledger_account_id = ? AND a.status = 'active'
          AND m.user_id = ? AND m.member_role = 'owner' AND m.status = 'active'`)
        .get(target.id, proposal.user_id)) {
        fail(409, 'Customer account ownership requires review.');
      }
      checkLedgerPosting(db, target.id, proposal.direction);
      if (!projectionMatches(db, target.id, target.balance_minor, target.balance) ||
          !projectionMatches(db, clearing.id, clearing.balance_minor)) {
        fail(409, 'Account balance requires reconciliation before approval.');
      }
      const delta = proposal.direction === 'credit' ? proposal.amount_minor : -proposal.amount_minor;
      const targetAfter = target.balance_minor + delta;
      const clearingAfter = clearing.balance_minor - delta;
      if (targetAfter < 0) fail(400, 'Insufficient funds for this debit adjustment.');
      if (!Number.isSafeInteger(targetAfter) || !Number.isSafeInteger(clearingAfter)) {
        fail(400, 'Adjustment exceeds supported balance precision.');
      }
      const reference = `ADJ${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
      journalId = db.prepare(`INSERT INTO ledger_journals (reference, kind, requester_user_id)
        VALUES (?, 'admin_adjustment', ?)`).run(reference, proposal.proposed_by).lastInsertRowid;
      const post = db.prepare('INSERT INTO ledger_postings (journal_id, account_id, amount_minor) VALUES (?, ?, ?)');
      post.run(journalId, target.id, delta);
      post.run(journalId, clearing.id, -delta);
      db.prepare('UPDATE ledger_accounts SET balance_minor = ? WHERE id = ?').run(targetAfter, target.id);
      db.prepare('UPDATE ledger_accounts SET balance_minor = ? WHERE id = ?').run(clearingAfter, clearing.id);
      db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(targetAfter / 100, proposal.user_id);
      if (sharedAccountsReady(db)) {
        const accountId = db.prepare('SELECT id FROM customer_accounts WHERE ledger_account_id = ?').get(target.id).id;
        db.prepare(`INSERT INTO transactions
          (user_id, type, category, merchant, amount, account, reference, status, journal_id, customer_account_id)
          VALUES (?, ?, 'Admin Adjustment', ?, ?, ?, ?, 'Completed', ?, ?)`)
          .run(proposal.user_id, delta > 0 ? 'income' : 'spend',
            proposal.sender_name || proposal.reason, proposal.amount_minor / 100,
            `****${target.account_number.slice(-4)}`, reference, journalId, accountId);
      } else {
        db.prepare(`INSERT INTO transactions
          (user_id, type, category, merchant, amount, account, reference, status, journal_id)
          VALUES (?, ?, 'Admin Adjustment', ?, ?, ?, ?, 'Completed', ?)`)
          .run(proposal.user_id, delta > 0 ? 'income' : 'spend',
            proposal.sender_name || proposal.reason, proposal.amount_minor / 100,
            `****${target.account_number.slice(-4)}`, reference, journalId);
      }
      const total = db.prepare('SELECT SUM(amount_minor) AS total FROM ledger_postings WHERE journal_id = ?').get(journalId).total;
      if (total !== 0) throw new Error('Adjustment journal is not balanced.');
    }

    db.prepare(`UPDATE adjustment_requests SET status = ?, decided_by = ?, decided_at = datetime('now'),
      decision_note = ?, journal_id = ? WHERE id = ?`)
      .run(decision === 'approve' ? 'approved' : 'rejected', actorId, cleanNote, journalId, proposal.id);
    logAuditAction(db, actorId, decision === 'approve' ? 'adjustment_approved' : 'adjustment_rejected',
      'adjustment', proposal.id, `Proposal ${proposal.id}; ${cleanNote || decision}`, ip || '');
    return getRequest(db, proposal.id);
  }).immediate();
}

module.exports = { proposeAdjustment, decideAdjustment, getRequest, MAX_ADJUSTMENT_MINOR };
