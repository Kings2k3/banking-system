const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const config = require('../server/config');
const { db, initDB } = require('../server/database');
const { migrateLedger, ledgerIsReady } = require('../server/migrations/001_ledger');

async function main() {
  initDB();
  if (ledgerIsReady(db)) {
    console.log('Ledger migration is already applied.');
    return;
  }
  const databasePath = path.resolve(config.DB_PATH);
  const backupDirectory = path.join(path.dirname(databasePath), 'backups');
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backupPath = path.join(backupDirectory, `before-ledger-${Date.now()}-${randomUUID()}.db`);
  await db.backup(backupPath);
  console.log(`Database backup: ${backupPath}`);
  migrateLedger(db);
  console.log('Ledger migration applied. Legacy transactions remain read-only history.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => db.close());
