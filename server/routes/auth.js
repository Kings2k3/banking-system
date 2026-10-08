const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { randomUUID, createHash } = require('crypto');
const { db } = require('../database');
const config = require('../config');
const { asyncHandler, generateAccountNumber, logAuditAction } = require('../utils/helpers');
const { validateRegistration, validateLogin } = require('../middleware/validate');
const { authLimiter, mfaLimiter, emailActionLimiter } = require('../middleware/rateLimiter');
const auth = require('../middleware/auth');
const { ledgerIsReady } = require('../migrations/001_ledger');
const { adminControlsReady } = require('../migrations/002_admin_controls');
const { identityOwnershipReady } = require('../migrations/003_identity_ownership');
const { startChallenge, setupChallenge, completeChallenge } = require('../services/staff-mfa');
const { customerIdentityReady } = require('../migrations/004_customer_identity');
const { issueActionToken, invalidateDelivery, consumeEmailVerification,
  consumePasswordReset } = require('../services/customer-identity');
const { deliverMail, actionLink } = require('../services/mail');
const { sharedAccountsReady } = require('../migrations/005_shared_accounts');
const { adminWorkspaceReady } = require('../migrations/006_admin_workspace');

const router = express.Router();

router.post(['/login', '/register', '/accept-staff-invite'], authLimiter);
router.post(['/staff-mfa/setup', '/staff-mfa/complete'], mfaLimiter);
router.post(['/resend-verification', '/verify-email', '/password-reset/request',
  '/password-reset/complete'], emailActionLimiter);

router.get('/capabilities', (req, res) => {
  res.json({ emailActionsEnabled: config.EMAIL_ACTIONS_ENABLED });
});

async function deliverAction(db, userId, purpose) {
  const action = issueActionToken(db, userId, purpose);
  if (!action) return 'not-issued';
  const verification = purpose === 'verify_email';
  try {
    return await deliverMail({
      to: action.to,
      subject: verification ? 'Verify your Payvexis email' : 'Reset your Payvexis password',
      text: verification
        ? `Open this link to verify your email (valid for 24 hours):\n${actionLink('verify-email.html', action.token)}`
        : `Open this link to reset your password (valid for 30 minutes):\n${actionLink('recover-account.html', action.token)}\nIf you did not request this, ignore this message.`
    });
  } catch (error) {
    invalidateDelivery(db, action.tokenHash);
    console.error(`Email delivery failed for ${purpose}: ${error.message}`);
    return 'failed';
  }
}

function createSessionToken(user, staffMfaVerified = false) {
  if (user.role === 'admin' && (!identityOwnershipReady(db) || !staffMfaVerified)) {
    throw new Error('Staff MFA is required before creating a session.');
  }
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (identityOwnershipReady(db)) {
    db.prepare(`INSERT INTO auth_sessions (id, user_id, expires_at, staff_mfa_verified)
      VALUES (?, ?, ?, ?)`).run(sessionId, user.id, expiresAt.toISOString(), staffMfaVerified ? 1 : 0);
  } else {
    db.prepare('INSERT INTO auth_sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sessionId, user.id, expiresAt.toISOString());
  }
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, jti: sessionId },
    config.JWT_SECRET,
    { expiresIn: '24h' }
  );
}

// Register
router.post('/register', validateRegistration, asyncHandler(async (req, res) => {
  const { email, password, firstName, lastName, phone, dob, accountType, jointFirstName, jointLastName, jointEmail, jointPhone, jointDob, jointRelationship } = req.body;

  // Check if email exists
  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existingUser) {
    return res.status(409).json({ error: 'Email already in use' });
  }

  const hashedPassword = await bcrypt.hash(password, 12);
  const accountLabel = accountType === 'business' ? 'Business Checking' : 
                       accountType === 'student' ? 'Student Checking' : 
                       accountType === 'joint' ? 'Joint Checking' :
                       accountType === 'savings' ? 'Savings Account' : 'Personal Checking';

  // Generate unique account number
  let accountNumber;
  let isUnique = false;
  while (!isUnique) {
    accountNumber = generateAccountNumber();
    const existing = db.prepare('SELECT id FROM users WHERE account_number = ?').get(accountNumber);
    if (!existing) isUnique = true;
  }

  // Use database transaction for creating user + initial card + spending categories
  const createAccount = db.transaction(() => {
    // 1. Create User
    const userResult = db.prepare(`
      INSERT INTO users (email, password_hash, first_name, last_name, phone, dob, account_type, account_label, account_number, is_joint, joint_first_name, joint_last_name, joint_email, joint_phone, joint_dob, joint_relationship)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(email, hashedPassword, firstName, lastName, phone || '', dob || '', accountType, accountLabel, accountNumber, accountType === 'joint' ? 1 : 0, jointFirstName || '', jointLastName || '', jointEmail || '', jointPhone || '', jointDob || '', jointRelationship || '');
    
    const userId = userResult.lastInsertRowid;
    if (ledgerIsReady(db)) {
      const ledgerId = db.prepare(`INSERT INTO ledger_accounts (user_id, account_number, currency, kind)
        VALUES (?, ?, 'USD', 'customer')`).run(userId, accountNumber).lastInsertRowid;
      if (identityOwnershipReady(db)) {
        const displayName = accountType === 'joint' ? 'Checking (joint holder pending)' :
          accountType === 'business' ? 'Checking (business setup pending)' : accountLabel;
        const accountId = db.prepare(`INSERT INTO customer_accounts
          (ledger_account_id, display_name, requested_type) VALUES (?, ?, ?)`)
          .run(ledgerId, displayName, accountType).lastInsertRowid;
        db.prepare(`INSERT INTO account_memberships
          (account_id, user_id, member_role, accepted_at)
          VALUES (?, ?, 'owner', datetime('now'))`).run(accountId, userId);
        if (adminWorkspaceReady(db)) {
          db.prepare('INSERT INTO account_restrictions (account_id) VALUES (?)').run(accountId);
        }
      }
    }

    // 2. Create default card
    if (sharedAccountsReady(db)) {
      const accountId = db.prepare(`SELECT a.id FROM customer_accounts a
        JOIN ledger_accounts l ON l.id = a.ledger_account_id WHERE l.user_id = ?`).get(userId).id;
      db.prepare(`INSERT INTO cards (user_id, mask, holder, customer_account_id)
        VALUES (?, ?, ?, ?)`).run(userId, accountNumber.slice(-4), `${firstName} ${lastName}`, accountId);
      db.prepare('INSERT INTO account_signing_policies (account_id) VALUES (?)').run(accountId);
    } else {
      db.prepare('INSERT INTO cards (user_id, mask, holder) VALUES (?, ?, ?)')
        .run(userId, accountNumber.slice(-4), `${firstName} ${lastName}`);
    }

    // 3. Create default spending categories
    const stmt = db.prepare('INSERT INTO spending (user_id, label, amount, budget) VALUES (?, ?, ?, ?)');
    stmt.run(userId, 'Groceries & Dining', 0, 400);
    stmt.run(userId, 'Subscriptions', 0, 150);
    stmt.run(userId, 'Transport', 0, 100);

    return { id: userId, email, firstName, lastName, accountNumber, role: 'user' };
  });

  const newUser = createAccount();

  // Generate JWT
  const token = createSessionToken(newUser);
  const verificationDelivery = !config.EMAIL_ACTIONS_ENABLED ? 'disabled' :
    customerIdentityReady(db) ? await deliverAction(db, newUser.id, 'verify_email') : 'unavailable';

  res.status(201).json({ token, user: newUser,
    emailVerificationRequired: config.EMAIL_ACTIONS_ENABLED && customerIdentityReady(db),
    verificationDelivery });
}));

router.post('/resend-verification', auth, asyncHandler(async (req, res) => {
  if (!config.EMAIL_ACTIONS_ENABLED) return res.status(503).json({ error: 'Email verification is temporarily unavailable.' });
  if (!customerIdentityReady(db)) return res.status(503).json({ error: 'Email verification is unavailable.' });
  if (req.user.role !== 'user') return res.status(403).json({ error: 'Customer access required.' });
  const delivery = await deliverAction(db, req.user.id, 'verify_email');
  res.status(202).json({ message: 'If verification is pending and eligible, an email was sent.',
    delivery: process.env.NODE_ENV === 'production' ? undefined : delivery });
}));

router.post('/verify-email', (req, res) => {
  if (!config.EMAIL_ACTIONS_ENABLED) return res.status(503).json({ error: 'Email verification is temporarily unavailable.' });
  if (!customerIdentityReady(db)) return res.status(503).json({ error: 'Email verification is unavailable.' });
  if (!consumeEmailVerification(db, req.body?.token)) {
    return res.status(400).json({ error: 'Verification link is invalid or expired.' });
  }
  res.json({ verified: true });
});

router.post('/password-reset/request', asyncHandler(async (req, res) => {
  if (!config.EMAIL_ACTIONS_ENABLED) return res.status(503).json({ error: 'Password recovery is temporarily unavailable.' });
  if (!customerIdentityReady(db)) return res.status(503).json({ error: 'Password recovery is unavailable.' });
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254) {
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (user) await deliverAction(db, user.id, 'reset_password');
  }
  res.status(202).json({ message: 'If the account exists, a recovery email will be sent.' });
}));

router.post('/password-reset/complete', asyncHandler(async (req, res) => {
  if (!config.EMAIL_ACTIONS_ENABLED) return res.status(503).json({ error: 'Password recovery is temporarily unavailable.' });
  if (!customerIdentityReady(db)) return res.status(503).json({ error: 'Password recovery is unavailable.' });
  const { token, password } = req.body || {};
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    return res.status(400).json({ error: 'Password must be 12 to 128 characters.' });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  if (!consumePasswordReset(db, token, passwordHash)) {
    return res.status(400).json({ error: 'Recovery link is invalid or expired.' });
  }
  res.json({ reset: true });
}));

// Login
router.post('/login', validateLogin, asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (user.suspended) {
    return res.status(403).json({ error: 'Your account has been suspended. Please contact support.' });
  }
  if (user.role === 'admin' && adminControlsReady(db)) {
    const staff = db.prepare('SELECT active FROM staff_memberships WHERE user_id = ?').get(user.id);
    if (!staff || !staff.active) return res.status(403).json({ error: 'Staff access is inactive.' });
  }

  const validPassword = await bcrypt.compare(password, user.password_hash);
  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (user.role === 'admin') {
    if (!identityOwnershipReady(db)) {
      return res.status(503).json({ error: 'Staff sign-in requires the identity migration.' });
    }
    return res.status(202).json(startChallenge(db, user.id));
  }

  // Customer session
  const token = createSessionToken(user);

  const userResponse = {
    id: user.id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    accountNumber: user.account_number,
    role: user.role
  };

  res.json({ token, user: userResponse });
}));

router.post('/staff-mfa/setup', asyncHandler(async (req, res) => {
  if (!identityOwnershipReady(db)) return res.status(503).json({ error: 'Staff MFA is unavailable.' });
  res.json(setupChallenge(db, req.body?.challengeToken));
}));

router.post('/staff-mfa/complete', asyncHandler(async (req, res) => {
  if (!identityOwnershipReady(db)) return res.status(503).json({ error: 'Staff MFA is unavailable.' });
  const purpose = req.body?.purpose;
  if (!['enroll', 'login'].includes(purpose)) return res.status(400).json({ error: 'Invalid MFA purpose.' });
  const result = db.transaction(() => {
    const outcome = completeChallenge(db, {
      challengeToken: req.body?.challengeToken, purpose,
      code: req.body?.code, recoveryCode: req.body?.recoveryCode
    });
    if (outcome.error) return outcome;
    const user = db.prepare('SELECT id, email, first_name, last_name, role FROM users WHERE id = ?')
      .get(outcome.userId);
    logAuditAction(db, user.id,
      purpose === 'enroll' ? 'staff_mfa_enabled' :
        outcome.usedRecovery ? 'staff_mfa_recovery_login' : 'staff_mfa_login',
      'staff', user.id, 'Staff authenticator challenge completed', req.ip || '');
    const token = createSessionToken(user, true);
    return { token, user: { id: user.id, email: user.email,
      firstName: user.first_name, lastName: user.last_name, role: user.role },
      recoveryCodes: outcome.recoveryCodes };
  }).immediate();
  if (result.error) return res.status(401).json({ error: result.error });
  res.json(result);
}));

router.post('/logout', (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  let session;
  try {
    session = jwt.verify(header.slice(7), config.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
  if (!session.jti || !Number.isInteger(session.id)) {
    return res.status(401).json({ error: 'Invalid session.' });
  }
  db.prepare("UPDATE auth_sessions SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .run(session.jti, session.id);
  res.status(204).end();
});

router.post('/accept-staff-invite', asyncHandler(async (req, res) => {
  if (!adminControlsReady(db)) return res.status(503).json({ error: 'Staff invitations are unavailable.' });
  const { invitationCode, password, firstName, lastName } = req.body || {};
  if (typeof invitationCode !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(invitationCode) ||
      typeof password !== 'string' || password.length < 12 ||
      typeof firstName !== 'string' || !firstName.trim() || firstName.trim().length > 80 ||
      typeof lastName !== 'string' || !lastName.trim() || lastName.trim().length > 80) {
    return res.status(400).json({ error: 'Provide a valid invitation, name, and password of at least 12 characters.' });
  }
  const tokenHash = createHash('sha256').update(invitationCode).digest('hex');
  const hashedPassword = await bcrypt.hash(password, 12);
  const accept = db.transaction(() => {
    const invitation = db.prepare(`SELECT id, email, staff_role, expires_at AS expiresAt
      FROM staff_invitations WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL`).get(tokenHash);
    if (!invitation || Date.parse(invitation.expiresAt) <= Date.now()) {
      return { status: 400, error: 'Invitation is invalid or expired.' };
    }
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(invitation.email)) {
      return { status: 409, error: 'This email already has an account.' };
    }
    const staffAccountNumber = `STAFF-${randomUUID()}`;
    const userId = db.prepare(`INSERT INTO users
      (email, password_hash, first_name, last_name, account_number, role)
      VALUES (?, ?, ?, ?, ?, 'admin')`)
      .run(invitation.email, hashedPassword, firstName.trim(), lastName.trim(), staffAccountNumber).lastInsertRowid;
    db.prepare(`INSERT INTO staff_memberships (user_id, staff_role, created_by)
      SELECT ?, staff_role, created_by FROM staff_invitations WHERE id = ?`).run(userId, invitation.id);
    db.prepare("UPDATE staff_invitations SET used_at = datetime('now') WHERE id = ?").run(invitation.id);
    return { status: 201, userId };
  });
  const result = accept.immediate();
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json({ success: true });
}));

module.exports = router;
