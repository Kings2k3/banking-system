const { ledgerIsReady } = require('./001_ledger');

const VERSION = '002_admin_controls';

function adminControlsReady(db) {
  return ledgerIsReady(db) && !!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(VERSION);
}

function migrateAdminControls(db) {
  if (!ledgerIsReady(db)) throw new Error('Apply the ledger migration before admin controls.');
  if (adminControlsReady(db)) return false;
  if (db.inTransaction) throw new Error('Admin migration requires an exclusive connection.');
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id").all();
  if (admins.length === 0) throw new Error('Create an admin account before migrating staff controls.');

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        DROP TRIGGER ledger_journals_no_update;
        DROP TRIGGER ledger_journals_no_delete;

        CREATE TABLE ledger_accounts_next (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
          account_number TEXT UNIQUE NOT NULL,
          currency TEXT NOT NULL CHECK(currency = 'USD'),
          kind TEXT NOT NULL CHECK(kind IN ('customer', 'opening_clearing', 'adjustment_clearing')),
          balance_minor INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO ledger_accounts_next SELECT * FROM ledger_accounts;
        DROP TABLE ledger_accounts;
        ALTER TABLE ledger_accounts_next RENAME TO ledger_accounts;

        CREATE TABLE ledger_journals_next (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          reference TEXT UNIQUE NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('opening_balance', 'internal_transfer', 'admin_adjustment')),
          requester_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
          idempotency_key TEXT,
          request_hash TEXT,
          sender_balance_after_minor INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(requester_user_id, idempotency_key)
        );
        INSERT INTO ledger_journals_next SELECT * FROM ledger_journals;
        DROP TABLE ledger_journals;
        ALTER TABLE ledger_journals_next RENAME TO ledger_journals;

        CREATE TRIGGER ledger_journals_no_update BEFORE UPDATE ON ledger_journals
          BEGIN SELECT RAISE(ABORT, 'Posted journals are immutable'); END;
        CREATE TRIGGER ledger_journals_no_delete BEFORE DELETE ON ledger_journals
          BEGIN SELECT RAISE(ABORT, 'Posted journals are immutable'); END;

        CREATE TABLE staff_memberships (
          user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
          staff_role TEXT NOT NULL CHECK(staff_role IN
            ('owner', 'finance_operator', 'finance_approver', 'support', 'auditor')),
          active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
          created_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE staff_invitations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL,
          staff_role TEXT NOT NULL CHECK(staff_role IN
            ('finance_operator', 'finance_approver', 'support', 'auditor')),
          token_hash TEXT UNIQUE NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT,
          revoked_at TEXT,
          created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX staff_invitations_email ON staff_invitations(email);
        CREATE TABLE adjustment_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          direction TEXT NOT NULL CHECK(direction IN ('credit', 'debit')),
          amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
          reason TEXT NOT NULL,
          sender_name TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
          proposed_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          decided_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
          decision_note TEXT NOT NULL DEFAULT '',
          journal_id INTEGER UNIQUE REFERENCES ledger_journals(id) ON DELETE RESTRICT,
          idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          decided_at TEXT,
          UNIQUE(proposed_by, idempotency_key),
          CHECK(status != 'approved' OR journal_id IS NOT NULL),
          CHECK(status = 'pending' OR decided_by IS NOT NULL)
        );
        CREATE INDEX adjustment_requests_status ON adjustment_requests(status, id);
        CREATE TRIGGER adjustment_requests_no_rewrite
          BEFORE UPDATE OF user_id, direction, amount_minor, reason, sender_name,
            proposed_by, idempotency_key, request_hash ON adjustment_requests
          BEGIN SELECT RAISE(ABORT, 'Adjustment proposal is immutable'); END;
      `);

      db.prepare(`INSERT INTO ledger_accounts (account_number, currency, kind)
        VALUES ('ADJUSTMENT_CLEARING', 'USD', 'adjustment_clearing')`).run();
      const insertStaff = db.prepare(`INSERT INTO staff_memberships (user_id, staff_role)
        VALUES (?, ?)`);
      admins.forEach((admin, index) => insertStaff.run(admin.id, index === 0 ? 'owner' : 'auditor'));
      const violations = db.pragma('foreign_key_check');
      if (violations.length) throw new Error(`Foreign key check failed after admin migration: ${violations.length} violation(s).`);
      const imbalanced = db.prepare(`SELECT COUNT(*) AS count FROM ledger_accounts a
        WHERE a.balance_minor != COALESCE((SELECT SUM(p.amount_minor)
          FROM ledger_postings p WHERE p.account_id = a.id), 0)`).get().count;
      if (imbalanced) throw new Error('Ledger reconciliation failed after admin migration.');
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(VERSION);
    }).immediate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return true;
}

module.exports = { migrateAdminControls, adminControlsReady };
