'use strict';
// Creates the first administrator from ADMIN_EMAIL / ADMIN_PASSWORD when that account does not exist yet.
// Needed where there is no terminal to run `npm run create-admin` (Vercel and similar platforms), and where the
// database is temporary and starts empty after every restart.
const { db, audit, currentPolicy } = require('./db');
const auth = require('./auth');
const time = require('./time');

function ensureAdminFromEnv(env = process.env) {
  const email = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(env.ADMIN_PASSWORD || '');
  if (!email) return null;
  if (password.length < 8) {
    console.warn('[bootstrap] ADMIN_EMAIL is set but ADMIN_PASSWORD is missing or shorter than 8 characters; no admin created.');
    return null;
  }
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) return existing; // never overwrite a real account's password or role
  const now = time.stamp();
  const id = Number(db.prepare(`INSERT INTO users (first_name, last_name, id_number, phone, email, password_hash, role, status,
      privacy_accepted_at, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, 'admin', 'active', ?, ?, ?)`)
    .run(env.ADMIN_FIRST_NAME || 'מנהל', env.ADMIN_LAST_NAME || 'מערכת', `admin-${Date.now()}`, email, auth.hashPassword(password),
      now, now, now).lastInsertRowid);
  db.prepare('INSERT INTO policy_acceptances (user_id, policy_version, accepted_at) VALUES (?, ?, ?)').run(id, currentPolicy().version, now);
  audit(null, 'admin.bootstrap_env', 'user', id, email);
  console.log(`[bootstrap] Created admin ${email} from ADMIN_EMAIL/ADMIN_PASSWORD`);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

module.exports = { ensureAdminFromEnv };
