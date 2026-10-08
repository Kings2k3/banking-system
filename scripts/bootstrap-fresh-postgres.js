// Build the current schema from a disposable, empty SQLite database and use
// the reconciled importer to create a fresh PostgreSQL schema. This never
// copies the developer's local accounts or transaction history.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const { safeName } = require('./postgres-import-lib');

dotenv.config({ path: process.argv[2] || '.env', override: true, quiet: true });
const sourceOnly = process.argv.includes('--source-only');
const databaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!sourceOnly && !databaseUrl) throw new Error('DATABASE_URL is required.');
const schema = process.env.PG_STAGE_SCHEMA || 'payvexis_app';
safeName(schema);
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'payvexis-fresh-pg-'));
const dbPath = path.join(folder, 'source.db');

process.env.DB_PATH = dbPath;
process.env.NODE_ENV = 'test';
process.env.VERCEL = '0';
process.env.DB_ENGINE = 'sqlite';
process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.STAFF_MFA_KEY = randomBytes(32).toString('hex');
process.env.ADMIN_EMAIL = `bootstrap-${randomUUID()}@example.invalid`;
process.env.ADMIN_PASSWORD = randomBytes(32).toString('hex');
process.env.DEMO_SEED = 'false';

try {
  const { db, initDB } = require('../server/database');
  const migrations = [
    require('../server/migrations/001_ledger').migrateLedger,
    require('../server/migrations/002_admin_controls').migrateAdminControls,
    require('../server/migrations/003_identity_ownership').migrateIdentityOwnership,
    require('../server/migrations/004_customer_identity').migrateCustomerIdentity,
    require('../server/migrations/005_shared_accounts').migrateSharedAccounts,
    require('../server/migrations/006_admin_workspace').migrateAdminWorkspace
  ];
  try {
    initDB();
    for (const migrate of migrations) migrate(db);
    const admin = db.prepare('SELECT id FROM users WHERE email = ?').get(process.env.ADMIN_EMAIL);
    db.prepare('DELETE FROM staff_memberships WHERE user_id = ?').run(admin.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(admin.id);
    if (db.pragma('foreign_key_check').length) throw new Error('Fresh source has foreign-key violations.');
    if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n !== 0) {
      throw new Error('Fresh source contains users.');
    }
  } finally {
    db.close();
  }

  if (sourceOnly) {
    console.log('Fresh SQLite source passed migration and foreign-key checks.');
  } else {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'migrate-to-postgres.js')], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PG_BOOTSTRAP_FRESH: 'true', ADMIN_PASSWORD: '',
        DB_PATH: dbPath, PG_STAGE_SCHEMA: schema },
      stdio: 'inherit'
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Fresh PostgreSQL import failed.');
    console.log(`Fresh PostgreSQL schema ready: ${schema}`);
  }
} finally {
  if (!path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    throw new Error('Refusing to remove an unexpected temporary directory.');
  }
  fs.rmSync(folder, { recursive: true, force: true });
}
