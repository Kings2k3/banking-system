const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

test('public files, sessions, transfer guard and card settings', async t => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'payvexis-test-'));
  process.env.DB_PATH = path.join(temporaryDirectory, 'app.db');
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.ADMIN_PASSWORD = '';
  process.env.DEMO_SEED = 'false';
  process.env.DEMO_INTERNAL_TRANSFERS = 'false';
  process.env.DEMO_ADMIN_ADJUSTMENTS = 'false';
  process.env.NODE_ENV = 'test';

  const app = require('../server/index');
  const { db } = require('../server/database');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, options) => fetch(`${base}${route}`, options);

  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);

    await t.test('serves browser assets and blocks repository files', async () => {
      assert.equal((await request('/')).status, 200);
      assert.equal((await request('/dashboard.js')).status, 200);
      assert.equal((await request('/auth-client.js')).status, 200);
      assert.equal((await request('/staff-setup.html')).status, 200);
      for (const route of ['/server/payvexis.db', '/server/index.js', '/package.json', '/docs/system-design.md', '/.env']) {
        assert.equal((await request(route)).status, 404, route);
      }
    });

    let token;
    let cardId;
    await t.test('registers and persists a revocable session', async () => {
      const response = await request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.com', password: 'UniquePassword123!',
          firstName: 'Alice', lastName: 'Example', accountType: 'personal'
        })
      });
      assert.equal(response.status, 201);
      token = (await response.json()).token;
      assert.equal((await request('/api/accounts/me', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get().count, 1);
    });

    await t.test('rejects the previous incomplete transfer without changing money', async () => {
      const before = db.prepare('SELECT balance FROM users WHERE email = ?').get('alice@example.com').balance;
      const response = await request('/api/transactions/transfer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: '0123456789', amount: 10 })
      });
      assert.equal(response.status, 503);
      assert.equal(db.prepare('SELECT balance FROM users WHERE email = ?').get('alice@example.com').balance, before);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count, 0);
    });

    await t.test('persists all displayed card controls', async () => {
      const me = await (await request('/api/accounts/me', { headers: { Authorization: `Bearer ${token}` } })).json();
      cardId = me.cards[0].id;
      const response = await request(`/api/accounts/cards/${cardId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Travel card', holder: 'Alice Example', nickname: 'Travel',
          theme: 'ocean', cardLimit: 1000, contactless: false,
          online: true, international: true, atm: false
        })
      });
      assert.equal(response.status, 200);
      const card = (await response.json()).card;
      assert.equal(card.cardLimit, 1000);
      assert.equal(card.name, 'Travel card');
      assert.equal(card.contactless, false);
      assert.equal(card.international, true);
      assert.equal(card.atm, false);
      const invalid = await request(`/api/accounts/cards/${cardId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardLimit: -100 })
      });
      assert.equal(invalid.status, 400);
    });

    await t.test('prevents destructive admin operations outside explicit demo mode', async () => {
      const bcrypt = require('bcrypt');
      db.prepare(`INSERT INTO users (email, password_hash, first_name, last_name, account_number, role)
        VALUES (?, ?, ?, ?, ?, 'admin')`)
        .run('admin@example.com', bcrypt.hashSync('UniqueAdminPassword123!', 12), 'Test', 'Admin', '0000000000');
      const { migrateLedger } = require('../server/migrations/001_ledger');
      const { migrateAdminControls } = require('../server/migrations/002_admin_controls');
      const { migrateIdentityOwnership } = require('../server/migrations/003_identity_ownership');
      const { totpAt } = require('../server/services/staff-mfa');
      migrateLedger(db);
      migrateAdminControls(db);
      migrateIdentityOwnership(db);
      const login = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.com', password: 'UniqueAdminPassword123!' })
      });
      assert.equal(login.status, 202);
      const challenge = await login.json();
      const setup = await request('/api/auth/staff-mfa/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken: challenge.challengeToken })
      });
      assert.equal(setup.status, 200);
      const secret = (await setup.json()).secret;
      const completed = await request('/api/auth/staff-mfa/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken: challenge.challengeToken, purpose: 'enroll',
          code: totpAt(secret, Math.floor(Date.now() / 30000)) })
      });
      assert.equal(completed.status, 200);
      const adminToken = (await completed.json()).token;
      const customer = db.prepare('SELECT id, balance FROM users WHERE email = ?').get('alice@example.com');
      const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
      const adjust = await request(`/api/admin/users/${customer.id}/adjust`, {
        method: 'POST', headers,
        body: JSON.stringify({ type: 'credit', amount: 25, reason: 'Test' })
      });
      assert.equal(adjust.status, 503);
      const remove = await request(`/api/admin/users/${customer.id}`, { method: 'DELETE', headers });
      assert.equal(remove.status, 409);
      assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(customer.id).balance, customer.balance);
    });

    await t.test('logout invalidates the same bearer token', async () => {
      db.prepare('UPDATE users SET suspended = 1 WHERE email = ?').run('alice@example.com');
      assert.equal((await request('/api/accounts/me', {
        headers: { Authorization: `Bearer ${token}` }
      })).status, 403);
      assert.equal((await request('/api/auth/logout', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }
      })).status, 204);
      assert.equal((await request('/api/accounts/me', {
        headers: { Authorization: `Bearer ${token}` }
      })).status, 401);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
