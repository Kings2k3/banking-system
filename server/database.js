const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const config = require('./config');

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

  // Seed Admin User if not exists
  const adminExists = db.prepare("SELECT id FROM users WHERE role = 'admin'").get();

  if (!adminExists) {
    console.log('Seeding default admin user...');
    const hashedPassword = bcrypt.hashSync(config.ADMIN_PASSWORD, 12);
    const insertAdmin = db.prepare(`
      INSERT INTO users (email, password_hash, first_name, last_name, account_number, role)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    // Admins don't need a real account number but the schema requires it
    const adminAccountNumber = '0000000000';
    insertAdmin.run(config.ADMIN_EMAIL, hashedPassword, 'System', 'Admin', adminAccountNumber, 'admin');
    console.log(`Admin user created: ${config.ADMIN_EMAIL}`);
  }
};

module.exports = {
  db,
  initDB
};
