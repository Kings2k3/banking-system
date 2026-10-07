const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

test('email verification and password recovery', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'payvexis-identity-'));
  process.env.DB_PATH = path.join(directory, 'app.db');
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.DEMO_SEED = 'true';
  process.env.NODE_ENV = 'test';
  const app = require('../server/index');
  const { db } = require('../server/database');
  const { migrateLedger } = require('../server/migrations/001_ledger');
  const { migrateAdminControls } = require('../server/migrations/002_admin_controls');
  const { migrateIdentityOwnership } = require('../server/migrations/003_identity_ownership');
  const { migrateCustomerIdentity } = require('../server/migrations/004_customer_identity');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, body, token) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  const outbox = () => fs.readdirSync(path.join(directory, 'dev-mailbox')).sort()
    .map(name => JSON.parse(fs.readFileSync(path.join(directory, 'dev-mailbox', name), 'utf8')));
  const tokenFrom = message => new URLSearchParams(new URL(message.text.match(/https?:\/\/\S+/)[0]).hash.slice(1)).get('token');

  try {
    migrateLedger(db);
    migrateAdminControls(db);
    migrateIdentityOwnership(db);
    assert.equal(migrateCustomerIdentity(db), true);
    assert.equal(migrateCustomerIdentity(db), false);
    const registered = await request('/api/auth/register', {
      email: 'verify@example.com', password: 'OldPassword123!',
      firstName: 'Ari', lastName: 'Example', accountType: 'personal'
    });
    assert.equal(registered.status, 201);
    const { token: oldSession, emailVerificationRequired } = await registered.json();
    assert.equal(emailVerificationRequired, true);

    await t.test('email link is one-time and stored as a hash', async () => {
      const message = outbox().find(mail => mail.to === 'verify@example.com');
      assert.ok(message);
      const token = tokenFrom(message);
      assert.ok(token);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_action_tokens WHERE token_hash = ?').get(token).n, 0);
      assert.equal((await request('/api/auth/verify-email', { token })).status, 200);
      assert.equal((await request('/api/auth/verify-email', { token })).status, 400);
      const user = db.prepare('SELECT email_verified_at FROM users WHERE email = ?').get('verify@example.com');
      assert.ok(user.email_verified_at);
    });

    await t.test('recovery does not enumerate and revokes old sessions', async () => {
      const missing = await request('/api/auth/password-reset/request', { email: 'missing@example.com' });
      const existing = await request('/api/auth/password-reset/request', { email: 'verify@example.com' });
      assert.equal(missing.status, 202);
      assert.equal(existing.status, 202);
      assert.deepEqual(await missing.json(), await existing.json());
      const message = outbox().find(mail => mail.subject.includes('Reset'));
      const token = tokenFrom(message);
      assert.equal((await request('/api/auth/password-reset/complete', {
        token, password: 'NewPassword456!'
      })).status, 200);
      assert.equal((await request('/api/auth/password-reset/complete', {
        token, password: 'AnotherPassword456!'
      })).status, 400);
      assert.equal((await fetch(`${base}/api/accounts/me`, {
        headers: { Authorization: `Bearer ${oldSession}` }
      })).status, 401);
      assert.equal((await request('/api/auth/login', {
        email: 'verify@example.com', password: 'OldPassword123!'
      })).status, 401);
      assert.equal((await request('/api/auth/login', {
        email: 'verify@example.com', password: 'NewPassword456!'
      })).status, 200);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE event_type = 'password_reset'").get().n, 1);
    });
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
