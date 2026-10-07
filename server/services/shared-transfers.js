const { createHash } = require('node:crypto');
const { accountForUser } = require('./ownership');
const { toMinorUnits, internalTransfer } = require('./ledger');
const { checkAccountPosting } = require('./restrictions');

function fail(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function requestDetails(db, id) {
  const row = db.prepare(`SELECT r.id, r.account_id AS accountId, r.amount_minor AS amountMinor,
    r.status, r.created_by AS createdBy, r.expires_at AS expiresAt,
    r.created_at AS createdAt, r.decided_at AS decidedAt,
    l.account_number AS recipientNumber, j.reference
    FROM transfer_requests r JOIN customer_accounts a ON a.id = r.recipient_account_id
    JOIN ledger_accounts l ON l.id = a.ledger_account_id
    LEFT JOIN ledger_journals j ON j.id = r.journal_id WHERE r.id = ?`).get(id);
  if (!row) return null;
  const approvals = db.prepare('SELECT COUNT(*) AS n FROM transfer_approvals WHERE request_id = ?').get(id).n;
  return { id: row.id, accountId: row.accountId, amount: row.amountMinor / 100,
    recipientMask: row.recipientNumber.slice(-4), status: row.status,
    createdBy: row.createdBy, approvals, requiredApprovals: 2,
    expiresAt: row.expiresAt, createdAt: row.createdAt, decidedAt: row.decidedAt,
    reference: row.reference, demo: true, fundsReserved: false };
}

function proposeSharedTransfer(db, { actorId, accountId, recipient, amount, idempotencyKey }) {
  if (!Number.isSafeInteger(Number(accountId)) || Number(accountId) <= 0) fail(400, 'Choose a source account.');
  if (!/^\d{10}$/.test(String(recipient))) fail(400, 'Enter a 10-digit Payvexis account number.');
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
    fail(400, 'A unique transfer request key is required.');
  }
  const amountMinor = toMinorUnits(amount);
  return db.transaction(() => {
    const source = accountForUser(db, actorId, accountId);
    if (!source || source.status !== 'active' || !['owner', 'operator'].includes(source.memberRole) ||
        !['joint', 'organization'].includes(source.ownershipKind)) {
      fail(403, 'You cannot propose a transfer from this account.');
    }
    if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND email_verified_at IS NOT NULL').get(actorId)) {
      fail(403, 'Verify your email before signing a shared transfer.');
    }
    const policy = db.prepare('SELECT rule FROM account_signing_policies WHERE account_id = ?').get(source.id);
    if (policy?.rule !== 'two_signers') fail(409, 'Shared signing policy is unavailable.');
    const destination = db.prepare(`SELECT a.id, l.account_number FROM customer_accounts a
      JOIN ledger_accounts l ON l.id = a.ledger_account_id
      JOIN users u ON u.id = l.user_id
      WHERE l.account_number = ? AND a.status = 'active' AND u.suspended = 0`).get(recipient);
    if (!destination || destination.id === source.id) fail(400, 'Choose a different available recipient.');
    const requestHash = createHash('sha256').update(JSON.stringify([
      source.id, destination.id, amountMinor
    ])).digest('hex');
    const previous = db.prepare(`SELECT id, request_hash FROM transfer_requests
      WHERE created_by = ? AND idempotency_key = ?`).get(actorId, idempotencyKey);
    if (previous) {
      if (previous.request_hash !== requestHash) fail(409, 'Request key was already used for a different transfer.');
      return requestDetails(db, previous.id);
    }
    checkAccountPosting(db, source.id, 'debit');
    checkAccountPosting(db, destination.id, 'credit');
    if (source.balanceMinor < amountMinor) {
      fail(400, 'Insufficient funds for this transfer.');
    }
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const id = db.prepare(`INSERT INTO transfer_requests
      (account_id, recipient_account_id, amount_minor, request_hash, idempotency_key,
       created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(source.id, destination.id, amountMinor, requestHash, idempotencyKey,
        actorId, expiresAt).lastInsertRowid;
    db.prepare(`INSERT INTO transfer_approvals (request_id, user_id, role_at_approval)
      VALUES (?, ?, ?)`).run(id, actorId, source.memberRole);
    db.prepare(`INSERT INTO account_events (account_id, actor_user_id, event_type, details)
      VALUES (?, ?, 'transfer_proposed', ?)`).run(source.id, actorId, String(id));
    return requestDetails(db, id);
  }).immediate();
}

function decideSharedTransfer(db, { actorId, requestId, decision }) {
  if (!Number.isSafeInteger(Number(requestId)) || Number(requestId) <= 0) fail(400, 'Invalid transfer request.');
  if (!['approve', 'reject'].includes(decision)) fail(400, 'Invalid decision.');
  return db.transaction(() => {
    const request = db.prepare(`SELECT r.*, a.ownership_kind, a.status AS account_status,
      l.user_id AS primary_owner_id, d.account_number AS recipient_number
      FROM transfer_requests r JOIN customer_accounts a ON a.id = r.account_id
      JOIN ledger_accounts l ON l.id = a.ledger_account_id
      JOIN customer_accounts dest ON dest.id = r.recipient_account_id
      JOIN ledger_accounts d ON d.id = dest.ledger_account_id WHERE r.id = ?`).get(Number(requestId));
    if (!request) fail(404, 'Transfer request not found.');
    const policy = db.prepare('SELECT rule FROM account_signing_policies WHERE account_id = ?')
      .get(request.account_id);
    if (!['joint', 'organization'].includes(request.ownership_kind) ||
        policy?.rule !== 'two_signers') fail(409, 'Shared signing policy requires review.');
    const membership = accountForUser(db, actorId, request.account_id);
    if (!membership || membership.status !== 'active' ||
        !['owner', 'operator'].includes(membership.memberRole)) fail(403, 'You cannot sign this transfer.');
    if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND email_verified_at IS NOT NULL').get(actorId)) {
      fail(403, 'Verify your email before signing a shared transfer.');
    }
    if (request.status !== 'pending') return requestDetails(db, request.id);
    if (Date.parse(request.expires_at) <= Date.now()) {
      db.prepare("UPDATE transfer_requests SET status = 'expired', decided_at = datetime('now') WHERE id = ?")
        .run(request.id);
      return requestDetails(db, request.id);
    }
    if (decision === 'reject') {
      db.prepare("UPDATE transfer_requests SET status = 'rejected', decided_at = datetime('now') WHERE id = ?")
        .run(request.id);
      db.prepare(`INSERT INTO account_events (account_id, actor_user_id, event_type, details)
        VALUES (?, ?, 'transfer_rejected', ?)`).run(request.account_id, actorId, String(request.id));
      return requestDetails(db, request.id);
    }
    if (db.prepare('SELECT 1 FROM transfer_approvals WHERE request_id = ? AND user_id = ?')
      .get(request.id, actorId)) return requestDetails(db, request.id);
    const proposer = accountForUser(db, request.created_by, request.account_id);
    if (!proposer || !['owner', 'operator'].includes(proposer.memberRole)) {
      fail(409, 'The proposer no longer has signing access.');
    }
    db.prepare(`INSERT INTO transfer_approvals (request_id, user_id, role_at_approval)
      VALUES (?, ?, ?)`).run(request.id, actorId, membership.memberRole);
    const signers = db.prepare(`SELECT m.member_role AS role FROM transfer_approvals p
      JOIN account_memberships m ON m.account_id = ? AND m.user_id = p.user_id
      WHERE p.request_id = ? AND m.status = 'active' AND m.member_role IN ('owner', 'operator')`)
      .all(request.account_id, request.id);
    if (signers.length >= 2 && signers.some(signer => signer.role === 'owner')) {
      if (request.account_status !== 'active') fail(409, 'Account is unavailable.');
      checkAccountPosting(db, request.account_id, 'debit');
      checkAccountPosting(db, request.recipient_account_id, 'credit');
      const receipt = internalTransfer(db, {
        userId: request.primary_owner_id, recipient: request.recipient_number,
        amount: (request.amount_minor / 100).toFixed(2),
        idempotencyKey: `shared_request_${request.id}`
      });
      const journal = db.prepare('SELECT id FROM ledger_journals WHERE reference = ?').get(receipt.reference);
      db.prepare(`UPDATE transfer_requests SET status = 'posted', journal_id = ?,
        decided_at = datetime('now') WHERE id = ?`).run(journal.id, request.id);
      db.prepare(`INSERT INTO account_events (account_id, actor_user_id, event_type, details)
        VALUES (?, ?, 'transfer_posted', ?)`).run(request.account_id, actorId, String(request.id));
    }
    return requestDetails(db, request.id);
  }).immediate();
}

module.exports = { proposeSharedTransfer, decideSharedTransfer, requestDetails };
