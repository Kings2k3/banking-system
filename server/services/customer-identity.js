const { randomBytes, createHash } = require('node:crypto');
const { customerIdentityReady } = require('../migrations/004_customer_identity');

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function issueActionToken(db, userId, purpose) {
  if (!customerIdentityReady(db)) return null;
  if (!['verify_email', 'reset_password'].includes(purpose)) throw new Error('Invalid email action.');
  return db.transaction(() => {
    const user = db.prepare('SELECT id, email, email_verified_at FROM users WHERE id = ?').get(userId);
    if (!user || (purpose === 'verify_email' && user.email_verified_at)) return null;
    const recent = db.prepare(`SELECT COUNT(*) AS dayCount, MAX(created_at) AS latest
      FROM email_action_tokens WHERE user_id = ? AND purpose = ?
      AND created_at >= datetime('now', '-1 day')`).get(userId, purpose);
    if (recent.dayCount >= 5 || (recent.latest &&
        Date.now() - Date.parse(`${recent.latest.replace(' ', 'T')}Z`) < 60_000)) return null;
    db.prepare(`UPDATE email_action_tokens SET used_at = datetime('now')
      WHERE user_id = ? AND purpose = ? AND used_at IS NULL`).run(userId, purpose);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const ttl = purpose === 'verify_email' ? 24 * 60 : 30;
    const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();
    db.prepare(`INSERT INTO email_action_tokens (user_id, purpose, token_hash, expires_at)
      VALUES (?, ?, ?, ?)`).run(userId, purpose, tokenHash, expiresAt);
    return { token, tokenHash, to: user.email, expiresAt };
  }).immediate();
}

function invalidateDelivery(db, tokenHash) {
  db.prepare("UPDATE email_action_tokens SET used_at = datetime('now') WHERE token_hash = ? AND used_at IS NULL")
    .run(tokenHash);
}

function consumeEmailVerification(db, token) {
  if (!customerIdentityReady(db) || typeof token !== 'string' ||
      !/^[A-Za-z0-9_-]{40,100}$/.test(token)) return false;
  return db.transaction(() => {
    const action = db.prepare(`SELECT user_id, expires_at FROM email_action_tokens
      WHERE token_hash = ? AND purpose = 'verify_email' AND used_at IS NULL`).get(hashToken(token));
    if (!action || Date.parse(action.expires_at) <= Date.now()) return false;
    db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE id = ? AND email_verified_at IS NULL")
      .run(action.user_id);
    db.prepare(`UPDATE email_action_tokens SET used_at = datetime('now')
      WHERE user_id = ? AND purpose = 'verify_email' AND used_at IS NULL`).run(action.user_id);
    db.prepare("INSERT INTO identity_events (user_id, event_type) VALUES (?, 'email_verified')")
      .run(action.user_id);
    return true;
  }).immediate();
}

function consumePasswordReset(db, token, passwordHash) {
  if (!customerIdentityReady(db) || typeof token !== 'string' ||
      !/^[A-Za-z0-9_-]{40,100}$/.test(token)) return false;
  return db.transaction(() => {
    const action = db.prepare(`SELECT user_id, expires_at FROM email_action_tokens
      WHERE token_hash = ? AND purpose = 'reset_password' AND used_at IS NULL`).get(hashToken(token));
    if (!action || Date.parse(action.expires_at) <= Date.now()) return false;
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, action.user_id);
    db.prepare(`UPDATE auth_sessions SET revoked_at = datetime('now')
      WHERE user_id = ? AND revoked_at IS NULL`).run(action.user_id);
    db.prepare(`UPDATE email_action_tokens SET used_at = datetime('now')
      WHERE user_id = ? AND purpose = 'reset_password' AND used_at IS NULL`).run(action.user_id);
    db.prepare("INSERT INTO identity_events (user_id, event_type) VALUES (?, 'password_reset')")
      .run(action.user_id);
    return true;
  }).immediate();
}

module.exports = { issueActionToken, invalidateDelivery, consumeEmailVerification, consumePasswordReset };
