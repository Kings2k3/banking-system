const { sharedAccountsReady } = require('./005_shared_accounts');

const VERSION = '006_admin_workspace';

function adminWorkspaceReady(db) {
  if (db.engine === 'postgres') return db.migrationsReady;
  return sharedAccountsReady(db) &&
    !!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(VERSION);
}

function migrateAdminWorkspace(db) {
  if (!sharedAccountsReady(db)) throw new Error('Apply shared-account migration first.');
  if (adminWorkspaceReady(db)) return false;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE customer_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        staff_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        body TEXT NOT NULL CHECK(length(body) BETWEEN 3 AND 2000),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX customer_notes_user ON customer_notes(user_id, id);

      CREATE TABLE account_restrictions (
        account_id INTEGER PRIMARY KEY REFERENCES customer_accounts(id) ON DELETE RESTRICT,
        debit_blocked INTEGER NOT NULL DEFAULT 0 CHECK(debit_blocked IN (0, 1)),
        credit_blocked INTEGER NOT NULL DEFAULT 0 CHECK(credit_blocked IN (0, 1)),
        reason TEXT NOT NULL DEFAULT '',
        updated_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO account_restrictions (account_id) SELECT id FROM customer_accounts;

      CREATE TABLE operation_reviews (
        operation_type TEXT NOT NULL CHECK(operation_type IN ('shared_transfer', 'adjustment')),
        operation_id INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'unreviewed'
          CHECK(state IN ('unreviewed', 'investigating', 'resolved')),
        updated_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(operation_type, operation_id)
      );
      CREATE TABLE operation_review_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_type TEXT NOT NULL CHECK(operation_type IN ('shared_transfer', 'adjustment')),
        operation_id INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('investigating', 'resolved')),
        note TEXT NOT NULL CHECK(length(note) BETWEEN 10 AND 1000),
        staff_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX operation_review_events_operation
        ON operation_review_events(operation_type, operation_id, id);
    `);
    if (db.pragma('foreign_key_check').length) throw new Error('Admin workspace foreign-key check failed.');
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(VERSION);
  }).immediate();
  return true;
}

module.exports = { migrateAdminWorkspace, adminWorkspaceReady };
