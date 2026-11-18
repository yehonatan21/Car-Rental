'use strict';
// Passwords, sessions, one-time e-mail codes and password reset links.
const crypto = require('node:crypto');
const { db } = require('./db');
const config = require('./config');

const COOKIE = 'sid';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expires = Date.now() + config.sessionDays * 86400000;
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, needs_2fa, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), userId, csrf, 0, expires);
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: res.req.secure, expires: new Date(expires), path: '/',
  });
}

function destroySession(req, res) {
  const token = req.cookies[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie(COOKIE, { path: '/', secure: req.secure });
}

function destroyAllSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function loadSession(req) {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!s || s.expires_at < Date.now()) return null;
  return s;
}

// --- Minimal cookie parsing (avoids an extra dependency) ---
function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// --- One-time login codes sent by e-mail ---
const MAX_CODE_ATTEMPTS = 5;
const MAX_ACTIVE_CODES = 3;

/**
 * New 6-digit code, valid 10 minutes. Earlier unexpired codes stay valid (e-mails can arrive late or out of
 * order), up to MAX_ACTIVE_CODES; using any one of them invalidates all.
 */
function createLoginCode(userId) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare('DELETE FROM login_codes WHERE user_id = ? AND expires_at < ?').run(userId, Date.now());
  db.prepare(`DELETE FROM login_codes WHERE user_id = ? AND id NOT IN
    (SELECT id FROM login_codes WHERE user_id = ? ORDER BY id DESC LIMIT ?)`).run(userId, userId, MAX_ACTIVE_CODES - 1);
  db.prepare('INSERT INTO login_codes (user_id, code_hash, expires_at) VALUES (?, ?, ?)')
    .run(userId, sha256(code), Date.now() + 10 * 60000);
  return code;
}

function consumeLoginCode(userId, code) {
  const rows = db.prepare('SELECT * FROM login_codes WHERE user_id = ? AND expires_at >= ? ORDER BY id DESC').all(userId, Date.now());
  // Wrong guesses are counted across all of the user's active codes.
  if (!rows.length || rows.reduce((n, r) => n + r.attempts, 0) >= MAX_CODE_ATTEMPTS) return false;
  const digits = String(code ?? '').replace(/\D/g, ''); // tolerate "123 456", "123-456"
  if (!rows.some((r) => r.code_hash === sha256(digits))) {
    db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').run(rows[0].id);
    return false;
  }
  db.prepare('DELETE FROM login_codes WHERE user_id = ?').run(userId);
  markEmailVerified(userId); // the code arrived at this address
  return true;
}

// --- "Forgot password" links ---
const RESET_TTL_MS = 60 * 60000;

const INVITE_TTL_MS = 7 * 86400000;

/**
 * New single-use reset token for the user (earlier ones are cancelled). Only its hash is stored.
 * Also used for invitations to accounts an admin created, with a longer validity (INVITE_TTL_MS).
 */
function createPasswordReset(userId, ttlMs = RESET_TTL_MS) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?').run(userId, Date.now());
  db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + ttlMs);
  return token;
}

/** The user id a reset token belongs to, if it is valid (does not use it up). */
function checkPasswordReset(token) {
  if (typeof token !== 'string' || !token) return null;
  const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha256(token));
  return row && row.expires_at > Date.now() ? row.user_id : null;
}

/** Sets the new password with a valid token: the token is used up and every session of the user is ended. */
function resetPassword(token, password) {
  const userId = checkPasswordReset(token);
  if (!userId) return null;
  const delivered = db.prepare('SELECT delivered FROM password_resets WHERE token_hash = ?').get(sha256(token))?.delivered;
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
  destroyAllSessions(userId);
  if (delivered) markEmailVerified(userId); // the link was e-mailed to this address (not shown to an admin)
  return userId;
}

/** The link of `token` was really sent by e-mail: using it proves the address (SEC-003). */
function markResetDelivered(token) {
  db.prepare('UPDATE password_resets SET delivered = 1 WHERE token_hash = ?').run(sha256(token));
}

// --- Proof that the account's owner receives mail at its address (SEC-003) ---
function markEmailVerified(userId) {
  db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL').run(new Date().toISOString(), userId);
}

/**
 * Before an account found only by its e-mail address is trusted with more (made an admin, linked to Google): if nobody
 * ever proved they receive mail there, it may have been registered by someone else with that address. Its password
 * and sessions are then removed; the real owner signs in with the invitation/Google and chooses a new password.
 * Returns true when it did so.
 */
function distrustUnverified(user) {
  if (!user || user.email_verified_at || !user.password_hash) return false;
  db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(user.id);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
  destroyAllSessions(user.id);
  return true;
}

// --- Throttling, kept in the database so every server instance shares it (SEC-002) ---
/** Adds one to the counter of `key` in the current window (a new window starts after `windowMs`); returns the count. */
function bump(key, windowMs) {
  const now = Date.now();
  db.prepare(`INSERT INTO throttle (key, count, window_start) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN throttle.window_start < ? THEN 1 ELSE throttle.count + 1 END,
      window_start = CASE WHEN throttle.window_start < ? THEN ? ELSE throttle.window_start END`)
    .run(key, now, now - windowMs, now - windowMs, now);
  return db.prepare('SELECT count FROM throttle WHERE key = ?').get(key).count;
}
/** Counts this attempt first (so parallel requests cannot all slip under the limit); true when over `max`. */
const throttled = (key, max = 10, windowMs = 15 * 60000) => bump(key, windowMs) > max;
/** A successful attempt gives its count back, so only failures accumulate (sign-in). */
const release = (key) => db.prepare('UPDATE throttle SET count = count - 1 WHERE key = ? AND count > 0').run(key);
const resetThrottle = (key) => db.prepare('DELETE FROM throttle WHERE key = ?').run(key);
/** Removes counters whose window ended long ago (jobs). */
const purgeThrottle = () => db.prepare('DELETE FROM throttle WHERE window_start < ?').run(Date.now() - 86400000);

module.exports = {
  hashPassword, verifyPassword, createSession, destroySession, destroyAllSessions, loadSession,
  parseCookies, createLoginCode, consumeLoginCode, throttled, release, resetThrottle, purgeThrottle,
  markEmailVerified, markResetDelivered, distrustUnverified, COOKIE, createPasswordReset, checkPasswordReset, resetPassword, sha256, INVITE_TTL_MS,
};
