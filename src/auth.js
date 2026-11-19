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

// The same, off the main thread (libuv pool): a sign-in takes ~35 ms of CPU, which the sync versions spend blocking
// every other request on the instance. Same parameters and format, so either can check what the other stored.
const scryptAsync = (password, salt, len) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, len, (err, key) => (err ? reject(err) : resolve(key)));
});

async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// For an unknown address (or an account without a password) the same work is done against this, so the answer takes
// as long as for a real account and does not tell who is registered (S-03).
let dummyHash = null;

async function verifyPasswordAsync(password, stored) {
  if (!stored) {
    dummyHash ||= hashPassword(crypto.randomBytes(16).toString('hex'));
    await verifyPasswordAsync(password, dummyHash);
    return false;
  }
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// How long a session lasts without activity (S-08): managers 8 hours (they see ID numbers and license photos; a
// forgotten session on a shared computer ends the same day), everyone else 14 days. Each visit extends it; the
// database is written at most every 10 minutes (managers) or once a day (others), not on every request.
const IDLE_MS = { admin: 8 * 3600000, user: config.sessionDays * 86400000 };
const REFRESH_MS = { admin: 10 * 60000, user: 86400000 };
const idleFor = (role) => (role === 'admin' ? IDLE_MS.admin : IDLE_MS.user);

const setCookie = (res, token, expires) => res.cookie(COOKIE, token, {
  httpOnly: true, sameSite: 'lax', secure: res.req.secure, expires: new Date(expires), path: '/',
});

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const role = db.prepare('SELECT role FROM users WHERE id = ?').get(userId)?.role;
  const expires = Date.now() + idleFor(role);
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, csrf, expires);
  setCookie(res, token, expires);
}

/** Extends a session in use (see IDLE_MS); a manager's session never lasts longer than 8 hours of inactivity. */
function touchSession(req, res, session, user) {
  const idle = idleFor(user.role);
  const now = Date.now();
  const left = session.expires_at - now;
  const refresh = user.role === 'admin' ? REFRESH_MS.admin : REFRESH_MS.user;
  if (left > idle) { // made as a regular user's session, then the person became a manager: shorten it now
    session.expires_at = now + idle;
  } else if (left < idle - refresh) {
    session.expires_at = now + idle;
  } else {
    return;
  }
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(session.expires_at, session.token_hash);
  setCookie(res, req.cookies[COOKIE], session.expires_at);
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

/**
 * The login cookie's session and its user in one query (each query is a round trip to a hosted database).
 * state: 'none' (no cookie), 'ok', 'no-user' (account gone), 'expired', 'unknown' (not in this database).
 */
function loadSessionAndUser(req) {
  const token = req.cookies[COOKIE];
  if (!token) return { state: 'none', session: null, user: null };
  const hash = sha256(token);
  const row = db.prepare(`SELECT s.user_id AS s_user_id, s.csrf AS s_csrf, s.expires_at AS s_expires_at, u.*
    FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hash);
  if (!row) return { state: 'unknown', session: null, user: null };
  if (row.s_expires_at < Date.now()) return { state: 'expired', session: null, user: null };
  const session = { token_hash: hash, user_id: row.s_user_id, csrf: row.s_csrf, expires_at: row.s_expires_at };
  const user = Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('s_')));
  return user.id == null ? { state: 'no-user', session, user: null } : { state: 'ok', session, user };
}

// --- Minimal cookie parsing (avoids an extra dependency) ---
function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    // A malformed value (e.g. "%E0") is skipped instead of failing every request with a 500 (SEC-013).
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore it */ }
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
async function resetPassword(token, password) {
  if (!checkPasswordReset(token)) return null;
  const passwordHash = await hashPasswordAsync(password);
  const userId = checkPasswordReset(token); // again: another request may have used the link meanwhile
  if (!userId) return null;
  const delivered = db.prepare('SELECT delivered FROM password_resets WHERE token_hash = ?').get(sha256(token))?.delivered;
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
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
  hashPassword, verifyPassword, hashPasswordAsync, verifyPasswordAsync, createSession, touchSession, IDLE_MS, destroySession, destroyAllSessions, loadSession, loadSessionAndUser,
  parseCookies, createLoginCode, consumeLoginCode, throttled, release, resetThrottle, purgeThrottle,
  markEmailVerified, markResetDelivered, distrustUnverified, COOKIE, createPasswordReset, checkPasswordReset, resetPassword, sha256, INVITE_TTL_MS,
};
