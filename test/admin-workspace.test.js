const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');

test('admin customer workspace and investigation queue', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'payvexis-workspace-'));
  process.env.DB_PATH = path.join(directory, 'app.db');
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.DEMO_SEED = 'true';
  process.env.DEMO_INTERNAL_TRANSFERS = 'true';
  process.env.DEMO_ADMIN_ADJUSTMENTS = 'true';
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
  const session = user => {
    const id = randomUUID();
    db.prepare(`INSERT INTO auth_sessions (id, user_id, expires_at, staff_mfa_verified)
      VALUES (?, ?, ?, ?)`).run(id, user.id,
        new Date(Date.now() + 3600_000).toISOString(), user.role === 'admin' ? 1 : 0);
    return jwt.sign({ id: user.id, email: user.email, role: user.role, jti: id },
      process.env.JWT_SECRET, { expiresIn: '1h' });
  };
  const call = (route, token, method = 'GET', body, key) => fetch(`${base}${route}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  try {
    migrateLedger(db); migrateAdminControls(db); migrateIdentityOwnership(db);
    migrateCustomerIdentity(db); migrateSharedAccounts(db);
    assert.equal(migrateAdminWorkspace(db), true);
    assert.equal(migrateAdminWorkspace(db), false);
    const owner = db.prepare("SELECT id, email, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
      .get();
    const source = db.prepare("SELECT id, email, role, account_number AS accountNumber FROM users WHERE role = 'user' ORDER BY id LIMIT 1")
      .get();
    const ownerToken = session(owner);
    const customerToken = session(source);
    db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?").run(source.id);
    const signup = await call('/api/auth/register', null, 'POST', {
      email: 'second@example.com', password: 'CustomerPassword123!',
      firstName: 'Second', lastName: 'Customer', accountType: 'personal'
    });
    assert.equal(signup.status, 201);
    const recipient = (await signup.json()).user;
    const sourceAccount = db.prepare(`SELECT a.id FROM customer_accounts a
      JOIN ledger_accounts l ON l.id = a.ledger_account_id WHERE l.user_id = ?`).get(source.id);
    const recipientAccount = db.prepare(`SELECT a.id FROM customer_accounts a
      JOIN ledger_accounts l ON l.id = a.ledger_account_id WHERE l.user_id = ?`).get(recipient.id);
    assert.ok(db.prepare('SELECT 1 FROM account_restrictions WHERE account_id = ?')
      .get(recipientAccount.id));

    await t.test('customer data, internal notes, and session revocation respect permissions', async () => {
      const workspace = await call(`/api/admin/users/${source.id}/workspace`, ownerToken);
      assert.equal(workspace.status, 200);
      const details = await workspace.json();
      assert.equal(details.accounts.length, 1);
      assert.equal(details.accounts[0].members[0].role, 'owner');
      assert.ok(details.sessions.activeCount >= 1);
      const note = await call(`/api/admin/users/${source.id}/notes`, ownerToken,
        'POST', { body: 'Customer requested a call about account access.' });
      assert.equal(note.status, 201);
      const afterNote = await (await call(`/api/admin/users/${source.id}/workspace`, ownerToken)).json();
      assert.equal(afterNote.notes.length, 1);
      assert.equal(afterNote.notes[0].body, 'Customer requested a call about account access.');
      const revoked = await call(`/api/admin/users/${source.id}/sessions/revoke`, ownerToken, 'POST');
      assert.equal(revoked.status, 200);
      assert.ok((await revoked.json()).revoked >= 1);
      assert.equal((await call('/api/accounts', customerToken)).status, 401);
    });

    const freshCustomerToken = session(source);
    const transfer = () => call('/api/transactions/transfer', freshCustomerToken,
      'POST', { recipient: recipient.accountNumber, amount: '1.00' }, randomUUID());
    const restrict = (accountId, debitBlocked, creditBlocked, reason) =>
      call(`/api/admin/accounts/${accountId}/restrictions`, ownerToken, 'PATCH',
        { debitBlocked, creditBlocked, reason });

    await t.test('account restrictions block debits and credits before posting', async () => {
      assert.equal((await restrict(sourceAccount.id, true, false,
        'Review requested after unusual outgoing activity.')).status, 200);
      const before = db.prepare('SELECT COUNT(*) AS n FROM ledger_journals').get().n;
      assert.equal((await transfer()).status, 409);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_journals').get().n, before);
      assert.equal((await restrict(sourceAccount.id, false, false,
        'Outgoing activity review has been completed.')).status, 200);
      assert.equal((await restrict(recipientAccount.id, false, true,
        'Incoming credits are paused for account review.')).status, 200);
      assert.equal((await transfer()).status, 409);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_journals').get().n, before);
      assert.equal((await restrict(recipientAccount.id, false, false,
        'Incoming credit review has been completed.')).status, 200);
      assert.equal((await transfer()).status, 200);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_journals').get().n, before + 1);
    });

    await t.test('operation review is audited and never decides an adjustment', async () => {
      const proposal = await call('/api/admin/adjustments', ownerToken, 'POST', {
        userId: recipient.id, type: 'credit', amount: '10.00',
        reason: 'Reviewing a possible correction before approval.', senderName: 'Operations'
      }, randomUUID());
      assert.equal(proposal.status, 201);
      const adjustment = (await proposal.json()).adjustment;
      const listed = await call('/api/admin/operations?type=adjustment&status=pending', ownerToken);
      assert.equal(listed.status, 200);
      const queue = await listed.json();
      assert.ok(queue.operations.some(item => item.id === adjustment.id));
      const before = db.prepare('SELECT COUNT(*) AS n FROM ledger_journals').get().n;
      const review = await call(`/api/admin/operations/adjustment/${adjustment.id}/review`,
        ownerToken, 'POST', { state: 'investigating', note: 'Checking the supporting customer evidence.' });
      assert.equal(review.status, 200);
      assert.equal((await review.json()).operation.financialStatus, 'pending');
      const detail = await (await call(`/api/admin/operations/adjustment/${adjustment.id}`,
        ownerToken)).json();
      assert.equal(detail.reviewEvents.length, 1);
      assert.equal(detail.operation.reviewState, 'investigating');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_journals').get().n, before);
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_log
        WHERE action = 'operation_review_updated' AND target_id = ?`).get(adjustment.id).n, 1);
      const staffId = db.prepare(`INSERT INTO users (email, password_hash,
        first_name, last_name, account_number, role)
        VALUES ('approver@example.com', 'hash', 'Finance', 'Approver', ?, 'admin')`)
        .run(`STAFF-${randomUUID()}`).lastInsertRowid;
      db.prepare(`INSERT INTO staff_memberships (user_id, staff_role, created_by)
        VALUES (?, 'finance_approver', ?)`).run(staffId, owner.id);
      const approverToken = session({ id: staffId, email: 'approver@example.com', role: 'admin' });
      assert.equal((await call('/api/admin/operations', approverToken)).status, 200);
      assert.equal((await call(`/api/admin/operations/adjustment/${adjustment.id}/review`,
        approverToken, 'POST', { state: 'resolved', note: 'The evidence is complete.' })).status, 403);
      const approverWorkspace = await (await call(`/api/admin/users/${source.id}/workspace`,
        approverToken)).json();
      assert.equal(approverWorkspace.notes.length, 0);
      assert.equal((await call(`/api/admin/users/${source.id}/notes`, approverToken,
        'POST', { body: 'Unauthorized note.' })).status, 403);
      assert.equal((await call(`/api/admin/accounts/${sourceAccount.id}/restrictions`, approverToken,
        'PATCH', { debitBlocked: true, creditBlocked: false,
          reason: 'Unauthorized restriction attempt.' })).status, 403);
    });

    assert.equal(db.pragma('foreign_key_check').length, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ledger_accounts a WHERE a.balance_minor <>
      COALESCE((SELECT SUM(amount_minor) FROM ledger_postings p WHERE p.account_id = a.id), 0)`)
      .get().n, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
