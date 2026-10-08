const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

test('production demo makes paused email actions explicit', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'payvexis-email-paused-'));
  process.env.DB_PATH = path.join(directory, 'app.db');
  process.env.DB_ENGINE = 'sqlite';
  process.env.VERCEL = '0';
  process.env.NODE_ENV = 'production';
  process.env.EMAIL_ACTIONS_ENABLED = 'false';
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.STAFF_MFA_KEY = randomBytes(32).toString('hex');
  process.env.ADMIN_EMAIL = 'owner@example.invalid';
  process.env.ADMIN_PASSWORD = randomBytes(24).toString('hex');
  process.env.DEMO_SEED = 'false';
  const app = require('../server/index');
  const { db } = require('../server/database');
  const migrations = [
    require('../server/migrations/001_ledger').migrateLedger,
    require('../server/migrations/002_admin_controls').migrateAdminControls,
    require('../server/migrations/003_identity_ownership').migrateIdentityOwnership,
    require('../server/migrations/004_customer_identity').migrateCustomerIdentity,
    require('../server/migrations/005_shared_accounts').migrateSharedAccounts,
    require('../server/migrations/006_admin_workspace').migrateAdminWorkspace
  ];
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, token) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  try {
    for (const migrate of migrations) migrate(db);
    const capabilities = await fetch(`${base}/api/auth/capabilities`);
    assert.deepEqual(await capabilities.json(), { emailActionsEnabled: false });
    const response = await post('/api/auth/register', {
      email: 'paused@example.invalid', password: 'DemoPassword123!',
      firstName: 'Demo', lastName: 'Customer', accountType: 'personal'
    });
    assert.equal(response.status, 201);
    const registered = await response.json();
    assert.equal(registered.emailVerificationRequired, false);
    assert.equal(registered.verificationDelivery, 'disabled');
    assert.equal(fs.existsSync(path.join(directory, 'dev-mailbox')), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_action_tokens').get().n, 0);
    for (const route of ['/api/auth/resend-verification', '/api/auth/verify-email',
      '/api/auth/password-reset/request', '/api/auth/password-reset/complete']) {
      const action = await post(route, {}, registered.token);
      assert.equal(action.status, 503, route);
    }
    const login = await post('/api/auth/login', {
      email: 'paused@example.invalid', password: 'DemoPassword123!'
    });
    assert.equal(login.status, 200);
    const transfer = await post('/api/transactions/transfer', {
      recipient: '0000000000', amount: 1
    }, registered.token);
    assert.equal(transfer.status, 503);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
