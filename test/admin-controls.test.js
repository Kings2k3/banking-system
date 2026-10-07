const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');

test('staff permissions and independently approved adjustments', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'payvexis-admin-'));
  process.env.DB_PATH = path.join(directory, 'app.db');
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.ADMIN_PASSWORD = '';
  process.env.DEMO_SEED = 'true';
  process.env.DEMO_INTERNAL_TRANSFERS = 'true';
  process.env.DEMO_ADMIN_ADJUSTMENTS = 'true';
  process.env.NODE_ENV = 'test';

  const app = require('../server/index');
  const { db } = require('../server/database');
  const { migrateLedger } = require('../server/migrations/001_ledger');
  const { migrateAdminControls } = require('../server/migrations/002_admin_controls');
  const { migrateIdentityOwnership } = require('../server/migrations/003_identity_ownership');
  const { totpAt } = require('../server/services/staff-mfa');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, options) => fetch(`${base}${route}`, options);
  const json = (route, token, payload, key, method = 'POST') => request(route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(payload)
  });
  const mfaSecrets = {};
  const mfaRecoveries = {};
  const login = async (email, password) => {
    const response = await json('/api/auth/login', null, { email, password });
    if (response.status === 200) return (await response.json()).token;
    assert.equal(response.status, 202);
    const challenge = await response.json();
    assert.equal(challenge.token, undefined);
    let secret;
    if (challenge.setupRequired) {
      const setup = await json('/api/auth/staff-mfa/setup', null,
        { challengeToken: challenge.challengeToken });
      assert.equal(setup.status, 200);
      secret = (await setup.json()).secret;
    } else {
      secret = mfaSecrets[email];
    }
    assert.ok(secret);
    const result = await json('/api/auth/staff-mfa/complete', null, {
      challengeToken: challenge.challengeToken,
      purpose: challenge.setupRequired ? 'enroll' : 'login',
      code: totpAt(secret, Math.floor(Date.now() / 30000))
    });
    assert.equal(result.status, 200);
    const completed = await result.json();
    mfaSecrets[email] = secret;
    if (challenge.setupRequired) {
      assert.equal(completed.recoveryCodes.length, 8);
      mfaRecoveries[email] = completed.recoveryCodes;
    }
    return completed.token;
  };

  try {
    migrateLedger(db);
    const customer = await json('/api/auth/register', null, {
      email: 'customer@example.com', password: 'CustomerPassword123!',
      firstName: 'Casey', lastName: 'Customer', accountType: 'personal'
    });
    assert.equal(customer.status, 201);
    const target = (await customer.json()).user;
    const senderToken = await login('user@payvexis.com', 'UserPass123!');
    const oldTransfer = await json('/api/transactions/transfer', senderToken,
      { recipient: target.accountNumber, amount: '5.00' }, randomUUID());
    assert.equal(oldTransfer.status, 200);
    const transferReference = (await oldTransfer.json()).reference;

    await t.test('migration preserves postings and maps the first admin to owner', () => {
      assert.equal(migrateAdminControls(db), true);
      assert.equal(migrateAdminControls(db), false);
      assert.equal(migrateIdentityOwnership(db), true);
      assert.equal(migrateIdentityOwnership(db), false);
      assert.equal(db.pragma('foreign_key_check').length, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ledger_journals WHERE reference = ?').get(transferReference).count, 1);
      assert.equal(db.prepare("SELECT staff_role FROM staff_memberships ORDER BY user_id LIMIT 1").get().staff_role, 'owner');
      assert.equal(db.prepare('SELECT SUM(balance_minor) AS total FROM ledger_accounts').get().total, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_accounts').get().count,
        db.prepare("SELECT COUNT(*) AS count FROM ledger_accounts WHERE kind = 'customer'").get().count);
    });

    await t.test('customer account access follows membership', async () => {
      const alice = await login('user@payvexis.com', 'UserPass123!');
      const accounts = await (await request('/api/accounts', {
        headers: { Authorization: `Bearer ${alice}` }
      })).json();
      assert.equal(accounts.accounts.length, 1);
      assert.equal(accounts.accounts[0].memberRole, 'owner');
      const otherAccount = db.prepare(`SELECT a.id FROM customer_accounts a
        JOIN ledger_accounts l ON l.id = a.ledger_account_id WHERE l.user_id = ?`).get(target.id);
      assert.equal((await request(`/api/accounts/${otherAccount.id}`, {
        headers: { Authorization: `Bearer ${alice}` }
      })).status, 404);
      assert.equal((await request(`/api/accounts/number?accountId=${otherAccount.id}`, {
        headers: { Authorization: `Bearer ${alice}` }
      })).status, 404);
      const newCustomer = await json('/api/auth/register', null, {
        email: 'new-customer@example.com', password: 'CustomerPassword123!',
        firstName: 'New', lastName: 'Customer', accountType: 'personal'
      });
      assert.equal(newCustomer.status, 201);
      const { user: newUser, token: newToken } = await newCustomer.json();
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM account_memberships m
        JOIN customer_accounts a ON a.id = m.account_id
        JOIN ledger_accounts l ON l.id = a.ledger_account_id
        WHERE m.user_id = ? AND l.user_id = ? AND m.member_role = 'owner'`)
        .get(newUser.id, newUser.id).count, 1);
      db.prepare('UPDATE account_memberships SET status = ? WHERE user_id = ?')
        .run('revoked', newUser.id);
      assert.equal((await request('/api/accounts/me', {
        headers: { Authorization: `Bearer ${newToken}` }
      })).status, 409);
      assert.equal((await json('/api/transactions/transfer', newToken,
        { recipient: target.accountNumber, amount: '1.00' }, randomUUID())).status, 403);
      db.prepare('UPDATE account_memberships SET status = ? WHERE user_id = ?')
        .run('active', newUser.id);
    });

    const ownerToken = await login('admin@payvexis.com', 'AdminPass123!');
    await t.test('staff MFA requires a fresh code or unused recovery code', async () => {
      const secret = mfaSecrets['admin@payvexis.com'];
      const stored = db.prepare('SELECT encrypted_secret FROM staff_mfa_factors WHERE user_id = 1').get();
      assert.ok(stored?.encrypted_secret.startsWith('v1:'));
      assert.ok(!stored.encrypted_secret.includes(secret));
      const response = await json('/api/auth/login', null,
        { email: 'admin@payvexis.com', password: 'AdminPass123!' });
      assert.equal(response.status, 202);
      const challenge = await response.json();
      assert.equal(challenge.setupRequired, false);
      const replay = await json('/api/auth/staff-mfa/complete', null, {
        challengeToken: challenge.challengeToken, purpose: 'login',
        code: totpAt(secret, Math.floor(Date.now() / 30000))
      });
      assert.equal(replay.status, 401);
      const recoveryCode = mfaRecoveries['admin@payvexis.com'][0];
      const recovered = await json('/api/auth/staff-mfa/complete', null, {
        challengeToken: challenge.challengeToken, purpose: 'login', recoveryCode
      });
      assert.equal(recovered.status, 200);
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM audit_log
        WHERE action = 'staff_mfa_recovery_login'`).get().count, 1);
      assert.equal((await json('/api/auth/staff-mfa/complete', null, {
        challengeToken: challenge.challengeToken, purpose: 'login', recoveryCode
      })).status, 401);
    });
    const owner = await (await request('/api/admin/me', { headers: { Authorization: `Bearer ${ownerToken}` } })).json();
    assert.equal(owner.role, 'owner');

    async function invite(email, role, firstName) {
      const invited = await json('/api/admin/staff/invitations', ownerToken, { email, role });
      assert.equal(invited.status, 201);
      const { invitationCode } = await invited.json();
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM staff_invitations WHERE token_hash = ?').get(invitationCode).count, 0);
      const accepted = await json('/api/auth/accept-staff-invite', null, {
        invitationCode, firstName, lastName: 'Staff', password: 'StaffPassword123!'
      });
      assert.equal(accepted.status, 201);
      return login(email, 'StaffPassword123!');
    }

    const operatorToken = await invite('operator@example.com', 'finance_operator', 'Morgan');
    const approverToken = await invite('approver@example.com', 'finance_approver', 'Jordan');
    const startingBalance = db.prepare('SELECT balance FROM users WHERE id = ?').get(target.id).balance;

    await t.test('proposal is idempotent and cannot itself change money', async () => {
      const key = randomUUID();
      const payload = { userId: target.id, type: 'credit', amount: '25.00',
        reason: 'Correct a verified account posting', senderName: 'Review team' };
      const first = await json('/api/admin/adjustments', operatorToken, payload, key);
      assert.equal(first.status, 201);
      const proposed = (await first.json()).adjustment;
      assert.equal(proposed.status, 'pending');
      assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(target.id).balance, startingBalance);
      const again = await json('/api/admin/adjustments', operatorToken, payload, key);
      assert.equal((await again.json()).adjustment.id, proposed.id);
      assert.equal((await json('/api/admin/adjustments', operatorToken,
        { ...payload, amount: '26.00' }, key)).status, 409);
      assert.equal((await json(`/api/admin/adjustments/${proposed.id}/approve`, operatorToken, {})).status, 403);
      assert.equal((await json('/api/admin/adjustments', approverToken, payload, randomUUID())).status, 403);

      const approved = await json(`/api/admin/adjustments/${proposed.id}/approve`, approverToken,
        { note: 'Evidence reviewed' });
      assert.equal(approved.status, 200);
      const result = (await approved.json()).adjustment;
      assert.equal(result.status, 'approved');
      assert.ok(result.journalReference.startsWith('ADJ'));
      assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(target.id).balance, startingBalance + 25);
      assert.equal((await json(`/api/admin/adjustments/${proposed.id}/approve`, approverToken, {})).status, 200);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ledger_journals WHERE reference = ?').get(result.journalReference).count, 1);
      assert.equal(db.prepare(`SELECT SUM(p.amount_minor) AS total FROM ledger_postings p
        JOIN ledger_journals j ON j.id = p.journal_id WHERE j.reference = ?`).get(result.journalReference).total, 0);
    });

    await t.test('approval stops if account ownership changes after proposal', async () => {
      const proposed = await json('/api/admin/adjustments', operatorToken,
        { userId: target.id, type: 'credit', amount: '1.00',
          reason: 'Review an ownership change before credit' }, randomUUID());
      assert.equal(proposed.status, 201);
      const id = (await proposed.json()).adjustment.id;
      db.prepare('UPDATE account_memberships SET status = ? WHERE user_id = ?')
        .run('revoked', target.id);
      assert.equal((await json(`/api/admin/adjustments/${id}/approve`, approverToken, {})).status, 409);
      assert.equal(db.prepare('SELECT status FROM adjustment_requests WHERE id = ?').get(id).status, 'pending');
      db.prepare('UPDATE account_memberships SET status = ? WHERE user_id = ?')
        .run('active', target.id);
      assert.equal((await json(`/api/admin/adjustments/${id}/reject`, approverToken,
        { note: 'Ownership check was interrupted' })).status, 200);
    });

    await t.test('owner cannot approve own proposal; declined debit does not post', async () => {
      const proposalResponse = await json('/api/admin/adjustments', ownerToken,
        { userId: target.id, type: 'debit', amount: '9999.00',
          reason: 'Investigate unsupported debit adjustment' }, randomUUID());
      assert.equal(proposalResponse.status, 201);
      const proposal = (await proposalResponse.json()).adjustment;
      assert.equal((await json(`/api/admin/adjustments/${proposal.id}/approve`, ownerToken, {})).status, 403);
      assert.equal((await json(`/api/admin/adjustments/${proposal.id}/approve`, approverToken, {})).status, 400);
      const before = db.prepare('SELECT balance FROM users WHERE id = ?').get(target.id).balance;
      const rejected = await json(`/api/admin/adjustments/${proposal.id}/reject`, approverToken,
        { note: 'Debit exceeds available balance' });
      assert.equal((await rejected.json()).adjustment.status, 'rejected');
      assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(target.id).balance, before);
    });

    await t.test('owner role controls and deactivation revoke staff sessions', async () => {
      const staff = await (await request('/api/admin/staff', { headers: { Authorization: `Bearer ${ownerToken}` } })).json();
      const approver = staff.staff.find(person => person.email === 'approver@example.com');
      assert.equal((await request('/api/admin/staff', { headers: { Authorization: `Bearer ${operatorToken}` } })).status, 403);
      assert.equal((await json(`/api/admin/staff/${approver.id}/active`, ownerToken, { active: false })).status, 200);
      assert.equal((await request('/api/admin/me', { headers: { Authorization: `Bearer ${approverToken}` } })).status, 401);
      assert.equal(db.prepare('SELECT SUM(balance_minor) AS total FROM ledger_accounts').get().total, 0);
      assert.equal(db.pragma('foreign_key_check').length, 0);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
