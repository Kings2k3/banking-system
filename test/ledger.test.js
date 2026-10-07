const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');

test('ledger migration and demo internal transfers', async t => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'payvexis-ledger-'));
  process.env.DB_PATH = path.join(temporaryDirectory, 'app.db');
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.ADMIN_PASSWORD = '';
  process.env.DEMO_SEED = 'true';
  process.env.DEMO_INTERNAL_TRANSFERS = 'true';
  process.env.NODE_ENV = 'test';

  const app = require('../server/index');
  const { db } = require('../server/database');
  const { migrateLedger, ledgerIsReady, legacyCents } = require('../server/migrations/001_ledger');
  const { migrateAdminControls } = require('../server/migrations/002_admin_controls');
  const { migrateIdentityOwnership } = require('../server/migrations/003_identity_ownership');
  const { totpAt } = require('../server/services/staff-mfa');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, options) => fetch(`${base}${route}`, options);
  const login = async (email, password) => {
    const response = await request('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    assert.equal(response.status, 200);
    return (await response.json()).token;
  };

  try {
    const senderToken = await login('user@payvexis.com', 'UserPass123!');
    assert.equal(ledgerIsReady(db), false);
    await t.test('blocks transfer before migration', async () => {
      const response = await request('/api/transactions/transfer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${senderToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ recipient: '1111111111', amount: '10.00' })
      });
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /ledger migration/);
    });

    await t.test('imports each account once with balanced opening entries', () => {
      assert.throws(() => legacyCents(1.001, 7), /cannot be imported exactly/);
      assert.equal(migrateLedger(db), true);
      assert.equal(migrateLedger(db), false);
      assert.equal(ledgerIsReady(db), true);
      const account = db.prepare("SELECT balance_minor FROM ledger_accounts WHERE kind = 'customer'").get();
      assert.equal(account.balance_minor, 125075);
      const snapshot = db.prepare('SELECT opening_minor FROM legacy_balance_snapshots').get();
      assert.equal(snapshot.opening_minor, 125075);
      assert.equal(db.prepare('SELECT SUM(balance_minor) AS total FROM ledger_accounts').get().total, 0);
      assert.throws(() => db.prepare('UPDATE ledger_postings SET amount_minor = 1').run(), /immutable/);
    });

    const registered = await request('/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'bob@example.com', password: 'UniquePassword123!',
        firstName: 'Bob', lastName: 'Example', accountType: 'personal'
      })
    });
    assert.equal(registered.status, 201);
    const recipient = (await registered.json()).user;
    assert.equal(db.prepare('SELECT balance_minor FROM ledger_accounts WHERE user_id = ?').get(recipient.id).balance_minor, 0);

    const transfer = (amount, key = randomUUID()) => request('/api/transactions/transfer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${senderToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ recipient: recipient.accountNumber, amount })
    });

    await t.test('posts both sides once and returns the same receipt for a retry', async () => {
      const key = randomUUID();
      const first = await transfer('100.25', key);
      assert.equal(first.status, 200);
      const receipt = await first.json();
      assert.equal(receipt.balance, 1150.50);
      assert.equal(receipt.demo, true);
      const second = await transfer('100.25', key);
      assert.equal(second.status, 200);
      assert.equal((await second.json()).reference, receipt.reference);
      assert.equal((await transfer('99.00', key)).status, 409);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ledger_journals WHERE kind = 'internal_transfer'").get().count, 1);
      const postings = db.prepare(`SELECT SUM(p.amount_minor) AS total FROM ledger_postings p
        JOIN ledger_journals j ON j.id = p.journal_id WHERE j.reference = ?`).get(receipt.reference);
      assert.equal(postings.total, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE reference = ?').get(receipt.reference).count, 2);
      migrateAdminControls(db);
      migrateIdentityOwnership(db);
      const adminLogin = await request('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@payvexis.com', password: 'AdminPass123!' })
      });
      assert.equal(adminLogin.status, 202);
      const challenge = await adminLogin.json();
      const setup = await request('/api/auth/staff-mfa/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken: challenge.challengeToken })
      });
      const secret = (await setup.json()).secret;
      const completed = await request('/api/auth/staff-mfa/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken: challenge.challengeToken, purpose: 'enroll',
          code: totpAt(secret, Math.floor(Date.now() / 30000)) })
      });
      assert.equal(completed.status, 200);
      const adminToken = (await completed.json()).token;
      const trace = await request('/api/admin/ledger/journals', {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(trace.status, 200);
      const journals = (await trace.json()).journals;
      assert.equal(journals[0].reference, receipt.reference);
      assert.equal(journals[0].postings.reduce((sum, posting) => sum + posting.amountMinor, 0), 0);
    });

    await t.test('rejects imprecise and overdrawn amounts', async () => {
      assert.equal((await transfer('1.001')).status, 400);
      assert.equal((await transfer('999999.00')).status, 400);
    });

    await t.test('serializes attempts competing for one balance', async () => {
      const results = await Promise.all([transfer('1000.00'), transfer('1000.00')]);
      assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
      const sender = db.prepare("SELECT balance FROM users WHERE email = 'user@payvexis.com'").get();
      const receiver = db.prepare('SELECT balance FROM users WHERE id = ?').get(recipient.id);
      assert.equal(sender.balance, 150.50);
      assert.equal(receiver.balance, 1100.25);
      assert.equal(db.prepare('SELECT SUM(balance_minor) AS total FROM ledger_accounts').get().total, 0);
      const mismatches = db.prepare(`SELECT COUNT(*) AS count FROM ledger_accounts a
        WHERE a.balance_minor != COALESCE((SELECT SUM(p.amount_minor) FROM ledger_postings p
          WHERE p.account_id = a.id), 0)`).get().count;
      assert.equal(mismatches, 0);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
