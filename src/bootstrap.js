'use strict';
// Creates the first administrator from ADMIN_EMAIL (and ADMIN_PASSWORD, optional) when that account does not exist yet.
// Needed where there is no terminal to run `npm run create-admin` (Vercel and similar platforms), and where the
// database is temporary and starts empty after every restart.
const crypto = require('node:crypto');
const { db, audit, currentPolicy } = require('./db');
const auth = require('./auth');
const time = require('./time');
const config = require('./config');

/**
 * The admin named in ADMIN_EMAIL. ADMIN_PASSWORD is optional: without it the account has no password, and its owner
 * signs in with a code sent by e-mail, with Google, or chooses a password through "forgot password".
 * keepAdmin (the master console): this account is the console's main admin and always stays an active admin, so the
 * owner can never be locked out by another admin.
 */
function ensureAdminFromEnv(env = process.env, { keepAdmin = config.master } = {}) {
  const email = String(env.ADMIN_EMAIL || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim().toLowerCase();
  const password = String(env.ADMIN_PASSWORD || '');
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.warn(`[bootstrap] ADMIN_EMAIL is not an e-mail address ("${email}"); no admin created.`);
    return null;
  }
  if (password && password.length < 8) {
    console.warn('[bootstrap] ADMIN_PASSWORD is shorter than 8 characters; no admin created.');
    return null;
  }
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) {
    // Never overwrite a real account's password. The console's main admin is made an active admin again if needed.
    if (keepAdmin && (existing.role !== 'admin' || existing.status !== 'active')) {
      db.prepare("UPDATE users SET role = 'admin', status = 'active', updated_at = ? WHERE id = ?").run(time.stamp(), existing.id);
      audit(null, 'admin.bootstrap_env', 'user', existing.id, `${email}: admin again (ADMIN_EMAIL)`);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
    }
    return existing;
  }
  const now = time.stamp();
  // OR IGNORE: another server instance starting at the same moment may have just created it.
  const r = db.prepare(`INSERT OR IGNORE INTO users (first_name, last_name, id_number, phone, email, password_hash, role, status,
      privacy_accepted_at, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, 'admin', 'active', ?, ?, ?)`)
    .run(env.ADMIN_FIRST_NAME || 'מנהל', env.ADMIN_LAST_NAME || 'מערכת', `admin-${crypto.randomUUID()}`, email,
      password ? auth.hashPassword(password) : null, now, now, now);
  if (r.changes !== 1) return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const id = r.lastInsertRowid;
  db.prepare('INSERT INTO policy_acceptances (user_id, policy_version, accepted_at) VALUES (?, ?, ?)').run(id, currentPolicy().version, now);
  audit(null, 'admin.bootstrap_env', 'user', id, email);
  console.log(`[bootstrap] Created admin ${email} from ADMIN_EMAIL${password ? '/ADMIN_PASSWORD' : ' (no password: sign in with an e-mailed code, Google, or "forgot password")'}`);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/** The main admin's address (ADMIN_EMAIL), lower-case, or ''. */
const mainAdminEmail = (env = process.env) => String(env.ADMIN_EMAIL || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim().toLowerCase();

module.exports = { ensureAdminFromEnv, mainAdminEmail };
