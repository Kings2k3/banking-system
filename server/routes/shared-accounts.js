const express = require('express');
const { randomBytes, createHash } = require('node:crypto');
const { db } = require('../database');
const { asyncHandler } = require('../utils/helpers');
const auth = require('../middleware/auth');
const { sharedAccountsReady } = require('../migrations/005_shared_accounts');
const { accountForUser } = require('../services/ownership');
const { deliverMail, actionLink } = require('../services/mail');
const config = require('../config');
const { emailActionLimiter } = require('../middleware/rateLimiter');

const router = express.Router();
router.use(auth);
function requireShared(req, res, next) {
  if (req.user.role !== 'user') return res.status(403).json({ error: 'Customer access required.' });
  if (!sharedAccountsReady(db)) return res.status(503).json({ error: 'Shared accounts are unavailable.' });
  next();
}

function hash(token) { return createHash('sha256').update(token).digest('hex'); }
function verified(userId) {
  return !!db.prepare('SELECT 1 FROM users WHERE id = ? AND email_verified_at IS NOT NULL')
    .get(userId);
}
function event(accountId, actorId, type, details = '') {
  db.prepare('INSERT INTO account_events (account_id, actor_user_id, event_type, details) VALUES (?, ?, ?, ?)')
    .run(accountId, actorId, type, details);
}

router.get('/:id/members', requireShared, (req, res) => {
  const account = accountForUser(db, req.user.id, req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  const members = db.prepare(`SELECT m.user_id AS userId, m.member_role AS role,
    m.status, m.accepted_at AS acceptedAt, u.first_name AS firstName,
    u.last_name AS lastName, u.email
    FROM account_memberships m JOIN users u ON u.id = m.user_id
    WHERE m.account_id = ? AND m.status = 'active' ORDER BY m.created_at, m.user_id`)
    .all(account.id);
  const policy = db.prepare('SELECT rule FROM account_signing_policies WHERE account_id = ?').get(account.id);
  res.json({ members, signingRule: policy.rule, accountId: account.id });
});

router.get('/:id/invitations', requireShared, (req, res) => {
  const account = accountForUser(db, req.user.id, req.params.id);
  if (!account || account.memberRole !== 'owner') return res.status(404).json({ error: 'Account not found.' });
  const invitations = db.prepare(`SELECT id, email, member_role AS role, expires_at AS expiresAt,
    accepted_at AS acceptedAt, revoked_at AS revokedAt, created_at AS createdAt
    FROM account_invitations WHERE account_id = ? ORDER BY id DESC LIMIT 30`).all(account.id);
  res.json({ invitations });
});

router.post('/:id/invitations', requireShared, emailActionLimiter, asyncHandler(async (req, res) => {
  if (!config.EMAIL_ACTIONS_ENABLED) return res.status(503).json({ error: 'Member invitations are temporarily unavailable.' });
  const account = accountForUser(db, req.user.id, req.params.id);
  if (!account || account.memberRole !== 'owner' || account.status !== 'active') {
    return res.status(404).json({ error: 'Account not found or invitation unavailable.' });
  }
  if (!verified(req.user.id)) return res.status(403).json({ error: 'Verify your email before inviting a member.' });
  if (!['joint', 'business'].includes(account.requestedType)) {
    return res.status(409).json({ error: 'This account does not support shared ownership.' });
  }
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const role = account.requestedType === 'joint' ? 'owner' : req.body?.role;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
      (account.requestedType === 'business' && !['owner', 'operator', 'viewer'].includes(role))) {
    return res.status(400).json({ error: 'Provide a valid email and membership role.' });
  }
  if (email === req.user.email.toLowerCase()) return res.status(400).json({ error: 'Invite a different person.' });
  if (db.prepare(`SELECT COUNT(*) AS n FROM account_invitations
    WHERE account_id = ? AND created_at >= datetime('now', '-1 day')`).get(account.id).n >= 10) {
    return res.status(429).json({ error: 'Invitation limit reached for this account today.' });
  }
  if (account.requestedType === 'joint') {
    const primary = db.prepare(`SELECT u.joint_email FROM customer_accounts a
      JOIN ledger_accounts l ON l.id = a.ledger_account_id JOIN users u ON u.id = l.user_id
      WHERE a.id = ?`).get(account.id);
    if (primary.joint_email && primary.joint_email.toLowerCase() !== email) {
      return res.status(409).json({ error: 'The invite must match the joint holder named at registration.' });
    }
  }
  const invitationToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  let invitationId;
  try {
    invitationId = db.transaction(() => {
      if (db.prepare(`SELECT 1 FROM account_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.account_id = ? AND lower(u.email) = ? AND m.status = 'active'`).get(account.id, email)) {
        const error = new Error('This person is already a member.'); error.statusCode = 409; throw error;
      }
      if (account.requestedType === 'joint' && db.prepare(`SELECT COUNT(*) AS n FROM account_memberships
        WHERE account_id = ? AND member_role = 'owner' AND status = 'active'`).get(account.id).n >= 2) {
        const error = new Error('Joint account already has two owners.'); error.statusCode = 409; throw error;
      }
      db.prepare(`UPDATE account_invitations SET revoked_at = datetime('now')
        WHERE account_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL`)
        .run(account.id, email);
      const id = db.prepare(`INSERT INTO account_invitations
        (account_id, email, member_role, token_hash, expires_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?)`).run(account.id, email, role, hash(invitationToken),
          expiresAt, req.user.id).lastInsertRowid;
      event(account.id, req.user.id, 'member_invited', `${email} as ${role}`);
      return id;
    }).immediate();
    await deliverMail({ to: email, subject: 'Invitation to a Payvexis account',
      text: `You have been invited to a ${account.requestedType} account as ${role}. Sign in with a verified email, then open this link within 24 hours:\n${actionLink('account-invite.html', invitationToken)}` });
  } catch (error) {
    if (invitationId) db.prepare("UPDATE account_invitations SET revoked_at = datetime('now') WHERE id = ?")
      .run(invitationId);
    throw error;
  }
  res.status(201).json({ invitationId, email, role, expiresAt });
}));

router.post('/invitations/accept', requireShared, (req, res) => {
  if (!verified(req.user.id)) return res.status(403).json({ error: 'Verify your email before accepting an invitation.' });
  const token = req.body?.token;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
    return res.status(400).json({ error: 'Invitation is invalid or expired.' });
  }
  const result = db.transaction(() => {
    const invitation = db.prepare(`SELECT i.*, a.requested_type, a.status AS account_status
      FROM account_invitations i JOIN customer_accounts a ON a.id = i.account_id
      WHERE i.token_hash = ?`).get(hash(token));
    if (!invitation || invitation.accepted_at || invitation.revoked_at ||
        Date.parse(invitation.expires_at) <= Date.now() || invitation.account_status !== 'active' ||
        invitation.email !== req.user.email.toLowerCase()) return null;
    if (db.prepare(`SELECT 1 FROM account_memberships WHERE account_id = ? AND user_id = ?
      AND status = 'active'`).get(invitation.account_id, req.user.id)) return null;
    if (invitation.requested_type === 'joint' && db.prepare(`SELECT COUNT(*) AS n FROM account_memberships
      WHERE account_id = ? AND member_role = 'owner' AND status = 'active'`)
      .get(invitation.account_id).n >= 2) return null;
    db.prepare(`INSERT INTO account_memberships
      (account_id, user_id, member_role, status, accepted_at)
      VALUES (?, ?, ?, 'active', datetime('now'))
      ON CONFLICT(account_id, user_id) DO UPDATE SET
        member_role = excluded.member_role, status = 'active', accepted_at = datetime('now')`)
      .run(invitation.account_id, req.user.id, invitation.member_role);
    db.prepare(`UPDATE account_invitations SET accepted_by = ?, accepted_at = datetime('now') WHERE id = ?`)
      .run(req.user.id, invitation.id);
    db.prepare(`UPDATE customer_accounts SET ownership_kind = ?, display_name = ? WHERE id = ?`)
      .run(invitation.requested_type === 'joint' ? 'joint' : 'organization',
        invitation.requested_type === 'joint' ? 'Joint Checking' : 'Business Checking', invitation.account_id);
    db.prepare(`UPDATE account_signing_policies SET rule = 'two_signers', updated_at = datetime('now')
      WHERE account_id = ?`).run(invitation.account_id);
    event(invitation.account_id, req.user.id, 'member_joined', invitation.member_role);
    return { accountId: invitation.account_id, role: invitation.member_role };
  }).immediate();
  if (!result) return res.status(400).json({ error: 'Invitation is invalid or expired.' });
  res.json(result);
});

router.post('/:id/members/:userId/revoke', requireShared, (req, res) => {
  const account = accountForUser(db, req.user.id, req.params.id);
  if (!account || account.memberRole !== 'owner' || account.requestedType !== 'business') {
    return res.status(404).json({ error: 'Account not found.' });
  }
  const targetId = Number(req.params.userId);
  const member = db.prepare(`SELECT member_role AS role FROM account_memberships
    WHERE account_id = ? AND user_id = ? AND status = 'active'`).get(account.id, targetId);
  if (!member || member.role === 'owner') return res.status(409).json({ error: 'Only non-owner business members can be revoked here.' });
  db.transaction(() => {
    db.prepare("UPDATE account_memberships SET status = 'revoked' WHERE account_id = ? AND user_id = ?")
      .run(account.id, targetId);
    event(account.id, req.user.id, 'member_revoked', String(targetId));
  }).immediate();
  res.json({ revoked: true });
});

module.exports = router;
