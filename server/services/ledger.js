const { createHash, randomUUID } = require('node:crypto');
const { ledgerIsReady } = require('../migrations/001_ledger');
const { identityOwnershipReady } = require('../migrations/003_identity_ownership');
const { sharedAccountsReady } = require('../migrations/005_shared_accounts');
const { checkLedgerPosting } = require('./restrictions');

function fail(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function toMinorUnits(input) {
  const text = String(input);
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) fail(400, 'Enter a valid USD amount with at most two decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount <= 0) fail(400, 'Transfer amount must be greater than zero.');
  return amount;
}

function projectionMatches(db, accountId, balanceMinor, legacyBalance) {
  if (legacyBalance !== undefined &&
      (typeof legacyBalance !== 'number' || !Number.isFinite(legacyBalance) ||
       Math.abs(legacyBalance * 100 - balanceMinor) > 0.000001)) return false;
  const posted = db.prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS total
    FROM ledger_postings WHERE account_id = ?`).get(accountId).total;
  return posted === balanceMinor;
}

function receipt(db, journalId, userId) {
  const journal = db.prepare('SELECT reference, sender_balance_after_minor FROM ledger_journals WHERE id = ?').get(journalId);
  const transaction = db.prepare(`SELECT id, type, category, merchant, amount, account, reference, status,
    created_at AS date FROM transactions WHERE journal_id = ? AND user_id = ?`).get(journalId, userId);
  return { transaction, balance: journal.sender_balance_after_minor / 100, reference: journal.reference, demo: true };
}

function internalTransfer(db, { userId, recipient, amount, idempotencyKey }) {
  if (!ledgerIsReady(db)) fail(503, 'Transfers are unavailable until the ledger migration is applied.');
  if (!/^\d{10}$/.test(String(recipient))) fail(400, 'Enter a 10-digit Payvexis account number.');
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
    fail(400, 'A unique transfer request key is required.');
  }
  const amountMinor = toMinorUnits(amount);
  const requestHash = createHash('sha256')
    .update(JSON.stringify([userId, String(recipient), amountMinor])).digest('hex');

  const post = () => {
    const previous = db.prepare(`SELECT id, request_hash FROM ledger_journals
      WHERE requester_user_id = ? AND idempotency_key = ?`).get(userId, idempotencyKey);
    if (previous) {
      if (previous.request_hash !== requestHash) fail(409, 'This request key was already used for a different transfer.');
      return receipt(db, previous.id, userId);
    }

    const source = db.prepare(`SELECT l.id, l.account_number, l.balance_minor, u.balance AS legacy_balance,
      u.suspended AS owner_suspended
      FROM ledger_accounts l JOIN users u ON u.id = l.user_id
      WHERE l.user_id = ? AND l.kind = 'customer'`).get(userId);
    if (!source) fail(404, 'Your account was not found in the ledger.');
    if (source.owner_suspended) fail(403, 'Account owner is suspended.');
    if (identityOwnershipReady(db)) {
      const ownership = db.prepare(`SELECT 1 FROM customer_accounts a
        JOIN account_memberships m ON m.account_id = a.id
        WHERE a.ledger_account_id = ? AND a.status = 'active'
          AND m.user_id = ? AND m.member_role = 'owner' AND m.status = 'active'`)
        .get(source.id, userId);
      if (!ownership) fail(403, 'You are not authorized to transfer from this account.');
    }
    const destination = db.prepare(`SELECT l.id, l.user_id, l.account_number, l.balance_minor,
      u.suspended, u.balance AS legacy_balance
      FROM ledger_accounts l JOIN users u ON u.id = l.user_id
      WHERE l.account_number = ? AND l.kind = 'customer'`).get(recipient);
    if (!destination || destination.suspended) fail(404, 'Recipient account is unavailable.');
    if (identityOwnershipReady(db) && !db.prepare(`SELECT 1 FROM customer_accounts a
      JOIN account_memberships m ON m.account_id = a.id
      WHERE a.ledger_account_id = ? AND a.status = 'active'
        AND m.user_id = ? AND m.member_role = 'owner' AND m.status = 'active'`)
      .get(destination.id, destination.user_id)) {
      fail(409, 'Recipient account ownership requires review.');
    }
    checkLedgerPosting(db, source.id, 'debit');
    checkLedgerPosting(db, destination.id, 'credit');
    if (destination.id === source.id) fail(400, 'Choose a different recipient account.');
    if (!projectionMatches(db, source.id, source.balance_minor, source.legacy_balance) ||
        !projectionMatches(db, destination.id, destination.balance_minor, destination.legacy_balance)) {
      fail(409, 'Account balance requires reconciliation before transfer.');
    }
    if (source.balance_minor < amountMinor) fail(400, 'Insufficient funds for this transfer.');
    const senderAfter = source.balance_minor - amountMinor;
    const recipientAfter = destination.balance_minor + amountMinor;
    if (!Number.isSafeInteger(recipientAfter)) fail(400, 'Recipient balance exceeds supported precision.');

    const reference = `TRF${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
    const journalId = db.prepare(`INSERT INTO ledger_journals
      (reference, kind, requester_user_id, idempotency_key, request_hash, sender_balance_after_minor)
      VALUES (?, 'internal_transfer', ?, ?, ?, ?)`)
      .run(reference, userId, idempotencyKey, requestHash, senderAfter).lastInsertRowid;
    const post = db.prepare('INSERT INTO ledger_postings (journal_id, account_id, amount_minor) VALUES (?, ?, ?)');
    post.run(journalId, source.id, -amountMinor);
    post.run(journalId, destination.id, amountMinor);
    db.prepare('UPDATE ledger_accounts SET balance_minor = ? WHERE id = ?').run(senderAfter, source.id);
    db.prepare('UPDATE ledger_accounts SET balance_minor = ? WHERE id = ?').run(recipientAfter, destination.id);
    // The old balance field remains a read projection while existing screens are migrated.
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(senderAfter / 100, userId);
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(recipientAfter / 100, destination.user_id);
    if (sharedAccountsReady(db)) {
      const accountId = db.prepare('SELECT id FROM customer_accounts WHERE ledger_account_id = ?');
      const senderAccountId = accountId.get(source.id).id;
      const recipientAccountId = accountId.get(destination.id).id;
      const record = db.prepare(`INSERT INTO transactions
        (user_id, type, category, merchant, amount, account, reference, status, journal_id, customer_account_id)
        VALUES (?, ?, 'Transfer', ?, ?, ?, ?, 'Completed', ?, ?)`);
      record.run(userId, 'spend', `To account ****${destination.account_number.slice(-4)}`,
        amountMinor / 100, `****${source.account_number.slice(-4)}`, reference, journalId, senderAccountId);
      record.run(destination.user_id, 'income', `From account ****${source.account_number.slice(-4)}`,
        amountMinor / 100, `****${destination.account_number.slice(-4)}`, reference, journalId, recipientAccountId);
    } else {
      const record = db.prepare(`INSERT INTO transactions
        (user_id, type, category, merchant, amount, account, reference, status, journal_id)
        VALUES (?, ?, 'Transfer', ?, ?, ?, ?, 'Completed', ?)`);
      record.run(userId, 'spend', `To account ****${destination.account_number.slice(-4)}`,
        amountMinor / 100, `****${source.account_number.slice(-4)}`, reference, journalId);
      record.run(destination.user_id, 'income', `From account ****${source.account_number.slice(-4)}`,
        amountMinor / 100, `****${destination.account_number.slice(-4)}`, reference, journalId);
    }

    const total = db.prepare('SELECT SUM(amount_minor) AS total FROM ledger_postings WHERE journal_id = ?').get(journalId).total;
    if (total !== 0) throw new Error('Ledger journal is not balanced.');
    return receipt(db, journalId, userId);
  };
  return db.inTransaction ? post() : db.transaction(post).immediate();
}

module.exports = { internalTransfer, toMinorUnits, projectionMatches };
