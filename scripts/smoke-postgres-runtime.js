const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: process.argv[2], override: true, quiet: true });
const schema = process.argv[3];
if (!schema || schema === 'payvexis_app') throw new Error('Use a separate PostgreSQL test schema.');
process.env.DATABASE_SCHEMA = schema;
process.env.DB_ENGINE = 'postgres';
process.env.VERCEL = '0';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.STAFF_MFA_KEY = randomBytes(32).toString('hex');
process.env.ADMIN_PASSWORD = '';
process.env.SMTP_HOST = '';
process.env.RESEND_API_KEY = '';

async function mailboxToken(to, subject) {
  const folder = path.join(path.dirname(path.resolve(process.env.DB_PATH || './server/payvexis.db')),
    'dev-mailbox');
  for (const filename of await fs.readdir(folder)) {
    const message = JSON.parse(await fs.readFile(path.join(folder, filename), 'utf8'));
    if (message.to === to && message.subject === subject) {
      const token = message.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
      if (token) return token;
    }
  }
  throw new Error(`No ${subject} token found in the development mailbox.`);
}

const { db, initDB } = require('../server/database');
async function main() {
try {
  initDB();
  const email = `${randomUUID()}@example.invalid`;
  assert.equal(db.prepare('SELECT id FROM users WHERE email = ?').get(email), undefined);
  assert.throws(() => db.transaction(() => {
    const id = db.prepare(`INSERT INTO users
      (email, password_hash, first_name, last_name, account_number)
      VALUES (?, 'hash', 'Test', 'Rollback', ?)`)
      .run(email, String(Math.floor(1000000000 + Math.random() * 9000000000))).lastInsertRowid;
    assert.equal(typeof id, 'number');
    assert.equal(db.prepare('SELECT id AS accountId FROM users WHERE id = ?').get(id).accountId, id);
    throw new Error('rollback probe');
  })(), /rollback probe/);
  assert.equal(db.prepare('SELECT id FROM users WHERE email = ?').get(email), undefined);
  console.log('PostgreSQL runtime query, insert, alias, and rollback checks passed.');

  const app = require('../server/index');
  const server = app.listen(0);
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const accountEmail = `${randomUUID()}@example.invalid`;
    const password = 'SmokePassword123!';
    const register = await fetch(`${origin}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: accountEmail, password, firstName: 'Smoke',
        lastName: 'Test', accountType: 'personal' })
    });
    const registered = await register.json();
    assert.equal(register.status, 201, JSON.stringify(registered));
    assert.equal(registered.verificationDelivery, 'dev-mailbox');
    const verificationToken = await mailboxToken(accountEmail, 'Verify your Payvexis email');
    const verify = await fetch(`${origin}/api/auth/verify-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: verificationToken })
    });
    assert.equal(verify.status, 200, await verify.text());
    const login = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: accountEmail, password })
    });
    const loggedIn = await login.json();
    assert.equal(login.status, 200, JSON.stringify(loggedIn));
    const authHeaders = { Authorization: `Bearer ${loggedIn.token}` };
    const account = await fetch(`${origin}/api/accounts/me`, { headers: authHeaders });
    const accountBody = await account.json();
    assert.equal(account.status, 200, JSON.stringify(accountBody));
    assert.ok(accountBody.cards?.[0]?.id);
    const card = await fetch(`${origin}/api/accounts/cards/${accountBody.cards[0].id}`, {
      method: 'PUT', headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke card', holder: 'Smoke Test', nickname: 'Testing',
        theme: 'ocean', cardLimit: 1000, contactless: false, online: true,
        international: true, atm: false })
    });
    assert.equal(card.status, 200, await card.text());
    for (const route of ['/api/accounts/number', '/api/transactions',
      '/api/transactions/statement', '/api/support/tickets']) {
      const response = await fetch(`${origin}${route}`, { headers: authHeaders });
      assert.equal(response.status, 200, `${route}: ${await response.text()}`);
    }
    const ticket = await fetch(`${origin}/api/support/tickets`, {
      method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'PostgreSQL smoke check', message: 'Testing support persistence.' })
    });
    assert.equal(ticket.status, 201, await ticket.text());
    console.log('PostgreSQL registration, login, account, card, activity, and support checks passed.');

    const bcrypt = require('bcrypt');
    const { totpAt } = require('../server/services/staff-mfa');
    const adminEmail = `${randomUUID()}@example.invalid`;
    const adminPassword = 'SmokeAdminPassword123!';
    const adminId = db.transaction(() => {
      const result = db.prepare(`INSERT INTO users
        (email, password_hash, first_name, last_name, account_number, role)
        VALUES (?, ?, 'Smoke', 'Admin', ?, 'admin')`)
        .run(adminEmail, bcrypt.hashSync(adminPassword, 12),
          String(Math.floor(1000000000 + Math.random() * 9000000000)));
      db.prepare("INSERT INTO staff_memberships (user_id, staff_role) VALUES (?, 'owner')")
        .run(result.lastInsertRowid);
      return result.lastInsertRowid;
    })();
    assert.equal(typeof adminId, 'number');
    const adminLogin = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword })
    });
    const challenge = await adminLogin.json();
    assert.equal(adminLogin.status, 202, JSON.stringify(challenge));
    const setup = await fetch(`${origin}/api/auth/staff-mfa/setup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken: challenge.challengeToken })
    });
    const factor = await setup.json();
    assert.equal(setup.status, 200, JSON.stringify(factor));
    const completed = await fetch(`${origin}/api/auth/staff-mfa/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken: challenge.challengeToken, purpose: 'enroll',
        code: totpAt(factor.secret, Math.floor(Date.now() / 30000)) })
    });
    const staffSession = await completed.json();
    assert.equal(completed.status, 200, JSON.stringify(staffSession));
    const adminHeaders = { Authorization: `Bearer ${staffSession.token}` };
    for (const route of ['/api/admin/me', '/api/admin/stats', '/api/admin/users',
      '/api/admin/staff', '/api/admin/operations',
      `/api/admin/users/${registered.user.id}/workspace`]) {
      const response = await fetch(`${origin}${route}`, { headers: adminHeaders });
      assert.equal(response.status, 200, `${route}: ${await response.text()}`);
    }
    console.log('PostgreSQL staff MFA and admin workspace checks passed.');

    const accountId = accountBody.accounts[0].id;
    for (const route of [`/api/admin/users/${registered.user.id}`,
      `/api/admin/accounts/${accountId}`, '/api/admin/audit',
      '/api/admin/ledger/journals', '/api/admin/adjustments']) {
      const response = await fetch(`${origin}${route}`, { headers: adminHeaders });
      assert.equal(response.status, 200, `${route}: ${await response.text()}`);
    }
    const note = await fetch(`${origin}/api/admin/users/${registered.user.id}/notes`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'PostgreSQL admin note smoke check.' })
    });
    assert.equal(note.status, 201, await note.text());
    const restriction = await fetch(`${origin}/api/admin/accounts/${accountId}/restrictions`, {
      method: 'PATCH', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ debitBlocked: true, creditBlocked: false,
        reason: 'PostgreSQL restriction smoke check.' })
    });
    assert.equal(restriction.status, 200, await restriction.text());
    const freeze = await fetch(`${origin}/api/admin/cards/${accountBody.cards[0].id}/freeze`, {
      method: 'PUT', headers: adminHeaders
    });
    assert.equal(freeze.status, 200, await freeze.text());
    const workspace = await fetch(`${origin}/api/admin/users/${registered.user.id}/workspace`,
      { headers: adminHeaders });
    const workspaceBody = await workspace.json();
    assert.equal(workspace.status, 200, JSON.stringify(workspaceBody));
    assert.equal(workspaceBody.accounts[0].debitBlocked, 1);
    assert.ok(workspaceBody.notes.some(item => item.body === 'PostgreSQL admin note smoke check.'));
    console.log('PostgreSQL admin detail, audit, ledger, note, restriction, and card checks passed.');

    const inviteeEmail = `${randomUUID()}@example.invalid`;
    const ownerEmail = `${randomUUID()}@example.invalid`;
    let inviteeToken;
    let ownerToken;
    for (const person of [
      { email: inviteeEmail, accountType: 'personal', firstName: 'Invitee' },
      { email: ownerEmail, accountType: 'joint', firstName: 'Owner',
        jointFirstName: 'Invitee', jointLastName: 'Test', jointEmail: inviteeEmail }
    ]) {
      const response = await fetch(`${origin}/api/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...person, lastName: 'Test', password })
      });
      const body = await response.json();
      assert.equal(response.status, 201, JSON.stringify(body));
      const token = await mailboxToken(person.email, 'Verify your Payvexis email');
      const verification = await fetch(`${origin}/api/auth/verify-email`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      assert.equal(verification.status, 200, await verification.text());
      if (person.email === inviteeEmail) inviteeToken = body.token;
      else ownerToken = body.token;
    }
    const ownerAccounts = await fetch(`${origin}/api/accounts`, {
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    const ownerAccountsBody = await ownerAccounts.json();
    assert.equal(ownerAccounts.status, 200, JSON.stringify(ownerAccountsBody));
    const jointId = ownerAccountsBody.accounts[0].id;
    const invitation = await fetch(`${origin}/api/accounts/${jointId}/invitations`, {
      method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json' },
      body: JSON.stringify({ email: inviteeEmail })
    });
    assert.equal(invitation.status, 201, await invitation.text());
    const inviteToken = await mailboxToken(inviteeEmail, 'Invitation to a Payvexis account');
    const accept = await fetch(`${origin}/api/accounts/invitations/accept`, {
      method: 'POST', headers: { Authorization: `Bearer ${inviteeToken}`,
        'Content-Type': 'application/json' },
      body: JSON.stringify({ token: inviteToken })
    });
    assert.equal(accept.status, 200, await accept.text());
    const members = await fetch(`${origin}/api/accounts/${jointId}/members`, {
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    const membersBody = await members.json();
    assert.equal(members.status, 200, JSON.stringify(membersBody));
    assert.equal(membersBody.members.length, 2);
    console.log('PostgreSQL email verification and joint-account invitation checks passed.');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
} finally {
  db.close();
}
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
