const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const config = require('../server/config');
const { db, initDB } = require('../server/database');
const { migrateIdentityOwnership, identityOwnershipReady } = require('../server/migrations/003_identity_ownership');

async function main() {
  initDB();
  if (identityOwnershipReady(db)) {
    console.log('Identity and ownership migration is already applied.');
    return;
  }
  const backupDirectory = path.join(path.dirname(path.resolve(config.DB_PATH)), 'backups');
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backupPath = path.join(backupDirectory, `before-identity-ownership-${Date.now()}-${randomUUID()}.db`);
  await db.backup(backupPath);
  console.log(`Database backup: ${backupPath}`);
  migrateIdentityOwnership(db);
  console.log('Account ownership and staff MFA schema applied. Existing staff sessions revoked.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => db.close());
