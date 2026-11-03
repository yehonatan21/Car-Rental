'use strict';
// Data layer. Times are stored as local (Asia/Jerusalem) strings
// "YYYY-MM-DDTHH:MM" so they compare lexically and match what users type.
const path = require('node:path');
const fs = require('node:fs');
const config = require('./config');
const time = require('./time');
const { openDatabase } = require('./driver');

// Uploads are always received into this folder first (and stay there unless files are kept in the database).
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });

// Local SQLite file by default; a hosted libSQL/Turso database when TURSO_DATABASE_URL is set (see driver.js).
// Timestamps are always written by the app (time.stamp()); the DEFAULTs below are only a fallback.
const db = openDatabase();

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  id_number TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','license_update','blocked','rejected')),
  license_file TEXT,
  license_expiry TEXT,
  license_verified INTEGER NOT NULL DEFAULT 0,
  pending_license_file TEXT,
  pending_license_expiry TEXT,
  license_warned_for TEXT,
  privacy_accepted_at TEXT,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  needs_2fa INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS policies (
  version INTEGER PRIMARY KEY,
  content TEXT NOT NULL,
  requires_reaccept INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS policy_acceptances (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_version INTEGER NOT NULL REFERENCES policies(version),
  accepted_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  ip TEXT
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY,
  plate TEXT NOT NULL,
  make TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','service','disabled')),
  insurance_renewal TEXT,
  registration_renewal TEXT,
  next_service TEXT,
  notes TEXT,
  instructions TEXT
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  user_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'booking' CHECK (kind IN ('booking','block')),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  purpose TEXT,
  notes TEXT,
  block_reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','cancelled','completed')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  pickup_reminded INTEGER NOT NULL DEFAULT 0,
  return_reminded INTEGER NOT NULL DEFAULT 0,
  pending_alerted INTEGER NOT NULL DEFAULT 0,
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS bookings_range ON bookings(vehicle_id, start_at, end_at);

CREATE TABLE IF NOT EXISTS booking_history (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  note TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  details TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  next TEXT,
  expires_at INTEGER NOT NULL
);

-- A Google identity that has no account yet, waiting for the registration form to be completed.
CREATE TABLE IF NOT EXISTS google_signups (
  token_hash TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  expires_at INTEGER NOT NULL
);

-- "Forgot password" links: only a hash of the token is stored; single use, short expiry.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- A registration form that failed validation keeps its uploaded license and password here, so the person
-- does not have to provide them again. Referenced by a random token in the form (only its hash is stored).
CREATE TABLE IF NOT EXISTS registration_drafts (
  token_hash TEXT PRIMARY KEY,
  license_file TEXT,
  license_name TEXT,
  password_hash TEXT,
  expires_at INTEGER NOT NULL
);

-- Uploaded files (license images) when they are stored in the database, split into chunks
-- (hosted databases limit the size of a single value).
CREATE TABLE IF NOT EXISTS files (
  name TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (name, seq)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Facts about the database itself: a random id and creation time written once, when it is first set up. If the id
-- shown on the settings page changes after a new deployment, that deployment uses a different (or new) database.
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Columns added after the first release (existing databases are upgraded in place). On Vercel several instances can
// start at the same moment on a new database, so everything below must also work when another one got there first.
function addColumn(table, column, type) {
  if (db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
}
addColumn('users', 'google_sub', 'TEXT');
// Two-step verification was removed: forget stored authenticator secrets and sessions that were waiting for a code.
// (The columns stay, so older databases keep working.)
db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE totp_enabled != 0 OR totp_secret IS NOT NULL').run();
db.prepare('DELETE FROM sessions WHERE needs_2fa != 0').run();
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL');

const DEFAULT_SETTINGS = {
  buffer_minutes: '0',            // זמן התארגנות בין הזמנות
  cancel_hours_before: '24',      // עד כמה שעות לפני ההתחלה משתמש יכול לבטל הזמנה מאושרת
  max_booking_hours: '168',       // משך הזמנה מקסימלי (0 = ללא הגבלה)
  max_open_bookings: '3',         // מספר הזמנות עתידיות פתוחות למשתמש (0 = ללא הגבלה)
  pickup_reminder_hours: '24',
  return_reminder_hours: '2',
  pending_alert_hours: '24',      // התראה על בקשה שממתינה זמן רב
  license_warn_days: '30',
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

// First start only. One statement each, so two instances starting together cannot both insert.
db.prepare("INSERT INTO vehicles (plate, make, model) SELECT '00-000-00', 'יצרן', 'דגם' WHERE NOT EXISTS (SELECT 1 FROM vehicles)").run();
db.prepare('INSERT OR IGNORE INTO policies (version, content, created_at) SELECT 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM policies)')
  .run(fs.readFileSync(path.join(__dirname, 'default-policy.md'), 'utf8'), time.stamp());

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = Number(r.value);
  return out;
}

function setSetting(key, value) {
  if (!(key in DEFAULT_SETTINGS)) throw new Error('unknown setting ' + key);
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(value), key);
}

/** Runs fn inside BEGIN IMMEDIATE so concurrent approvals can't both pass the overlap check. */
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function audit(actorId, action, targetType, targetId, details) {
  db.prepare('INSERT INTO audit_log (actor_id, action, target_type, target_id, details, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(actorId ?? null, action, targetType ?? null, targetId ?? null, details ? String(details) : null, time.stamp());
}

function currentPolicy() {
  return db.prepare('SELECT * FROM policies ORDER BY version DESC LIMIT 1').get();
}

/** The latest policy version the user must have accepted (latest one that demanded re-acceptance). */
function requiredPolicyVersion() {
  const row = db.prepare('SELECT MAX(version) AS v FROM policies WHERE requires_reaccept = 1 OR version = 1').get();
  return row.v;
}

function userAcceptedPolicy(userId) {
  const row = db.prepare('SELECT MAX(policy_version) AS v FROM policy_acceptances WHERE user_id = ?').get(userId);
  return (row.v ?? 0) >= requiredPolicyVersion();
}

function defaultVehicle() {
  return db.prepare('SELECT * FROM vehicles ORDER BY id LIMIT 1').get();
}

db.prepare('INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)').run('db_id', require('node:crypto').randomBytes(4).toString('hex'));
db.prepare('INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)').run('created_at', time.stamp());

/**
 * The Vercel Turso integration can create a database per deployment, named "dpl-<deployment id>-vercel-icfg-…":
 * each new version then starts empty. A permanent database (LIBSQL_URL) is needed instead.
 */
const isPerDeploymentHost = (host) => Boolean(host && /^dpl-[a-z0-9]+-vercel-icfg-/i.test(host));

/** Where the data lives, for /healthz, the settings page and the startup log. No secrets. */
function storageInfo() {
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM app_meta').all().map((r) => [r.key, r.value]));
  // Any file on Vercel is temporary (wiped with each new version, and separate for every server instance).
  const kind = db.remote ? 'hosted' : config.onVercel ? 'temporary' : 'file';
  const host = db.remote ? new URL(config.database.url).host : null;
  return {
    kind, id: meta.db_id, createdAt: meta.created_at, host, from: config.database.from, file: db.remote ? null : config.dbFile,
    perDeployment: isPerDeploymentHost(host),
  };
}
{
  const s = storageInfo();
  console.log(`[db] ${s.kind === 'hosted' ? `hosted database ${s.host} (from ${s.from})` : `${s.kind} database file ${s.file}`}, `
    + `database id ${s.id}, created ${s.createdAt}`);
  if (s.perDeployment) {
    console.warn('[db] WARNING: this is a separate database created for this one deployment by the Vercel Turso integration. '
      + 'Data will not carry over to the next deployment. Set LIBSQL_URL and LIBSQL_AUTH_TOKEN to one permanent database.');
  }
}

module.exports = {
  db, transaction, audit, getSettings, setSetting, DEFAULT_SETTINGS, storageInfo, isPerDeploymentHost,
  currentPolicy, requiredPolicyVersion, userAcceptedPolicy, defaultVehicle,
};
