const { identityOwnershipReady } = require('./003_identity_ownership');

const VERSION = '004_customer_identity';

function customerIdentityReady(db) {
  if (db.engine === 'postgres') return db.migrationsReady;
  return identityOwnershipReady(db) && !!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(VERSION);
}

function migrateCustomerIdentity(db) {
  if (!identityOwnershipReady(db)) throw new Error('Apply the identity ownership migration first.');
  if (customerIdentityReady(db)) return false;
  db.transaction(() => {
    db.exec(`
      ALTER TABLE users ADD COLUMN email_verified_at TEXT;
      CREATE TABLE email_action_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        purpose TEXT NOT NULL CHECK(purpose IN ('verify_email', 'reset_password')),
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX email_action_tokens_user ON email_action_tokens(user_id, purpose, created_at);
      CREATE TABLE identity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    if (db.pragma('foreign_key_check').length) throw new Error('Foreign key check failed after customer identity migration.');
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(VERSION);
  }).immediate();
  return true;
}

module.exports = { migrateCustomerIdentity, customerIdentityReady };
