const { customerIdentityReady } = require('./004_customer_identity');

const VERSION = '005_shared_accounts';

function sharedAccountsReady(db) {
  if (db.engine === 'postgres') return db.migrationsReady;
  return customerIdentityReady(db) && !!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(VERSION);
}

function migrateSharedAccounts(db) {
  if (!customerIdentityReady(db)) throw new Error('Apply the customer identity migration first.');
  if (sharedAccountsReady(db)) return false;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE account_invitations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES customer_accounts(id) ON DELETE RESTRICT,
        email TEXT NOT NULL,
        member_role TEXT NOT NULL CHECK(member_role IN ('owner', 'operator', 'viewer')),
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        accepted_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
        accepted_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX account_invitations_account ON account_invitations(account_id, email);
      CREATE TABLE account_signing_policies (
        account_id INTEGER PRIMARY KEY REFERENCES customer_accounts(id) ON DELETE RESTRICT,
        rule TEXT NOT NULL DEFAULT 'single_owner'
          CHECK(rule IN ('single_owner', 'two_signers')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO account_signing_policies (account_id) SELECT id FROM customer_accounts;
      CREATE TABLE transfer_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES customer_accounts(id) ON DELETE RESTRICT,
        recipient_account_id INTEGER NOT NULL REFERENCES customer_accounts(id) ON DELETE RESTRICT,
        amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
        request_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'posted', 'rejected', 'expired')),
        journal_id INTEGER UNIQUE REFERENCES ledger_journals(id) ON DELETE RESTRICT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at TEXT,
        UNIQUE(created_by, idempotency_key),
        CHECK(status != 'posted' OR journal_id IS NOT NULL)
      );
      CREATE INDEX transfer_requests_account ON transfer_requests(account_id, status, id);
      CREATE TABLE transfer_approvals (
        request_id INTEGER NOT NULL REFERENCES transfer_requests(id) ON DELETE RESTRICT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        role_at_approval TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(request_id, user_id)
      );
      CREATE TABLE account_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES customer_accounts(id) ON DELETE RESTRICT,
        actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      ALTER TABLE transactions ADD COLUMN customer_account_id INTEGER
        REFERENCES customer_accounts(id) ON DELETE RESTRICT;
      ALTER TABLE cards ADD COLUMN customer_account_id INTEGER
        REFERENCES customer_accounts(id) ON DELETE RESTRICT;
      UPDATE transactions SET customer_account_id = (
        SELECT a.id FROM customer_accounts a JOIN ledger_accounts l
          ON l.id = a.ledger_account_id WHERE l.user_id = transactions.user_id
      );
      UPDATE cards SET customer_account_id = (
        SELECT a.id FROM customer_accounts a JOIN ledger_accounts l
          ON l.id = a.ledger_account_id WHERE l.user_id = cards.user_id
      );
      CREATE INDEX transactions_customer_account ON transactions(customer_account_id, id);
      CREATE INDEX cards_customer_account ON cards(customer_account_id, id);
    `);
    const missingTransactions = db.prepare(`SELECT COUNT(*) AS n FROM transactions t
      JOIN users u ON u.id = t.user_id WHERE u.role = 'user' AND t.customer_account_id IS NULL`).get().n;
    const missingCards = db.prepare(`SELECT COUNT(*) AS n FROM cards c
      JOIN users u ON u.id = c.user_id WHERE u.role = 'user' AND c.customer_account_id IS NULL`).get().n;
    if (missingTransactions || missingCards || db.pragma('foreign_key_check').length) {
      throw new Error('Shared-account backfill or foreign-key check failed.');
    }
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(VERSION);
  }).immediate();
  return true;
}

module.exports = { migrateSharedAccounts, sharedAccountsReady };
