const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const config = require('../server/config');
const { db, initDB } = require('../server/database');
const { migrateSharedAccounts, sharedAccountsReady } = require('../server/migrations/005_shared_accounts');

async function main() {
  initDB();
  if (sharedAccountsReady(db)) return console.log('Shared-account migration is already applied.');
  const folder = path.join(path.dirname(path.resolve(config.DB_PATH)), 'backups');
  fs.mkdirSync(folder, { recursive: true });
  const backup = path.join(folder, `before-shared-accounts-${Date.now()}-${randomUUID()}.db`);
  await db.backup(backup);
  console.log(`Database backup: ${backup}`);
  migrateSharedAccounts(db);
  console.log('Shared-account invitations and signing schema applied.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.close());
