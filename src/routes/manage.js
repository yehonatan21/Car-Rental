'use strict';
// The management API of a client instance, used by the master console (routes/master.js) that manages all the
// client instances. Every client keeps its own deployment and database; the console reaches each one here, over
// HTTPS, with that instance's MANAGE_TOKEN (set by the console when it creates the instance). Without MANAGE_TOKEN
// the API does not exist (404).
//
//   GET  /api/manage/status          name, look, numbers (users, bookings…), version, e-mail and suspension state
//   POST /api/manage/branding        name, sender name, colour, contact details, welcome text, logo
//   GET  /api/manage/admins          the instance's managers
//   POST /api/manage/admins          adds (or re-invites) a manager: invitation e-mail with a link to choose a password
//   POST /api/manage/admins/:id/remove
//   POST /api/manage/login-link      a one-time sign-in link for the console's admin (GET /manage/sso)
//   POST /api/manage/suspend         suspends or resumes the whole site
//   GET  /api/manage/users[?q=]      finds users; GET /api/manage/users/:id
//   POST /api/manage/users/:id/password   a new password, set by the console's main admin
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { db, audit, storageInfo } = require('../db');
const auth = require('../auth');
const { passwordProblem } = require('../passwords');
const mail = require('../mail');
const time = require('../time');
const config = require('../config');
const storage = require('../storage');
const google = require('../google');
const { brand, saveBrand, validColor, DEFAULT_COLOR } = require('../brand');
const { html, layout } = require('../views/html');
const { validEmail } = require('./public');

const clean = (v) => String(v ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
const manageToken = () => clean(process.env.MANAGE_TOKEN);
/** The API is on only with a long enough token (it grants full control of the site). Read on every request. */
const enabled = () => !config.master && manageToken().length >= 32;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const SSO_TTL_MS = 2 * 60000;
const LOGO_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const LOGO_MAX_BYTES = 1024 * 1024;

// ---------- Suspension: the whole site shows a notice (the console can still manage it) ----------
let suspendCache = null;
/** { at, message } while the site is suspended, else null. Cached briefly; Vercel runs several server instances. */
function suspension() {
  if (!suspendCache || Date.now() - suspendCache.at > 5000) {
    const row = db.prepare("SELECT value FROM app_meta WHERE key = 'suspended'").get();
    let value = null;
    if (row) try { value = JSON.parse(row.value); } catch { value = { message: '' }; }
    suspendCache = { at: Date.now(), value };
  }
  return suspendCache.value;
}

function setSuspended(value) {
  if (value) {
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('suspended', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(value));
  } else {
    db.prepare("DELETE FROM app_meta WHERE key = 'suspended'").run();
  }
  suspendCache = null;
}

const ALWAYS_OPEN = /^\/(static\/|healthz$|favicon\.ico$|brand\/logo$|api\/manage\/)/;

/** While suspended, every page shows the notice; the management API, health check and files keep working. */
function suspendedGate(req, res, next) {
  if (config.master || ALWAYS_OPEN.test(req.path)) return next();
  const s = suspension();
  if (!s) return next();
  const b = brand();
  const contact = [b.contactPhone, b.contactEmail].filter(Boolean).join(' · ');
  res.status(503).set({ 'Cache-Control': 'no-store', 'Retry-After': '3600' }).type('html').send(layout({ path: req.path }, 'השירות מושהה', html`
<div class="narrow">
  <section class="card suspended">
    <h1>השירות מושהה זמנית</h1>
    <p>${s.message || 'האתר אינו זמין כרגע. נסו שוב מאוחר יותר.'}</p>
    ${contact ? html`<p class="muted">ליצירת קשר: <span dir="ltr">${contact}</span></p>` : ''}
  </section>
</div>`, { bare: true }));
}

// ---------- What the console sees ----------
/**
 * Every number the status reports, in ONE statement: on a hosted database each statement is a round trip (~8 ms from
 * Vercel to Turso), and the console asks every site for its status on each page and every 10 minutes. They used to
 * be about 20 separate queries.
 */
function numbers() {
  const now = time.now();
  const today = time.today();
  const since24h = time.stamp(new Date(Date.now() - 24 * 3600000));
  return db.prepare(`SELECT
    (SELECT COUNT(*) FROM users WHERE role = 'user') AS users,
    (SELECT COUNT(*) FROM users WHERE role = 'user' AND status = 'active') AS active_users,
    (SELECT COUNT(*) FROM users WHERE status = 'pending' OR (status = 'license_update' AND pending_license_file IS NOT NULL)) AS pending_users,
    (SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active') AS admins,
    (SELECT COUNT(*) FROM users) AS all_users,
    (SELECT COUNT(*) FROM bookings WHERE kind = 'booking') AS bookings,
    (SELECT COUNT(*) FROM bookings) AS all_bookings,
    (SELECT COUNT(*) FROM bookings WHERE kind = 'booking' AND status = 'pending' AND end_at > ?) AS pending_bookings,
    (SELECT COUNT(*) FROM bookings WHERE kind = 'booking' AND status = 'approved' AND start_at > ?) AS upcoming_bookings,
    (SELECT MAX(created_at) FROM bookings WHERE kind = 'booking') AS last_booking_at,
    (SELECT COUNT(*) FROM vehicles) AS vehicles,
    -- The action log only loses its oldest rows (jobs.js), so its ids are contiguous: two rows read instead of all.
    (SELECT COALESCE(MAX(id) - MIN(id) + 1, 0) FROM audit_log) AS audit,
    (SELECT COUNT(*) FROM sessions WHERE expires_at > ?) AS sessions,
    (SELECT value FROM job_state WHERE key = 'last_run') AS last_run,
    (SELECT value FROM job_state WHERE key = 'last_run_by') AS last_run_by,
    (SELECT value FROM job_state WHERE key = 'last_run_ms') AS last_run_ms,
    (SELECT recipients FROM mail_daily WHERE day = ?) AS today_recipients,
    (SELECT messages FROM mail_daily WHERE day = ?) AS today_messages,
    (SELECT failed FROM mail_daily WHERE day = ?) AS today_failed,
    (SELECT COALESCE(SUM(recipients), 0) FROM mail_daily WHERE day > ?) AS week_recipients,
    (SELECT COALESCE(SUM(failed), 0) FROM mail_daily WHERE day > ?) AS week_failed,
    (SELECT COUNT(*) FROM mail_outbox WHERE status IN ('pending', 'sending')) AS mail_waiting,
    (SELECT COUNT(*) FROM mail_outbox WHERE status = 'failed' AND message != '{}') AS mail_failed,
    (SELECT COUNT(*) FROM error_log WHERE last_at >= ?) AS error_kinds,
    (SELECT COUNT(*) FROM error_log WHERE first_at >= ?) AS error_new,
    -- Files kept in the hosted database (empty with a local one, whose files are on disk). length() of a stored chunk
    -- comes from its row header: the file contents themselves are not read.
    (SELECT COUNT(DISTINCT name) FROM files) AS file_count,
    (SELECT COALESCE(SUM(length(data)), 0) FROM files) AS file_bytes`)
    .get(now, now, Date.now(), today, today, today, time.addDays(today, -7), time.addDays(today, -7), since24h, since24h);
}

function counts(n = numbers()) {
  return {
    users: n.users,
    activeUsers: n.active_users,
    // New accounts and new license photos the managers still have to approve.
    pendingUsers: n.pending_users,
    admins: n.admins,
    bookings: n.bookings,
    pendingBookings: n.pending_bookings,
    upcomingBookings: n.upcoming_bookings,
    vehicles: n.vehicles,
  };
}

/** The database's size in bytes, or null where the hosted database doesn't answer PRAGMAs. */
function databaseSize() {
  try {
    return db.prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get().bytes;
  } catch {
    try {
      return db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;
    } catch { return null; }
  }
}

/**
 * How this site is doing, for the console's monitoring: database size and rows, stored files, how long a query takes,
 * when the scheduled jobs last ran, and the e-mails sent today. Counts only, no personal data.
 */
function metrics(n = numbers()) {
  const t0 = process.hrtime.bigint();
  db.prepare('SELECT 1').get(); // one round trip, measured on its own: the database's latency as this site sees it
  const queryMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const sizeBytes = databaseSize();
  const files = storage.inDatabase()
    ? { n: n.file_count, bytes: n.file_bytes }
    : (() => {
      try {
        const dir = config.uploadsDir;
        const names = fs.readdirSync(dir);
        return { n: names.length, bytes: names.reduce((t, f) => t + fs.statSync(path.join(dir, f)).size, 0) };
      } catch { return { n: 0, bytes: 0 }; }
    })();
  return {
    db: {
      sizeBytes, queryMs: Math.round(queryMs * 10) / 10,
      rows: { users: n.all_users, bookings: n.all_bookings, audit: n.audit, sessions: n.sessions },
    },
    files: { count: files.n, bytes: files.bytes },
    jobs: { lastRun: n.last_run || null, by: n.last_run_by || null, ms: n.last_run_ms ? Number(n.last_run_ms) : null },
    mail: {
      today: { recipients: n.today_recipients ?? 0, messages: n.today_messages ?? 0, failed: n.today_failed ?? 0 },
      week: { recipients: n.week_recipients, failed: n.week_failed },
      waiting: n.mail_waiting,
      failed: n.mail_failed,
    },
    runtime: { node: process.version, region: process.env.VERCEL_REGION || null },
    errors: { kinds24h: n.error_kinds, new24h: n.error_new, recent: require('../errors').recent() },
  };
}

function status() {
  const b = brand();
  const s = storageInfo();
  const n = numbers();
  return {
    app: 'car-rental',
    api: 1,
    version: { commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null, branch: process.env.VERCEL_GIT_COMMIT_REF || null },
    baseUrl: config.baseUrl,
    branding: {
      name: b.name, mailFromName: b.mailFromName, color: b.color, contactEmail: b.contactEmail, contactPhone: b.contactPhone,
      welcomeText: b.welcomeText, logo: Boolean(b.logoFile), stored: b.stored,
    },
    suspended: suspension(),
    counts: counts(n),
    lastBookingAt: n.last_booking_at || null,
    storage: { kind: s.kind, id: s.id, createdAt: s.createdAt, perDeployment: s.perDeployment, host: s.host, keyExpiresAt: s.keyExpiresAt },
    mail: { configured: Boolean(config.smtp), from: config.mailFrom },
    google: google.enabled(),
    googleRelay: google.status().relay,
    metrics: metrics(n),
  };
}

const adminRow = (u) => ({
  id: u.id, firstName: u.first_name, lastName: u.last_name, email: u.email, status: u.status, createdAt: u.created_at,
  // Has not chosen a password yet (and does not sign in with Google): the invitation was not used.
  invitePending: !u.password_hash && !u.google_sub,
});

/** A user as the console sees it (no ID number, no license). */
const userRow = (u) => ({
  id: u.id, firstName: u.first_name, lastName: u.last_name, email: u.email, phone: u.phone, role: u.role, status: u.status,
  hasPassword: Boolean(u.password_hash), google: Boolean(u.google_sub), createdAt: u.created_at,
});

function admins() {
  return db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id").all().map(adminRow);
}

/** A manager account for this e-mail: created, or an existing account made an active admin. */
function ensureAdmin({ email, firstName, lastName, note }) {
  const now = time.stamp();
  let u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u) {
    const id = Number(db.prepare(`INSERT INTO users (first_name, last_name, id_number, phone, email, role, status, admin_note,
        created_at, updated_at) VALUES (?, ?, ?, '', ?, 'admin', 'active', ?, ?, ?)`)
      .run(firstName || 'מנהל', lastName || '', `manager-${crypto.randomUUID()}`, email, note || null, now, now).lastInsertRowid);
    return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(id), created: true, promoted: false };
  }
  if (u.role !== 'admin' || u.status !== 'active') {
    // Becoming a manager: an account whose e-mail was never proved may have been registered by someone else with this
    // address, with their own password. That password and its sessions go; the invitation sets a new one (SEC-003).
    if (auth.distrustUnverified(u)) audit(null, 'manage.unverified_password_removed', 'user', u.id, email);
    db.prepare("UPDATE users SET role = 'admin', status = 'active', updated_at = ? WHERE id = ?").run(now, u.id);
    u = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
    return { user: u, created: false, promoted: true };
  }
  return { user: u, created: false, promoted: false };
}

const by = (req) => String(req.body?.by || 'מרכז הניהול').slice(0, 120);
const bad = (res, message) => res.status(400).json({ error: 'invalid', message });

module.exports = ({ app }) => {
  const json = express.json({ limit: '2mb' });

  function requireToken(req, res, next) {
    if (!enabled()) return res.status(404).json({ error: 'not_enabled' });
    const given = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '')?.[1]?.trim() || '';
    if (!crypto.timingSafeEqual(sha(given), sha(manageToken()))) {
      if (auth.throttled('manage:' + req.ip, 20)) return res.status(429).json({ error: 'too_many_attempts' });
      console.warn(`[manage] refused a request with a wrong token on ${req.method} ${req.path}`);
      return res.status(401).json({ error: 'unauthorized' });
    }
    res.set('Cache-Control', 'no-store');
    next();
  }

  app.get('/api/manage/status', requireToken, (req, res) => res.json(status()));

  app.post('/api/manage/branding', requireToken, json, (req, res) => {
    const b = req.body || {};
    const values = {};
    for (const k of ['org_name', 'mail_from_name', 'contact_phone', 'contact_email', 'welcome_text']) if (k in b) values[k] = String(b[k] ?? '').trim();
    if ('brand_color' in b) {
      const color = String(b.brand_color || '').trim().toLowerCase();
      if (color && !validColor(color)) return bad(res, 'הצבע אינו תקין (למשל ‎#1d4ed8)');
      values.brand_color = color === DEFAULT_COLOR ? '' : color; // the default colour: no override
    }
    if (values.contact_email && !validEmail(values.contact_email)) return bad(res, 'כתובת המייל ליצירת קשר אינה תקינה');
    const old = brand().logoFile;
    if (b.logo?.data) {
      const ext = LOGO_TYPES[b.logo.type];
      if (!ext) return bad(res, 'הלוגו צריך להיות תמונה (PNG, JPG או WebP)');
      const data = Buffer.from(String(b.logo.data), 'base64');
      if (!data.length || data.length > LOGO_MAX_BYTES) return bad(res, 'קובץ הלוגו גדול מדי (עד 1MB)');
      const filename = crypto.randomBytes(16).toString('hex') + ext;
      const file = path.join(config.uploadsDir, filename);
      fs.writeFileSync(file, data);
      storage.keep({ path: file, filename });
      values.logo_file = filename;
    } else if (b.remove_logo) {
      values.logo_file = '';
    }
    saveBrand(values);
    if ('logo_file' in values && old) storage.remove(old);
    audit(null, 'manage.branding', null, null, `${by(req)}: ${Object.keys(values).join(', ')}`);
    res.json(status());
  });

  app.get('/api/manage/admins', requireToken, (req, res) => res.json({ admins: admins() }));

  app.post('/api/manage/admins', requireToken, json, async (req, res) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    if (!validEmail(email)) return bad(res, 'כתובת הדואר האלקטרוני של המנהל/ת אינה תקינה');
    const { user, created, promoted } = ensureAdmin({
      email, firstName: String(b.first_name || '').trim().slice(0, 60), lastName: String(b.last_name || '').trim().slice(0, 60),
    });
    // A link to choose a password: for a new account, one that never chose a password, or when asked for a new one.
    let link = null;
    let token = null;
    if (created || (!user.password_hash && !user.google_sub) || b.new_link) {
      token = auth.createPasswordReset(user.id, auth.INVITE_TTL_MS);
      link = `/password/reset?token=${encodeURIComponent(token)}`;
    }
    let emailed = false;
    if (b.send_email !== false && (token || promoted)) {
      emailed = Boolean(await mail.managerInvitation(user, token, String(b.invited_by || 'מנהל השירות').slice(0, 80))) && Boolean(config.smtp);
      if (emailed && token) auth.markResetDelivered(token);
    }
    audit(null, created ? 'manage.admin_create' : promoted ? 'manage.admin_promote' : 'manage.admin_invite', 'user', user.id, `${by(req)}: ${email}`);
    res.json({ admin: adminRow(user), created, promoted, link, emailed, mailConfigured: Boolean(config.smtp) });
  });

  app.post('/api/manage/admins/:id/remove', requireToken, json, (req, res) => {
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'admin'").get(Number(req.params.id));
    if (!u) return res.status(404).json({ error: 'not_found', message: 'המנהל/ת לא נמצא/ה' });
    db.prepare("UPDATE users SET role = 'user', updated_at = ? WHERE id = ?").run(time.stamp(), u.id);
    audit(null, 'manage.admin_remove', 'user', u.id, `${by(req)}: ${u.email}`);
    res.json({ admins: admins() });
  });

  // A one-time link that signs the console's admin in here as a manager (their own account, created when missing).
  app.post('/api/manage/login-link', requireToken, json, (req, res) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    if (!validEmail(email)) return bad(res, 'כתובת הדואר האלקטרוני אינה תקינה');
    const { user, created, promoted } = ensureAdmin({
      email, firstName: String(b.first_name || '').trim().slice(0, 60), lastName: String(b.last_name || '').trim().slice(0, 60),
      note: 'מנהל השירות (מרכז הניהול)',
    });
    if (created || promoted) audit(null, created ? 'manage.admin_create' : 'manage.admin_promote', 'user', user.id, `${by(req)}: ${email} (כניסה ממרכז הניהול)`);
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM sso_tokens WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO sso_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(auth.sha256(token), user.id, Date.now() + SSO_TTL_MS);
    res.json({ path: `/manage/sso?token=${encodeURIComponent(token)}`, expiresInSeconds: SSO_TTL_MS / 1000 });
  });

  // The console's scheduled run calls this on every site: reminders, alerts, retrying failed e-mails.
  app.post('/api/manage/run-jobs', requireToken, async (req, res) => {
    res.json({ ok: true, ...(await require('../jobs').runJobs({ by: 'cron' })) });
  });

  app.get('/manage/sso', (req, res) => {
    const hash = auth.sha256(String(req.query.token || ''));
    const row = enabled() && db.prepare('SELECT * FROM sso_tokens WHERE token_hash = ?').get(hash);
    // Single use: only the request that deletes the row signs in.
    const ok = row && row.expires_at > Date.now() && db.prepare('DELETE FROM sso_tokens WHERE token_hash = ?').run(hash).changes === 1;
    if (!ok) {
      return res.status(400).page('הקישור אינו תקף', html`
<div class="narrow"><section class="card">
  <h1>קישור הכניסה אינו תקף</h1>
  <p>קישור כניסה ממרכז הניהול תקף לשתי דקות ולשימוש אחד. חזרו למרכז הניהול ולחצו שוב על "כניסה כמנהל", או התחברו כאן כרגיל.</p>
  <p><a class="btn btn-primary" href="/login">להתחברות</a></p>
</section></div>`);
    }
    auth.destroySession(req, res);
    auth.createSession(res, row.user_id);
    audit(row.user_id, 'manage.sso', 'user', row.user_id, 'כניסה ממרכז הניהול');
    // ?next=: the console can open a page of the admin area (e.g. the pending requests); nothing outside /admin.
    const next = String(req.query.next || '');
    res.set('Cache-Control', 'no-store').redirect(303, /^\/admin(\/|\?|$)/.test(next) && !/[\r\n\\]/.test(next) ? next : '/admin');
  });

  // Users, for the console's main admin: find someone and set them a new password.
  app.get('/api/manage/users', requireToken, (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = q
      // Not by ID number: the console never needs it, so it cannot be used to check whose ID number is registered.
      ? db.prepare(`SELECT * FROM users WHERE first_name || ' ' || last_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'
          OR phone LIKE ? ESCAPE '\\' ORDER BY role = 'admin' DESC, first_name, last_name LIMIT 50`).all(like, like, like)
      : db.prepare("SELECT * FROM users ORDER BY role = 'admin' DESC, id DESC LIMIT 50").all();
    res.json({ users: rows.map(userRow), total: db.prepare('SELECT COUNT(*) AS n FROM users').get().n });
  });

  app.get('/api/manage/users/:id', requireToken, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!u) return res.status(404).json({ error: 'not_found', message: 'המשתמש/ת לא נמצא/ה' });
    res.json({ user: userRow(u) });
  });

  // A new password set by the console's main admin: every session of the user ends; optionally they are told by e-mail
  // (the password itself is never sent).
  app.post('/api/manage/users/:id/password', requireToken, json, async (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!u) return res.status(404).json({ error: 'not_found', message: 'המשתמש/ת לא נמצא/ה' });
    const password = String(req.body?.password || '');
    const problem = passwordProblem(password, u);
    if (problem) return bad(res, problem);
    // Off the main thread (~35 ms of CPU): other requests on the instance don't wait.
    const passwordHash = await auth.hashPasswordAsync(password);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(passwordHash, time.stamp(), u.id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(u.id);
    auth.destroyAllSessions(u.id);
    audit(null, 'manage.password_set', 'user', u.id, `${by(req)}: ${u.email}`);
    const emailed = req.body?.notify ? Boolean(await mail.passwordSetByAdmin(u)) && Boolean(config.smtp) : false;
    res.json({ user: userRow(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)), emailed, mailConfigured: Boolean(config.smtp) });
  });

  app.post('/api/manage/suspend', requireToken, json, (req, res) => {
    const b = req.body || {};
    setSuspended(b.suspended ? { at: time.stamp(), message: String(b.message || '').trim().slice(0, 500) } : null);
    audit(null, b.suspended ? 'manage.suspend' : 'manage.resume', null, null, by(req));
    res.json(status());
  });
};

module.exports.suspendedGate = suspendedGate;
module.exports.metrics = metrics;
module.exports.suspension = suspension;
module.exports.enabled = enabled;
