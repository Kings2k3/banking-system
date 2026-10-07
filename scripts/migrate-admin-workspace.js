const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const config = require('../server/config');
const { db, initDB } = require('../server/database');
const { migrateAdminWorkspace, adminWorkspaceReady } = require('../server/migrations/006_admin_workspace');

async function main() {
  initDB();
  if (adminWorkspaceReady(db)) return console.log('Admin workspace migration is already applied.');
  const folder = path.join(path.dirname(path.resolve(config.DB_PATH)), 'backups');
  fs.mkdirSync(folder, { recursive: true });
  const backup = path.join(folder, `before-admin-workspace-${Date.now()}-${randomUUID()}.db`);
  await db.backup(backup);
  console.log(`Database backup: ${backup}`);
  migrateAdminWorkspace(db);
  console.log('Admin workspace and operation review schema applied.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.close());
