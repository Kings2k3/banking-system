const express = require('express');
const { db } = require('../database');
const { asyncHandler, formatMoney } = require('../utils/helpers');
const auth = require('../middleware/auth');
const config = require('../config');
const { ledgerIsReady } = require('../migrations/001_ledger');
const { internalTransfer } = require('../services/ledger');
const { sharedAccountsReady } = require('../migrations/005_shared_accounts');
const { customerIdentityReady } = require('../migrations/004_customer_identity');
const { accountsForUser, accountForUser } = require('../services/ownership');
const { proposeSharedTransfer, decideSharedTransfer, requestDetails } = require('../services/shared-transfers');

const router = express.Router();

// All transaction routes require auth
router.use(auth);
router.use((req, res, next) => {
  if (req.user.role !== 'user') return res.status(403).json({ error: 'Customer access required.' });
  next();
});

function selectedAccount(req) {
  if (!sharedAccountsReady(db)) return null;
  const requestedId = req.query.accountId !== undefined ? req.query.accountId : req.body?.accountId;
  return requestedId !== undefined
    ? accountForUser(db, req.user.id, requestedId)
    : accountsForUser(db, req.user.id)?.[0];
}

// Get transactions with optional filtering/search
router.get('/', asyncHandler(async (req, res) => {
  const { type, search } = req.query;
  const userId = req.user.id;

  const shared = sharedAccountsReady(db);
  const account = req.query.accountId ? selectedAccount(req) : null;
  if (shared && req.query.accountId && !account) return res.status(404).json({ error: 'Account not found.' });
  let query = `SELECT id, type, category, merchant, amount, account, reference,
    status, created_at as date FROM transactions WHERE `;
  const params = [];
  if (account) {
    query += 'customer_account_id = ?';
    params.push(account.id);
  } else if (shared) {
    query += `customer_account_id IN (SELECT account_id FROM account_memberships
      WHERE user_id = ? AND status = 'active')`;
    params.push(userId);
  } else {
    query += 'user_id = ?';
    params.push(userId);
  }

  if (type && type !== 'all') {
    query += ' AND type = ?';
    params.push(type);
  }

  if (search) {
    query += ' AND (merchant LIKE ? OR category LIKE ? OR reference LIKE ?)';
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern, searchPattern);
  }

  query += ' ORDER BY created_at DESC LIMIT 50';

  const transactions = db.prepare(query).all(...params);
  res.json({ transactions });
}));

router.get('/capabilities', (req, res) => {
  res.json({ demoInternalTransfersEnabled: config.DEMO_INTERNAL_TRANSFERS && ledgerIsReady(db),
    sharedApprovalEnabled: config.DEMO_INTERNAL_TRANSFERS && sharedAccountsReady(db) });
});

router.get('/transfer-requests', (req, res) => {
  if (!sharedAccountsReady(db)) return res.status(503).json({ error: 'Shared transfers are unavailable.' });
  const ids = db.prepare(`SELECT r.id FROM transfer_requests r
    JOIN account_memberships m ON m.account_id = r.account_id
    WHERE m.user_id = ? AND m.status = 'active'
    ORDER BY r.id DESC LIMIT 50`).all(req.user.id);
  res.json({ requests: ids.map(row => requestDetails(db, row.id)) });
});

router.post('/transfer-requests/:id/approve', asyncHandler(async (req, res) => {
  if (!config.DEMO_INTERNAL_TRANSFERS || !sharedAccountsReady(db)) {
    return res.status(503).json({ error: 'Demo shared transfers are unavailable.' });
  }
  res.json({ request: decideSharedTransfer(db, {
    actorId: req.user.id, requestId: req.params.id, decision: 'approve'
  }) });
}));

router.post('/transfer-requests/:id/reject', asyncHandler(async (req, res) => {
  if (!config.DEMO_INTERNAL_TRANSFERS || !sharedAccountsReady(db)) {
    return res.status(503).json({ error: 'Demo shared transfers are unavailable.' });
  }
  res.json({ request: decideSharedTransfer(db, {
    actorId: req.user.id, requestId: req.params.id, decision: 'reject'
  }) });
}));

// Internal account transfers are available in explicitly enabled local demos.
router.post('/transfer', asyncHandler(async (req, res) => {
  if (!config.DEMO_INTERNAL_TRANSFERS) {
    return res.status(503).json({ error: 'Transfers are unavailable in this environment. No funds were moved.' });
  }
  if (customerIdentityReady(db) && !db.prepare(`SELECT 1 FROM users
    WHERE id = ? AND email_verified_at IS NOT NULL`).get(req.user.id)) {
    return res.status(403).json({ error: 'Verify your email before making a transfer.' });
  }
  if (sharedAccountsReady(db)) {
    const account = selectedAccount(req);
    if (!account) return res.status(404).json({ error: 'Source account not found.' });
    if (['joint', 'business'].includes(account.requestedType) && account.ownershipKind === 'individual') {
      return res.status(409).json({ error: 'Complete shared account setup before transferring.' });
    }
    const policy = db.prepare('SELECT rule FROM account_signing_policies WHERE account_id = ?')
      .get(account.id);
    if (!policy || (account.ownershipKind === 'individual' && policy.rule !== 'single_owner') ||
        (['joint', 'organization'].includes(account.ownershipKind) && policy.rule !== 'two_signers')) {
      return res.status(409).json({ error: 'Account signing policy requires review.' });
    }
    if (['joint', 'organization'].includes(account.ownershipKind)) {
      const request = proposeSharedTransfer(db, {
        actorId: req.user.id, accountId: account.id,
        recipient: req.body?.recipient, amount: req.body?.amount,
        idempotencyKey: req.get('Idempotency-Key')
      });
      return res.status(202).json({ request });
    }
    if (account.memberRole !== 'owner') return res.status(403).json({ error: 'Transfer access is unavailable.' });
  }
  const result = internalTransfer(db, {
    userId: req.user.id,
    recipient: req.body.recipient,
    amount: req.body.amount,
    idempotencyKey: req.get('Idempotency-Key')
  });
  res.json(result);
}));

// Generate text statement
router.get('/statement', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const account = selectedAccount(req);
  if (sharedAccountsReady(db) && !account) return res.status(404).json({ error: 'Account not found.' });
  const user = db.prepare('SELECT first_name, last_name, account_number, balance FROM users WHERE id = ?').get(userId);
  const transactions = account
    ? db.prepare(`SELECT type, merchant, amount, created_at AS date FROM transactions
      WHERE customer_account_id = ? ORDER BY created_at DESC LIMIT 30`).all(account.id)
    : db.prepare(`SELECT type, merchant, amount, created_at AS date FROM transactions
      WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`).all(userId);

  let statement = `PAYVEXIS ACCOUNT STATEMENT\n`;
  statement += `==========================\n\n`;
  statement += `Account Holder : ${user.first_name} ${user.last_name}\n`;
  statement += `Account Number : ${account?.accountNumber || user.account_number}\n`;
  statement += `Current Balance: ${formatMoney(account ? account.balanceMinor / 100 : user.balance)}\n`;
  statement += `Date Generated : ${new Date().toLocaleDateString('en-US')}\n\n`;
  statement += `RECENT TRANSACTIONS\n`;
  statement += `--------------------------------------------------\n`;
  statement += `DATE       | DESCRIPTION                  | AMOUNT\n`;
  statement += `--------------------------------------------------\n`;

  if (transactions.length === 0) {
    statement += `No recent transactions found.\n`;
  } else {
    transactions.forEach(tx => {
      const date = tx.date.split(' ')[0]; // Just the YYYY-MM-DD
      const desc = tx.merchant.padEnd(28, ' ').substring(0, 28);
      const sign = tx.type === 'income' ? '+' : '-';
      const amount = `${sign}${formatMoney(tx.amount)}`.padStart(10, ' ');
      statement += `${date} | ${desc} | ${amount}\n`;
    });
  }

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="Payvexis_Statement_${(account?.accountNumber || user.account_number).slice(-4)}.txt"`);
  res.send(statement);
}));

module.exports = router;
