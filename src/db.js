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

const DEFAULT_SETTINGS = {
  buffer_minutes: '0',            // זמן התארגנות בין הזמנות
  cancel_hours_before: '24',      // עד כמה שעות לפני ההתחלה משתמש יכול לבטל הזמנה מאושרת
  max_booking_hours: '168',       // משך הזמנה מקסימלי (0 = ללא הגבלה)
  max_open_bookings: '3',         // מספר הזמנות עתידיות פתוחות למשתמש (0 = ללא הגבלה)
  pickup_reminder_hours: '24',
  return_reminder_hours: '2',
  pending_alert_hours: '24',      // התראה על בקשה שממתינה זמן רב
  license_warn_days: '30',
  auto_approve: '0',              // 1 = a request nothing stands in the way of is approved at once (no admin needed)
};

// The setup below (tables, columns added later, defaults, one-off cleanups) is only needed when this file changed
// since the database was last set up: its fingerprint is kept in app_meta. Each statement is a round trip to the
// database, so on a hosted database a cold start that ran all of them waited noticeably before the first page.
const SCHEMA_VERSION = require('node:crypto').createHash('sha1').update(fs.readFileSync(__filename)).digest('hex').slice(0, 16);
let meta = null; // app_meta (database id, creation time, schema version): written once, never changed afterwards
function readMeta() {
  try { return Object.fromEntries(db.prepare('SELECT key, value FROM app_meta').all().map((r) => [r.key, r.value])); } catch { return null; } // no table yet
}
meta = readMeta();
const schemaIsCurrent = meta?.schema_version === SCHEMA_VERSION;

if (!schemaIsCurrent) {
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
    admin_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
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
  -- Lookups that otherwise read whole tables (docs/PERFORMANCE_REPORT.md): a booking's history, pending requests,
  -- a user's bookings, the calendar from its first day on (by end time), a user's action log and sessions.
  CREATE INDEX IF NOT EXISTS bookings_end ON bookings(vehicle_id, end_at);
  CREATE INDEX IF NOT EXISTS bookings_status ON bookings(status, kind);
  CREATE INDEX IF NOT EXISTS bookings_user ON bookings(user_id, start_at);

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

  -- Vehicle papers (vehicle license, insurance policies…). The file is kept like license images: in DATA_DIR, or in
  -- the files table when the database is hosted. visible_to_drivers: active users may open it (to show it on the road).
  CREATE TABLE IF NOT EXISTS vehicle_documents (
    id INTEGER PRIMARY KEY,
    vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
    kind TEXT NOT NULL CHECK (kind IN ('registration','insurance_mandatory','insurance_comprehensive','other')),
    title TEXT,
    file TEXT NOT NULL,
    original_name TEXT,
    expires_at TEXT,
    visible_to_drivers INTEGER NOT NULL DEFAULT 0,
    uploaded_by INTEGER REFERENCES users(id),
    uploaded_at TEXT NOT NULL
  );

  -- The client's name, look and contact details as set by its admin (brand.js); missing keys fall back to the
  -- instance's environment variables.
  CREATE TABLE IF NOT EXISTS branding (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Failed-attempt counters (sign-in, codes, resets…), shared by every server instance (SEC-002).
  CREATE TABLE IF NOT EXISTS throttle (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    window_start INTEGER NOT NULL
  );

  -- One-time sign-in links from the master console (routes/manage.js): only a hash of the token; 2 minutes, single use.
  CREATE TABLE IF NOT EXISTS sso_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  -- E-mails waiting to be (re)sent: a message whose sending failed, retried with growing delays (mail.js), and the
  -- reminders' idempotency keys, so a reminder is sent once even when two job runs overlap. Messages with a one-time
  -- code or a password link are never stored here (they expire, and the person can ask for a new one).
  CREATE TABLE IF NOT EXISTS mail_outbox (
    id INTEGER PRIMARY KEY,
    key TEXT UNIQUE,
    recipients TEXT NOT NULL,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,             -- JSON: html, text, attachments
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS mail_outbox_due ON mail_outbox(status, next_attempt_at);

  -- When the scheduled jobs last ran, and from where (cron / visit / timer), for the health page and the fallback.
  CREATE TABLE IF NOT EXISTS job_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Server errors, one row per kind (src/errors.js): no request data or user, only where in the code and how often.
  CREATE TABLE IF NOT EXISTS error_log (
    fp TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    message TEXT NOT NULL,
    frame TEXT,
    stack TEXT,
    where_ TEXT NOT NULL,
    route TEXT,
    count INTEGER NOT NULL DEFAULT 1,
    first_at TEXT NOT NULL,
    last_at TEXT NOT NULL
  );

  -- Server errors the console's admins marked as handled (per site and kind): hidden on the monitoring page and in
  -- the alerts until the same error happens again after that moment.
  CREATE TABLE IF NOT EXISTS error_handled (
    site TEXT NOT NULL,
    fp TEXT NOT NULL,
    handled_at TEXT NOT NULL,
    handled_by INTEGER,
    PRIMARY KEY (site, fp)
  );

  -- The console's open alerts (src/alerts.js): what was last e-mailed about each problem, so only news is sent.
  CREATE TABLE IF NOT EXISTS alerts (
    key TEXT PRIMARY KEY,
    level TEXT NOT NULL,
    text TEXT NOT NULL,
    since TEXT NOT NULL,
    sent_at INTEGER NOT NULL
  );

  -- Facts about the database itself: a random id and creation time written once, when it is first set up. If the id
  -- shown on the settings page changes after a new deployment, that deployment uses a different (or new) database.
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS booking_history_booking ON booking_history(booking_id);
  CREATE INDEX IF NOT EXISTS audit_log_target ON audit_log(target_type, target_id);
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

  -- Passkeys (WebAuthn) of managers and console admins: the public key only; the private key never leaves the device.
  CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    name TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);
  -- E-mails sent over SMTP per day (the console's monitoring: a shared mailbox has a daily limit, e.g. Gmail's ~500
  -- recipients). Recipients, not messages, are what such limits count.
  CREATE TABLE IF NOT EXISTS mail_daily (
    day TEXT PRIMARY KEY,
    recipients INTEGER NOT NULL DEFAULT 0,
    messages INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0
  );
  -- Phone notifications (src/push.js): one row per device that allowed them. The endpoint is the push service's
  -- address for that device; p256dh and auth are its public encryption keys (nothing secret of the user's).
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    device TEXT,
    created_at TEXT NOT NULL,
    last_sent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);
  -- One-time WebAuthn challenges: adding a passkey, signing in, confirming before a sensitive action.
  CREATE TABLE IF NOT EXISTS webauthn_challenges (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    challenge TEXT NOT NULL,
    next TEXT,
    expires_at INTEGER NOT NULL
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
  // When the owner proved they receive mail at this address (used an e-mailed link or code, or Google). An account
  // without it may have been registered by someone else with that address (SEC-003).
  addColumn('users', 'email_verified_at', 'TEXT');
  // A link counts as proof of the address only when it was really e-mailed, not shown on screen to an admin (SEC-003).
  addColumn('password_resets', 'delivered', 'INTEGER NOT NULL DEFAULT 0');
  // When a registration was rejected: its license photo is deleted 30 days later (docs/privacy.md). Existing rejected
  // accounts get the time of their rejection from the action log, else their last change.
  addColumn('users', 'rejected_at', 'TEXT');
  // A manager's level: 'owner' (alone may change managers and delete users), 'viewer' (read-only), or NULL (manager).
  addColumn('users', 'admin_level', 'TEXT');
  // When this session last proved who it is (signing in, or confirming again before a sensitive action).
  addColumn('sessions', 'auth_at', 'INTEGER');
  db.prepare(`UPDATE users SET rejected_at = COALESCE((SELECT MAX(a.at) FROM audit_log a WHERE a.action = 'user.reject' AND a.target_type = 'user'
    AND a.target_id = users.id), updated_at) WHERE status = 'rejected' AND rejected_at IS NULL`).run();
  // Accounts already linked to Google had their address proven by Google.
  db.prepare('UPDATE users SET email_verified_at = ? WHERE email_verified_at IS NULL AND google_sub IS NOT NULL').run(new Date().toISOString());
  // The columns of the two-step verification removed long ago (no version still running reads them): dropped.
  for (const [table, column] of [['users', 'totp_secret'], ['users', 'totp_enabled'], ['sessions', 'needs_2fa']]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) continue;
    try {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    } catch (err) {
      if (!/no such column/i.test(err.message)) throw err; // another instance got there first
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL');
  // For the scheduled clean-ups and checks (src/jobs.js, every 10 minutes): without these each one read its whole
  // table, the action log (two years of it) and the sessions above all. One statement, so a hosted database's first
  // start after a deploy makes one round trip for them.
  db.exec(`
  CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at);
  CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS throttle_window ON throttle(window_start);
  CREATE INDEX IF NOT EXISTS login_codes_expires ON login_codes(expires_at);
  CREATE INDEX IF NOT EXISTS password_resets_expires ON password_resets(expires_at);
  CREATE INDEX IF NOT EXISTS webauthn_challenges_expires ON webauthn_challenges(expires_at);
  CREATE INDEX IF NOT EXISTS registration_drafts_expires ON registration_drafts(expires_at);
  CREATE INDEX IF NOT EXISTS error_log_last ON error_log(last_at);
  -- License expiry (active accounts) and the rejected / never-handled registrations: by status first.
  CREATE INDEX IF NOT EXISTS users_status_license ON users(status, license_expiry);
  `);



  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

  // First start only. One statement each, so two instances starting together cannot both insert.
  // The car's row exists from the start, without details: booking stays closed until a manager enters them (R3).
  db.prepare("INSERT INTO vehicles (plate, make, model) SELECT '', '', '' WHERE NOT EXISTS (SELECT 1 FROM vehicles)").run();
  db.prepare('INSERT OR IGNORE INTO policies (version, content, created_at) SELECT 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM policies)')
    .run(fs.readFileSync(path.join(__dirname, 'default-policy.md'), 'utf8'), time.stamp());
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
  db.prepare('INSERT INTO audit_log (actor_id, action, target_type, target_id, details, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(actorId ?? null, action, targetType ?? null, targetId ?? null, details ? String(details) : null, time.stamp());
}

/**
 * A deleted account's name and e-mail are removed from what stays behind (the action log keeps what happened, as
 * "#id", and mail waiting or failed to that address is dropped), so deleting a user really forgets who they were.
 */
function forgetIdentifiers(u) {
  const name = `${u.first_name || ''} ${u.last_name || ''}`.trim();
  for (const s of [u.email, name, u.id_number, u.phone].filter((x) => x && String(x).length >= 3)) {
    db.prepare("UPDATE audit_log SET details = replace(details, ?, '[נמחק]') WHERE instr(details, ?) > 0").run(s, s);
  }
  if (u.email) db.prepare('DELETE FROM mail_outbox WHERE instr(recipients, ?) > 0').run(u.email);
}

function currentPolicy() {
  return db.prepare('SELECT * FROM policies ORDER BY version DESC LIMIT 1').get();
}

/** Has the user accepted the policy version they must have accepted? One query (it runs on most booking pages). */
function userAcceptedPolicy(userId) {
  return Boolean(db.prepare(`SELECT COALESCE((SELECT MAX(policy_version) FROM policy_acceptances WHERE user_id = ?), 0)
    >= COALESCE((SELECT MAX(version) FROM policies WHERE requires_reaccept = 1 OR version = 1), 0) AS ok`).get(userId).ok);
}

function defaultVehicle() {
  return db.prepare('SELECT * FROM vehicles ORDER BY id LIMIT 1').get();
}

if (!schemaIsCurrent) {
  db.prepare('INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)').run('db_id', require('node:crypto').randomBytes(4).toString('hex'));
  db.prepare('INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)').run('created_at', time.stamp());
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('schema_version', SCHEMA_VERSION);
  meta = readMeta();
}

/**
 * The Vercel Turso integration can create a database per deployment, named "dpl-<deployment id>-vercel-icfg-…":
 * each new version then starts empty. A permanent database (LIBSQL_URL) is needed instead.
 */
const isPerDeploymentHost = (host) => Boolean(host && /^dpl-[a-z0-9]+-vercel-icfg-/i.test(host));

/** Where the data lives, for /healthz, the settings page and the startup log. No secrets. */
function storageInfo() {
  if (!meta?.db_id) meta = readMeta() || {};
  // Any file on Vercel is temporary (wiped with each new version, and separate for every server instance).
  const kind = db.remote ? 'hosted' : config.onVercel ? 'temporary' : 'file';
  const host = db.remote ? new URL(config.database.url).host : null;
  return {
    kind, id: meta.db_id, createdAt: meta.created_at, host, from: config.database.from, file: db.remote ? null : config.dbFile,
    keyExpiresAt: db.remote ? config.databaseKeyExpiresAt : null,
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
  forgetIdentifiers,
  db, transaction, audit, getSettings, setSetting, DEFAULT_SETTINGS, storageInfo, isPerDeploymentHost,
  currentPolicy, userAcceptedPolicy, defaultVehicle,
};
