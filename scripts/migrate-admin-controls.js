const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const config = require('../server/config');
const { db, initDB } = require('../server/database');
const { adminControlsReady, migrateAdminControls } = require('../server/migrations/002_admin_controls');

async function main() {
  initDB();
  if (adminControlsReady(db)) {
    console.log('Admin controls migration is already applied.');
    return;
  }
  const backupDirectory = path.join(path.dirname(path.resolve(config.DB_PATH)), 'backups');
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backupPath = path.join(backupDirectory, `before-admin-controls-${Date.now()}-${randomUUID()}.db`);
  await db.backup(backupPath);
  console.log(`Database backup: ${backupPath}`);
  migrateAdminControls(db);
  console.log('Staff roles and adjustment workflow schema applied.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => db.close());
