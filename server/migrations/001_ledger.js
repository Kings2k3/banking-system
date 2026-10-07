const MIGRATION = '001_ledger';

function legacyCents(value, userId) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
      !Number.isSafeInteger(Math.round(value * 100)) ||
      Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) {
    throw new Error(`Balance for user ${userId} cannot be imported exactly; resolve it before migrating.`);
  }
  return Math.round(value * 100);
}

function migrateLedger(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(MIGRATION)) return false;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE ledger_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
        account_number TEXT UNIQUE NOT NULL,
        currency TEXT NOT NULL CHECK(currency = 'USD'),
        kind TEXT NOT NULL CHECK(kind IN ('customer', 'opening_clearing')),
        balance_minor INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE ledger_journals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reference TEXT UNIQUE NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('opening_balance', 'internal_transfer')),
        requester_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
        idempotency_key TEXT,
        request_hash TEXT,
        sender_balance_after_minor INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(requester_user_id, idempotency_key)
      );
      CREATE TABLE ledger_postings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        journal_id INTEGER NOT NULL REFERENCES ledger_journals(id) ON DELETE RESTRICT,
        account_id INTEGER NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
        amount_minor INTEGER NOT NULL CHECK(amount_minor != 0)
      );
      CREATE INDEX ledger_postings_account ON ledger_postings(account_id, journal_id);
      CREATE TABLE legacy_balance_snapshots (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
        source_balance TEXT NOT NULL,
        opening_minor INTEGER NOT NULL,
        opening_journal_id INTEGER REFERENCES ledger_journals(id) ON DELETE RESTRICT
      );
      CREATE TRIGGER ledger_postings_no_update BEFORE UPDATE ON ledger_postings
        BEGIN SELECT RAISE(ABORT, 'Posted ledger entries are immutable'); END;
      CREATE TRIGGER ledger_postings_no_delete BEFORE DELETE ON ledger_postings
        BEGIN SELECT RAISE(ABORT, 'Posted ledger entries are immutable'); END;
      CREATE TRIGGER ledger_journals_no_update BEFORE UPDATE ON ledger_journals
        BEGIN SELECT RAISE(ABORT, 'Posted journals are immutable'); END;
      CREATE TRIGGER ledger_journals_no_delete BEFORE DELETE ON ledger_journals
        BEGIN SELECT RAISE(ABORT, 'Posted journals are immutable'); END;
    `);
    db.exec('ALTER TABLE transactions ADD COLUMN journal_id INTEGER REFERENCES ledger_journals(id) ON DELETE RESTRICT');
    db.exec('CREATE INDEX transactions_journal ON transactions(journal_id)');

    const users = db.prepare("SELECT id, account_number, balance FROM users WHERE role = 'user' ORDER BY id").all();
    const amounts = users.map(user => ({ ...user, cents: legacyCents(user.balance, user.id) }));
    const clearing = db.prepare(`INSERT INTO ledger_accounts (account_number, currency, kind)
      VALUES ('OPENING_CLEARING', 'USD', 'opening_clearing')`).run().lastInsertRowid;
    const createAccount = db.prepare(`INSERT INTO ledger_accounts (user_id, account_number, currency, kind, balance_minor)
      VALUES (?, ?, 'USD', 'customer', ?)`);
    const createJournal = db.prepare(`INSERT INTO ledger_journals (reference, kind) VALUES (?, 'opening_balance')`);
    const createPosting = db.prepare(`INSERT INTO ledger_postings (journal_id, account_id, amount_minor) VALUES (?, ?, ?)`);
    const snapshot = db.prepare(`INSERT INTO legacy_balance_snapshots
      (user_id, source_balance, opening_minor, opening_journal_id) VALUES (?, ?, ?, ?)`);
    let totalOpening = 0;
    for (const user of amounts) {
      const accountId = createAccount.run(user.id, user.account_number, user.cents).lastInsertRowid;
      let journalId = null;
      if (user.cents > 0) {
        journalId = createJournal.run(`OPEN-${user.id}`).lastInsertRowid;
        createPosting.run(journalId, accountId, user.cents);
        createPosting.run(journalId, clearing, -user.cents);
        totalOpening += user.cents;
        if (!Number.isSafeInteger(totalOpening)) throw new Error('Opening balance total exceeds safe integer precision.');
      }
      snapshot.run(user.id, String(user.balance), user.cents, journalId);
    }
    db.prepare('UPDATE ledger_accounts SET balance_minor = ? WHERE id = ?').run(-totalOpening, clearing);
    const accountDifference = db.prepare(`SELECT COUNT(*) AS count FROM ledger_accounts a
      WHERE a.balance_minor != COALESCE((SELECT SUM(p.amount_minor) FROM ledger_postings p
        WHERE p.account_id = a.id), 0)`).get().count;
    const journalDifference = db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT j.id FROM ledger_journals j JOIN ledger_postings p ON p.journal_id = j.id
      GROUP BY j.id HAVING SUM(p.amount_minor) != 0)`).get().count;
    if (accountDifference || journalDifference) throw new Error('Opening ledger reconciliation failed.');
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(MIGRATION);
  }).immediate();
  return true;
}

function ledgerIsReady(db) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  return !!table && !!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(MIGRATION);
}

module.exports = { migrateLedger, ledgerIsReady, legacyCents };
