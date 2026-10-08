if (process.env.DB_ENGINE === 'postgres' || process.env.VERCEL === '1') {
  module.exports = require('./postgres-database');
} else {
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const config = require('./config');
const { ledgerIsReady } = require('./migrations/001_ledger');

const db = new Database(config.DB_PATH);

// Optional: enhance performance and reliability
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize database schema
const initDB = () => {
  db.exec(`
    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      email           TEXT    UNIQUE NOT NULL,
      password_hash   TEXT    NOT NULL,
      first_name      TEXT    NOT NULL,
      last_name       TEXT    NOT NULL,
      phone           TEXT    DEFAULT '',
      dob             TEXT    DEFAULT '',
      account_type    TEXT    DEFAULT 'personal',
      account_label   TEXT    DEFAULT 'Personal Checking',
      account_number  TEXT    UNIQUE NOT NULL,
      balance         REAL    DEFAULT 0,
      role            TEXT    DEFAULT 'user' CHECK(role IN ('user','admin')),
      suspended       INTEGER DEFAULT 0,
      is_joint        INTEGER DEFAULT 0,
      joint_first_name TEXT   DEFAULT '',
      joint_last_name  TEXT   DEFAULT '',
      joint_email      TEXT   DEFAULT '',
      joint_phone      TEXT   DEFAULT '',
      joint_dob        TEXT   DEFAULT '',
      joint_relationship TEXT DEFAULT '',
      created_at      TEXT    DEFAULT (datetime('now'))
    );

    -- Transactions table
    CREATE TABLE IF NOT EXISTS transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type        TEXT    NOT NULL CHECK(type IN ('income','spend')),
      category    TEXT    NOT NULL,
      merchant    TEXT    NOT NULL,
      amount      REAL    NOT NULL,
      account     TEXT    DEFAULT '',
      reference   TEXT    DEFAULT '',
      status      TEXT    DEFAULT 'Completed',
      created_at  TEXT    DEFAULT (datetime('now'))
    );

    -- Cards table
    CREATE TABLE IF NOT EXISTS cards (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT    DEFAULT 'Payvexis Debit',
      mask        TEXT    NOT NULL,
      network     TEXT    DEFAULT 'PAYVEXIS',
      status      TEXT    DEFAULT 'Active',
      frozen      INTEGER DEFAULT 0,
      spend       REAL    DEFAULT 0,
      card_limit  REAL    DEFAULT 400,
      theme       TEXT    DEFAULT 'graphite',
      nickname    TEXT    DEFAULT 'Everyday spend',
      holder      TEXT    DEFAULT ''
    );

    -- Audit log table (tracks ALL admin actions)
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id    INTEGER NOT NULL REFERENCES users(id),
      action      TEXT    NOT NULL,
      target_type TEXT    NOT NULL,
      target_id   INTEGER,
      details     TEXT    DEFAULT '',
      ip_address  TEXT    DEFAULT '',
      created_at  TEXT    DEFAULT (datetime('now'))
    );

    -- Spending categories (per user)
    CREATE TABLE IF NOT EXISTS spending (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label       TEXT    NOT NULL,
      amount      REAL    DEFAULT 0,
      budget      REAL    DEFAULT 0
    );

    -- Support Tickets table
    CREATE TABLE IF NOT EXISTS support_tickets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject     TEXT    NOT NULL,
      message     TEXT    NOT NULL,
      status      TEXT    DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
      created_at  TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id          TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at  TEXT NOT NULL,
      revoked_at  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_user_id ON auth_sessions(user_id);
  `);

  // Migrations for existing DBs
  const addColumn = (table, column, definition) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`Migrated: Added ${column} to ${table}`);
    } catch (e) {
      // Column probably already exists, ignore
    }
  };

  addColumn('users', 'is_joint', 'INTEGER DEFAULT 0');
  addColumn('users', 'joint_first_name', 'TEXT DEFAULT ""');
  addColumn('users', 'joint_last_name', 'TEXT DEFAULT ""');
  addColumn('users', 'joint_email', 'TEXT DEFAULT ""');
  addColumn('users', 'joint_phone', 'TEXT DEFAULT ""');
  addColumn('users', 'joint_dob', 'TEXT DEFAULT ""');
  addColumn('users', 'joint_relationship', 'TEXT DEFAULT ""');

  const cardColumns = new Set(db.pragma('table_info(cards)').map(column => column.name));
  for (const [name, definition] of Object.entries({
    contactless: 'INTEGER NOT NULL DEFAULT 1',
    online: 'INTEGER NOT NULL DEFAULT 1',
    international: 'INTEGER NOT NULL DEFAULT 0',
    atm: 'INTEGER NOT NULL DEFAULT 1'
  })) {
    if (!cardColumns.has(name)) db.exec(`ALTER TABLE cards ADD COLUMN ${name} ${definition}`);
  }

  // Seed Admin User if not exists
  const adminExists = db.prepare("SELECT id FROM users WHERE role = 'admin'").get();

  if (!adminExists && (config.ADMIN_PASSWORD || config.DEMO_SEED)) {
    console.log('Seeding default admin user...');
    const hashedPassword = bcrypt.hashSync(config.ADMIN_PASSWORD || 'AdminPass123!', 12);
    const insertAdmin = db.prepare(`
      INSERT INTO users (email, password_hash, first_name, last_name, account_number, role)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    // Admins don't need a real account number but the schema requires it
    const adminAccountNumber = '0000000000';
    insertAdmin.run(config.ADMIN_EMAIL, hashedPassword, 'System', 'Admin', adminAccountNumber, 'admin');
    console.log(`Admin user created: ${config.ADMIN_EMAIL}`);
  }

  // Seed default test user if no standard user exists
  const userExists = db.prepare("SELECT id FROM users WHERE role = 'user'").get();

  if (!userExists && config.DEMO_SEED && !ledgerIsReady(db)) {
    console.log('Seeding default test user...');
    const userPasswordHash = bcrypt.hashSync('UserPass123!', 12);

    db.transaction(() => {
      // 1. Create User
      const userResult = db.prepare(`
        INSERT INTO users (email, password_hash, first_name, last_name, phone, dob, account_type, account_label, account_number, balance)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'user@payvexis.com',
        userPasswordHash,
        'Test',
        'User',
        '555-0199',
        '1992-04-18',
        'personal',
        'Personal Checking',
        '7894561230',
        1250.75
      );

      const userId = userResult.lastInsertRowid;

      // 2. Create default card
      db.prepare(`
        INSERT INTO cards (user_id, mask, holder)
        VALUES (?, ?, ?)
      `).run(userId, '1230', 'Test User');

      // 3. Create default spending categories
      const stmt = db.prepare('INSERT INTO spending (user_id, label, amount, budget) VALUES (?, ?, ?, ?)');
      stmt.run(userId, 'Groceries & Dining', 120, 400);
      stmt.run(userId, 'Subscriptions', 45, 150);
      stmt.run(userId, 'Transport', 30, 100);
    })();
    console.log('Default test user created: user@payvexis.com (UserPass123!)');
  }
};

module.exports = {
  db,
  initDB
};
}
