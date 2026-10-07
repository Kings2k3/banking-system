const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const config = require('../server/config');
const { db, initDB } = require('../server/database');
const { migrateCustomerIdentity, customerIdentityReady } = require('../server/migrations/004_customer_identity');

async function main() {
  initDB();
  if (customerIdentityReady(db)) return console.log('Customer identity migration is already applied.');
  const folder = path.join(path.dirname(path.resolve(config.DB_PATH)), 'backups');
  fs.mkdirSync(folder, { recursive: true });
  const backup = path.join(folder, `before-customer-identity-${Date.now()}-${randomUUID()}.db`);
  await db.backup(backup);
  console.log(`Database backup: ${backup}`);
  migrateCustomerIdentity(db);
  console.log('Customer verification and recovery schema applied.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.close());
