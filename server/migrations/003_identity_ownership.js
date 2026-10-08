const { adminControlsReady } = require('./002_admin_controls');

const VERSION = '003_identity_ownership';

function identityOwnershipReady(db) {
  if (db.engine === 'postgres') return db.migrationsReady;
  return adminControlsReady(db) && !!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(VERSION);
}

function migrateIdentityOwnership(db) {
  if (!adminControlsReady(db)) throw new Error('Apply the admin controls migration first.');
  if (identityOwnershipReady(db)) return false;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE customer_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ledger_account_id INTEGER NOT NULL UNIQUE REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
        display_name TEXT NOT NULL,
        requested_type TEXT NOT NULL,
        ownership_kind TEXT NOT NULL DEFAULT 'individual'
          CHECK(ownership_kind IN ('individual', 'joint', 'organization')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'restricted', 'closed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE account_memberships (
        account_id INTEGER NOT NULL REFERENCES customer_accounts(id) ON DELETE RESTRICT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        member_role TEXT NOT NULL CHECK(member_role IN ('owner', 'operator', 'viewer')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'invited', 'revoked')),
        accepted_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(account_id, user_id)
      );
      CREATE INDEX account_memberships_user ON account_memberships(user_id, status);
      CREATE TABLE staff_mfa_factors (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
        encrypted_secret TEXT NOT NULL,
        last_used_step INTEGER NOT NULL DEFAULT -1,
        enabled_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE staff_mfa_recovery_codes (
        user_id INTEGER NOT NULL REFERENCES staff_mfa_factors(user_id) ON DELETE RESTRICT,
        code_hash TEXT NOT NULL,
        used_at TEXT,
        PRIMARY KEY(user_id, code_hash)
      );
      CREATE TABLE staff_mfa_challenges (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        purpose TEXT NOT NULL CHECK(purpose IN ('enroll', 'login')),
        encrypted_secret TEXT,
        expires_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        consumed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX staff_mfa_challenges_user ON staff_mfa_challenges(user_id, expires_at);
      ALTER TABLE auth_sessions ADD COLUMN staff_mfa_verified INTEGER NOT NULL DEFAULT 0
        CHECK(staff_mfa_verified IN (0, 1));
    `);

    const insertAccount = db.prepare(`INSERT INTO customer_accounts
      (ledger_account_id, display_name, requested_type) VALUES (?, ?, ?)`);
    const insertMember = db.prepare(`INSERT INTO account_memberships
      (account_id, user_id, member_role, accepted_at) VALUES (?, ?, 'owner', datetime('now'))`);
    const legacyAccounts = db.prepare(`SELECT l.id AS ledger_id, u.id AS user_id,
      u.account_label, u.account_type FROM ledger_accounts l
      JOIN users u ON u.id = l.user_id WHERE l.kind = 'customer' ORDER BY l.id`).all();
    for (const account of legacyAccounts) {
      const displayName = account.account_type === 'joint' ? 'Checking (joint holder pending)' :
        account.account_type === 'business' ? 'Checking (business setup pending)' : account.account_label;
      const id = insertAccount.run(account.ledger_id, displayName, account.account_type).lastInsertRowid;
      insertMember.run(id, account.user_id);
    }
    db.prepare(`UPDATE auth_sessions SET revoked_at = datetime('now')
      WHERE user_id IN (SELECT id FROM users WHERE role = 'admin') AND revoked_at IS NULL`).run();

    if (db.pragma('foreign_key_check').length) throw new Error('Foreign key check failed after ownership migration.');
    const missing = db.prepare(`SELECT COUNT(*) AS count FROM ledger_accounts l
      WHERE l.kind = 'customer' AND NOT EXISTS
        (SELECT 1 FROM customer_accounts a JOIN account_memberships m ON m.account_id = a.id
         WHERE a.ledger_account_id = l.id AND m.user_id = l.user_id
           AND m.member_role = 'owner' AND m.status = 'active')`).get().count;
    if (missing) throw new Error('Customer ownership backfill is incomplete.');
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(VERSION);
  }).immediate();
  return true;
}

module.exports = { migrateIdentityOwnership, identityOwnershipReady };
