const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');

test('verified shared accounts and two-person demo transfers', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'payvexis-shared-'));
  process.env.DB_PATH = path.join(directory, 'app.db');
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.DEMO_SEED = 'true';
  process.env.DEMO_INTERNAL_TRANSFERS = 'true';
  process.env.NODE_ENV = 'test';
  const app = require('../server/index');
  const { db } = require('../server/database');
  const { migrateLedger } = require('../server/migrations/001_ledger');
  const { migrateAdminControls } = require('../server/migrations/002_admin_controls');
  const { migrateIdentityOwnership } = require('../server/migrations/003_identity_ownership');
  const { migrateCustomerIdentity } = require('../server/migrations/004_customer_identity');
  const { migrateSharedAccounts } = require('../server/migrations/005_shared_accounts');
  const { migrateAdminWorkspace } = require('../server/migrations/006_admin_workspace');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (route, token, payload, key) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(payload)
  });
  const get = (route, token) => fetch(`${base}${route}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const mail = (to, subject) => fs.readdirSync(path.join(directory, 'dev-mailbox')).sort()
    .map(name => JSON.parse(fs.readFileSync(path.join(directory, 'dev-mailbox', name), 'utf8')))
    .filter(message => message.to === to && message.subject.includes(subject)).at(-1);
  const mailToken = message => new URLSearchParams(new URL(message.text.match(/https?:\/\/\S+/)[0]).hash.slice(1)).get('token');
  const register = async (email, extra = {}) => {
    const response = await api('/api/auth/register', null, {
      email, password: 'CustomerPassword123!', firstName: 'Casey', lastName: 'Member',
      accountType: 'personal', ...extra
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal((await api('/api/auth/verify-email', null,
      { token: mailToken(mail(email, 'Verify')) })).status, 200);
    return result;
  };
  const transfer = (token, accountId, recipient, amount, key = randomUUID()) =>
    api('/api/transactions/transfer', token,
      { accountId, recipient, amount }, key);

  try {
    migrateLedger(db); migrateAdminControls(db); migrateIdentityOwnership(db);
    migrateCustomerIdentity(db);
    assert.equal(migrateSharedAccounts(db), true);
    assert.equal(migrateSharedAccounts(db), false);
    assert.equal(migrateAdminWorkspace(db), true);
    const staff = db.prepare("SELECT id, email, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    const staffSessionId = randomUUID();
    db.prepare(`INSERT INTO auth_sessions (id, user_id, expires_at, staff_mfa_verified)
      VALUES (?, ?, ?, 1)`).run(staffSessionId, staff.id, new Date(Date.now() + 3600_000).toISOString());
    const staffToken = jwt.sign({ id: staff.id, email: staff.email, role: staff.role,
      jti: staffSessionId }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const joint = await register('joint-owner@example.com', {
      accountType: 'joint', jointFirstName: 'Jamie', jointLastName: 'Member',
      jointEmail: 'joint-partner@example.com'
    });
    const partner = await register('joint-partner@example.com');
    const source = db.prepare("SELECT account_number FROM users WHERE email = 'user@payvexis.com'").get();
    const jointAccount = db.prepare('SELECT id FROM customer_accounts WHERE ledger_account_id = (SELECT id FROM ledger_accounts WHERE user_id = ?)')
      .get(joint.user.id);

    await t.test('joint invitation requires verified holder and correct email', async () => {
      const wrong = await api(`/api/accounts/${jointAccount.id}/invitations`, joint.token,
        { email: 'wrong@example.com' });
      assert.equal(wrong.status, 409);
      const invite = await api(`/api/accounts/${jointAccount.id}/invitations`, joint.token,
        { email: 'joint-partner@example.com' });
      assert.equal(invite.status, 201);
      const token = mailToken(mail('joint-partner@example.com', 'Invitation'));
      assert.equal((await api('/api/accounts/invitations/accept', joint.token, { token })).status, 400);
      assert.equal((await api('/api/accounts/invitations/accept', partner.token, { token })).status, 200);
      assert.equal((await api('/api/accounts/invitations/accept', partner.token, { token })).status, 400);
      const members = await (await get(`/api/accounts/${jointAccount.id}/members`, partner.token)).json();
      assert.equal(members.members.length, 2);
      assert.equal(members.signingRule, 'two_signers');
      assert.equal((await get(`/api/accounts/number?accountId=${jointAccount.id}`, partner.token)).status, 200);
    });

    const seedLogin = await api('/api/auth/login', null,
      { email: 'user@payvexis.com', password: 'UserPass123!' });
    const seedToken = (await seedLogin.json()).token;
    assert.equal((await transfer(seedToken, undefined, joint.user.accountNumber, '1.00')).status, 403);
    db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE email = 'user@payvexis.com'")
      .run();
    assert.equal((await transfer(seedToken, undefined, joint.user.accountNumber, '100.00')).status, 200);

    await t.test('two signatures post once and expose account-scoped activity', async () => {
      db.prepare("UPDATE account_signing_policies SET rule = 'single_owner' WHERE account_id = ?")
        .run(jointAccount.id);
      assert.equal((await transfer(joint.token, jointAccount.id,
        partner.user.accountNumber, '1.00')).status, 409);
      db.prepare("UPDATE account_signing_policies SET rule = 'two_signers' WHERE account_id = ?")
        .run(jointAccount.id);
      const key = randomUUID();
      const proposed = await transfer(joint.token, jointAccount.id, partner.user.accountNumber, '25.00', key);
      assert.equal(proposed.status, 202);
      const pending = (await proposed.json()).request;
      assert.equal(pending.status, 'pending');
      assert.equal(pending.fundsReserved, false);
      const queue = await (await get('/api/admin/operations?type=shared_transfer', staffToken)).json();
      assert.ok(queue.operations.some(item => item.id === pending.id &&
        item.financialStatus === 'pending' && item.customerEmail === joint.user.email));
      const detail = await (await get(`/api/admin/operations/shared_transfer/${pending.id}`,
        staffToken)).json();
      assert.equal(detail.approvals.length, 1);
      assert.equal((await transfer(joint.token, jointAccount.id,
        partner.user.accountNumber, '25.00', key)).status, 202);
      assert.equal((await transfer(joint.token, jointAccount.id,
        partner.user.accountNumber, '26.00', key)).status, 409);
      db.prepare("UPDATE account_signing_policies SET rule = 'single_owner' WHERE account_id = ?")
        .run(jointAccount.id);
      assert.equal((await api(`/api/transactions/transfer-requests/${pending.id}/approve`,
        partner.token, {})).status, 409);
      db.prepare("UPDATE account_signing_policies SET rule = 'two_signers' WHERE account_id = ?")
        .run(jointAccount.id);
      assert.equal((await api(`/api/transactions/transfer-requests/${pending.id}/approve`,
        joint.token, {})).status, 200);
      const before = db.prepare('SELECT balance FROM users WHERE id = ?').get(joint.user.id).balance;
      assert.equal(before, 100);
      const recipientAccount = db.prepare(`SELECT a.id FROM customer_accounts a
        JOIN ledger_accounts l ON l.id = a.ledger_account_id
        WHERE l.account_number = ?`).get(partner.user.accountNumber);
      db.prepare(`UPDATE account_restrictions SET credit_blocked = 1,
        reason = 'Temporary credit review' WHERE account_id = ?`).run(recipientAccount.id);
      assert.equal((await api(`/api/transactions/transfer-requests/${pending.id}/approve`,
        partner.token, {})).status, 409);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transfer_approvals WHERE request_id = ?')
        .get(pending.id).n, 1);
      db.prepare("UPDATE account_restrictions SET credit_blocked = 0, reason = '' WHERE account_id = ?")
        .run(recipientAccount.id);
      const approved = await api(`/api/transactions/transfer-requests/${pending.id}/approve`,
        partner.token, {});
      assert.equal(approved.status, 200);
      const posted = (await approved.json()).request;
      assert.equal(posted.status, 'posted');
      assert.equal(posted.approvals, 2);
      assert.ok(posted.reference.startsWith('TRF'));
      assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(joint.user.id).balance, 75);
      assert.equal((await api(`/api/transactions/transfer-requests/${pending.id}/approve`,
        partner.token, {})).status, 200);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_journals WHERE reference = ?')
        .get(posted.reference).n, 1);
      db.prepare(`UPDATE account_restrictions SET debit_blocked = 1,
        reason = 'Temporary outbound review' WHERE account_id = ?`).run(jointAccount.id);
      const retry = await transfer(joint.token, jointAccount.id,
        partner.user.accountNumber, '25.00', key);
      assert.equal(retry.status, 202);
      assert.equal((await retry.json()).request.status, 'posted');
      db.prepare("UPDATE account_restrictions SET debit_blocked = 0, reason = '' WHERE account_id = ?")
        .run(jointAccount.id);
      const activity = await (await get(`/api/transactions?accountId=${jointAccount.id}`, partner.token)).json();
      assert.ok(activity.transactions.some(tx => tx.reference === posted.reference && tx.type === 'spend'));
      const allActivity = await (await get('/api/transactions', partner.token)).json();
      assert.ok(allActivity.transactions.some(tx => tx.reference === posted.reference));
      const unrelated = db.prepare(`SELECT a.id FROM customer_accounts a JOIN ledger_accounts l
        ON l.id = a.ledger_account_id WHERE l.account_number = ?`).get(source.account_number);
      assert.equal((await get(`/api/transactions?accountId=${unrelated.id}`, partner.token)).status, 404);
      assert.equal(db.prepare(`SELECT SUM(amount_minor) AS n FROM ledger_postings p
        JOIN ledger_journals j ON j.id = p.journal_id WHERE j.reference = ?`).get(posted.reference).n, 0);
    });

    await t.test('business operator needs an owner signature', async () => {
      const business = await register('business-owner@example.com', { accountType: 'business' });
      const operator = await register('business-operator@example.com');
      const businessAccount = db.prepare(`SELECT a.id FROM customer_accounts a JOIN ledger_accounts l
        ON l.id = a.ledger_account_id WHERE l.user_id = ?`).get(business.user.id);
      const invite = await api(`/api/accounts/${businessAccount.id}/invitations`, business.token,
        { email: operator.user.email, role: 'operator' });
      assert.equal(invite.status, 201);
      const token = mailToken(mail(operator.user.email, 'Invitation'));
      assert.equal((await api('/api/accounts/invitations/accept', operator.token, { token })).status, 200);
      assert.equal((await transfer(seedToken, undefined, business.user.accountNumber, '50.00')).status, 200);
      const proposed = await transfer(operator.token, businessAccount.id, joint.user.accountNumber, '10.00');
      assert.equal(proposed.status, 202);
      const id = (await proposed.json()).request.id;
      const approved = await api(`/api/transactions/transfer-requests/${id}/approve`, business.token, {});
      assert.equal((await approved.json()).request.status, 'posted');
      assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(business.user.id).balance, 40);
      assert.equal((await api(`/api/accounts/${businessAccount.id}/members/${operator.user.id}/revoke`,
        business.token, {})).status, 200);
      assert.equal((await transfer(operator.token, businessAccount.id, joint.user.accountNumber, '1.00')).status, 404);
    });

    assert.equal(db.pragma('foreign_key_check').length, 0);
    assert.equal(db.prepare('SELECT SUM(balance_minor) AS n FROM ledger_accounts').get().n, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
