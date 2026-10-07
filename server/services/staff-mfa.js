const { randomBytes, createHash, createCipheriv, createDecipheriv,
  createHmac, timingSafeEqual } = require('node:crypto');
const config = require('../config');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const KEY = Buffer.from(config.STAFF_MFA_KEY, 'hex');
const MAX_ATTEMPTS = 5;

function fail(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function encodeBase32(bytes) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(secret) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of secret) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) fail(500, 'Authenticator configuration is invalid.');
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function encrypt(secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${ciphertext.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}`;
}

function decrypt(stored) {
  const [version, iv, ciphertext, tag] = stored.split(':');
  if (version !== 'v1' || !iv || !ciphertext || !tag) fail(500, 'Authenticator configuration is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

function tokenHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function totpAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

function matchingStep(secret, code, lastUsedStep = -1, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  for (const step of [current, current - 1, current + 1]) {
    if (step <= lastUsedStep || step < 0) continue;
    const expected = Buffer.from(totpAt(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

function startChallenge(db, userId) {
  const enrolled = !!db.prepare('SELECT 1 FROM staff_mfa_factors WHERE user_id = ?').get(userId);
  const challengeToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO staff_mfa_challenges (token_hash, user_id, purpose, expires_at)
    VALUES (?, ?, ?, ?)`).run(tokenHash(challengeToken), userId, enrolled ? 'login' : 'enroll', expiresAt);
  return { mfaRequired: true, setupRequired: !enrolled, challengeToken, expiresAt };
}

function getChallenge(db, challengeToken, purpose) {
  if (typeof challengeToken !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(challengeToken)) {
    fail(401, 'Authenticator challenge is invalid or expired.');
  }
  const challenge = db.prepare(`SELECT c.*, u.email FROM staff_mfa_challenges c
    JOIN users u ON u.id = c.user_id AND u.role = 'admin' AND u.suspended = 0
    JOIN staff_memberships m ON m.user_id = u.id AND m.active = 1
    WHERE c.token_hash = ? AND c.purpose = ? AND c.consumed_at IS NULL`)
    .get(tokenHash(challengeToken), purpose);
  if (!challenge || challenge.attempts >= MAX_ATTEMPTS || Date.parse(challenge.expires_at) <= Date.now()) {
    fail(401, 'Authenticator challenge is invalid or expired.');
  }
  return challenge;
}

function setupChallenge(db, challengeToken) {
  const challenge = getChallenge(db, challengeToken, 'enroll');
  if (db.prepare('SELECT 1 FROM staff_mfa_factors WHERE user_id = ?').get(challenge.user_id)) {
    fail(409, 'Authenticator is already enrolled.');
  }
  const secret = challenge.encrypted_secret ? decrypt(challenge.encrypted_secret) : encodeBase32(randomBytes(20));
  if (!challenge.encrypted_secret) {
    db.prepare('UPDATE staff_mfa_challenges SET encrypted_secret = ? WHERE token_hash = ?')
      .run(encrypt(secret), challenge.token_hash);
  }
  const label = encodeURIComponent(`Payvexis:${challenge.email}`);
  return { secret, otpAuthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=Payvexis&digits=6&period=30` };
}

function completeChallenge(db, { challengeToken, purpose, code, recoveryCode }) {
  const challenge = getChallenge(db, challengeToken, purpose);
  const factor = db.prepare('SELECT encrypted_secret, last_used_step FROM staff_mfa_factors WHERE user_id = ?')
    .get(challenge.user_id);
  if (purpose === 'enroll' && (factor || !challenge.encrypted_secret)) {
    fail(409, 'Start authenticator setup before verifying it.');
  }
  if (purpose === 'login' && !factor) fail(409, 'Authenticator setup is required.');
  let step = null;
  let usedRecovery = false;
  if (typeof recoveryCode === 'string' && recoveryCode.length > 0 && purpose === 'login') {
    const codeHash = tokenHash(recoveryCode.trim().toUpperCase());
    const recovery = db.prepare(`SELECT 1 FROM staff_mfa_recovery_codes
      WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`).get(challenge.user_id, codeHash);
    usedRecovery = !!recovery;
    if (usedRecovery) {
      db.prepare(`UPDATE staff_mfa_recovery_codes SET used_at = datetime('now')
        WHERE user_id = ? AND code_hash = ?`).run(challenge.user_id, codeHash);
    }
  } else {
    step = matchingStep(decrypt(purpose === 'enroll' ? challenge.encrypted_secret : factor.encrypted_secret),
      code, purpose === 'enroll' ? -1 : factor.last_used_step);
  }
  if (step === null && !usedRecovery) {
    db.prepare('UPDATE staff_mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?')
      .run(challenge.token_hash);
    return { error: 'Invalid authenticator or recovery code.' };
  }

  let recoveryCodes;
  if (purpose === 'enroll') {
    db.prepare('INSERT INTO staff_mfa_factors (user_id, encrypted_secret, last_used_step) VALUES (?, ?, ?)')
      .run(challenge.user_id, challenge.encrypted_secret, step);
    recoveryCodes = Array.from({ length: 8 }, () => randomBytes(10).toString('hex').toUpperCase());
    const insert = db.prepare('INSERT INTO staff_mfa_recovery_codes (user_id, code_hash) VALUES (?, ?)');
    recoveryCodes.forEach(recovery => insert.run(challenge.user_id, tokenHash(recovery)));
  } else if (step !== null) {
    db.prepare('UPDATE staff_mfa_factors SET last_used_step = ? WHERE user_id = ?')
      .run(step, challenge.user_id);
  }
  db.prepare("UPDATE staff_mfa_challenges SET consumed_at = datetime('now') WHERE token_hash = ?")
    .run(challenge.token_hash);
  return { userId: challenge.user_id, recoveryCodes, usedRecovery };
}

module.exports = { startChallenge, setupChallenge, completeChallenge, totpAt };
