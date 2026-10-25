'use strict';
// Passwords, sessions, one-time e-mail codes and TOTP two-factor auth.
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

function createSession(res, userId, needs2fa = false) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expires = Date.now() + config.sessionDays * 86400000;
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, needs_2fa, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), userId, csrf, needs2fa ? 1 : 0, expires);
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

function completeTwoFactor(req) {
  db.prepare('UPDATE sessions SET needs_2fa = 0 WHERE token_hash = ?').run(sha256(req.cookies[COOKIE]));
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
  return true;
}

// --- "Forgot password" links ---
const RESET_TTL_MS = 60 * 60000;

/** New single-use reset token for the user (earlier ones are cancelled). Only its hash is stored. */
function createPasswordReset(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?').run(userId, Date.now());
  db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + RESET_TTL_MS);
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
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
  destroyAllSessions(userId);
  return userId;
}

// --- TOTP (RFC 6238), compatible with Google Authenticator and similar apps ---
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function totpAt(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const num = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(num).padStart(6, '0');
}

const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

function verifyTotp(secret, code, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  const counter = Math.floor(now / 30000);
  return [-1, 0, 1].some((d) => totpAt(secret, counter + d) === c);
}

// --- Simple in-memory throttling for login endpoints ---
const attempts = new Map();
function throttled(key, max = 10, windowMs = 15 * 60000) {
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, start: now };
  if (now - entry.start > windowMs) { entry.count = 0; entry.start = now; }
  entry.count++;
  attempts.set(key, entry);
  return entry.count > max;
}
const resetThrottle = (key) => attempts.delete(key);

module.exports = {
  hashPassword, verifyPassword, createSession, destroySession, destroyAllSessions, loadSession,
  completeTwoFactor, parseCookies, createLoginCode, consumeLoginCode, newTotpSecret, verifyTotp,
  totpAt, throttled, resetThrottle, COOKIE, createPasswordReset, checkPasswordReset, resetPassword, sha256,
};
