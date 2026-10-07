const { adminWorkspaceReady } = require('../migrations/006_admin_workspace');

function checkAccountPosting(db, accountId, direction) {
  if (!adminWorkspaceReady(db)) return;
  const row = db.prepare(`SELECT a.status, r.debit_blocked AS debitBlocked,
    r.credit_blocked AS creditBlocked
    FROM customer_accounts a LEFT JOIN account_restrictions r ON r.account_id = a.id
    WHERE a.id = ?`).get(accountId);
  if (!row || row.status !== 'active') {
    const error = new Error('Account is unavailable.'); error.statusCode = 409; throw error;
  }
  if ((direction === 'debit' && row.debitBlocked) ||
      (direction === 'credit' && row.creditBlocked)) {
    const error = new Error(direction === 'debit'
      ? 'Debits are restricted on this account.' : 'Credits are restricted on the recipient account.');
    error.statusCode = 409;
    throw error;
  }
}

function checkLedgerPosting(db, ledgerAccountId, direction) {
  if (!adminWorkspaceReady(db)) return;
  const account = db.prepare('SELECT id FROM customer_accounts WHERE ledger_account_id = ?')
    .get(ledgerAccountId);
  if (!account) {
    const error = new Error('Customer account requires review.'); error.statusCode = 409; throw error;
  }
  checkAccountPosting(db, account.id, direction);
}

module.exports = { checkAccountPosting, checkLedgerPosting };
