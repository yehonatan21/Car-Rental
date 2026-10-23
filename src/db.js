'use strict';
// SQLite data layer. Times are stored as local (Asia/Jerusalem) strings
// "YYYY-MM-DDTHH:MM" so they compare lexically and match what users type.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });

const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

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

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Columns added after the first release (existing databases are upgraded in place).
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
if (!userColumns.has('google_sub')) db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT');
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

if (!db.prepare('SELECT 1 FROM vehicles LIMIT 1').get()) {
  db.prepare("INSERT INTO vehicles (plate, make, model) VALUES ('00-000-00', 'יצרן', 'דגם')").run();
}

if (!db.prepare('SELECT 1 FROM policies LIMIT 1').get()) {
  const content = fs.readFileSync(path.join(__dirname, 'default-policy.md'), 'utf8');
  db.prepare('INSERT INTO policies (version, content) VALUES (1, ?)').run(content);
}

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
  db.prepare('INSERT INTO audit_log (actor_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)')
    .run(actorId ?? null, action, targetType ?? null, targetId ?? null, details ? String(details) : null);
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

module.exports = {
  db, transaction, audit, getSettings, setSetting, DEFAULT_SETTINGS,
  currentPolicy, requiredPolicyVersion, userAcceptedPolicy, defaultVehicle,
};
