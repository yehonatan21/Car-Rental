'use strict';
// Periodic housekeeping: closing finished bookings, reminders and license-expiry checks.
const { db, getSettings, audit } = require('./db');
const bookings = require('./bookings');
const mail = require('./mail');
const time = require('./time');
const storage = require('./storage');

const withUser = `SELECT b.*, u.first_name, u.last_name, u.email, v.plate, v.make, v.model
  FROM bookings b JOIN users u ON u.id = b.user_id JOIN vehicles v ON v.id = b.vehicle_id`;

/**
 * Marks a row as handled and says whether this run got it. On Vercel several instances can run the jobs at the
 * same moment; only the one whose UPDATE changed the row sends the e-mail, so nobody gets a reminder twice.
 */
const claim = (sql, id) => db.prepare(sql).run(id).changes === 1;

/** When the jobs last ran and from where ('cron', 'visit', 'timer'): for the settings page and the visit fallback. */
function lastRun() {
  const rows = Object.fromEntries(db.prepare("SELECT key, value FROM job_state WHERE key IN ('last_run', 'last_run_by', 'last_run_ms')").all().map((r) => [r.key, r.value]));
  return rows.last_run ? { at: rows.last_run, by: rows.last_run_by, ms: Number(rows.last_run_ms) || null } : null;
}

/** Runs everything that is due. `by` says what started it. Returns what it did, for the cron's answer and the logs. */
async function runJobs({ by = 'timer' } = {}) {
  const started = Date.now();
  const summary = { reminders: 0, alerts: 0 };
  const s = getSettings();
  const now = time.now();
  // First what failed before, so a waiting reminder isn't overtaken by newer ones.
  const before = await mail.drainOutbox();
  bookings.completeFinished();
  try { require('./auth').purgeThrottle(); } catch (err) { console.error('[jobs] purging old attempt counters failed:', err.message); }

  const pickups = db.prepare(`${withUser} WHERE b.status = 'approved' AND b.kind = 'booking' AND b.pickup_reminded = 0
    AND b.start_at > ? AND b.start_at <= ?`).all(now, time.addMinutes(now, s.pickup_reminder_hours * 60));
  for (const b of pickups) {
    if (claim('UPDATE bookings SET pickup_reminded = 1 WHERE id = ? AND pickup_reminded = 0', b.id)) { await mail.pickupReminder(b); summary.reminders += 1; }
  }

  const returns = db.prepare(`${withUser} WHERE b.status = 'approved' AND b.kind = 'booking' AND b.return_reminded = 0
    AND b.start_at <= ? AND b.end_at > ? AND b.end_at <= ?`).all(now, now, time.addMinutes(now, s.return_reminder_hours * 60));
  for (const b of returns) {
    if (claim('UPDATE bookings SET return_reminded = 1 WHERE id = ? AND return_reminded = 0', b.id)) { await mail.returnReminder(b); summary.reminders += 1; }
  }

  const staleBefore = time.addMinutes(now, -s.pending_alert_hours * 60).replace('T', ' ');
  const stale = db.prepare(`${withUser} WHERE b.status = 'pending' AND b.pending_alerted = 0 AND b.created_at <= ?`).all(staleBefore)
    .filter((b) => claim('UPDATE bookings SET pending_alerted = 1 WHERE id = ? AND pending_alerted = 0', b.id));
  if (stale.length) { await mail.pendingTooLong(stale); summary.alerts += 1; }
  // Still waiting at twice that time: a second, firmer reminder to every manager (pending_alerted 1 → 2).
  const staleTwice = time.addMinutes(now, -2 * s.pending_alert_hours * 60).replace('T', ' ');
  const ignored = db.prepare(`${withUser} WHERE b.status = 'pending' AND b.pending_alerted = 1 AND b.created_at <= ?`).all(staleTwice)
    .filter((b) => claim('UPDATE bookings SET pending_alerted = 2 WHERE id = ? AND pending_alerted = 1', b.id));
  if (ignored.length) { await mail.pendingTooLong(ignored, { again: true }); summary.alerts += 1; }

  const today = time.today();
  const expired = db.prepare("SELECT * FROM users WHERE status = 'active' AND license_expiry < ?").all(today)
    .filter((u) => claim("UPDATE users SET status = 'license_update' WHERE id = ? AND status = 'active'", u.id));
  for (const u of expired) audit(null, 'user.license_expired', 'user', u.id, u.license_expiry);
  if (expired.length) await mail.licensesExpiredAdmin(expired);

  const expiring = db.prepare(`SELECT * FROM users WHERE status = 'active' AND license_expiry >= ? AND license_expiry <= ?
    AND (license_warned_for IS NULL OR license_warned_for != license_expiry)`).all(today, time.addDays(today, s.license_warn_days));
  for (const u of expiring) {
    const claimed = claim(`UPDATE users SET license_warned_for = license_expiry WHERE id = ?
      AND (license_warned_for IS NULL OR license_warned_for != license_expiry)`, u.id);
    if (claimed) await mail.licenseExpiring(u);
  }

  // Rejected registrations: their license photos are deleted 30 days after the rejection (docs/privacy.md).
  const cutoff = time.stamp(new Date(Date.now() - 30 * 86400000));
  for (const u of db.prepare(`SELECT id, license_file, pending_license_file FROM users WHERE status = 'rejected' AND rejected_at < ?
    AND (license_file IS NOT NULL OR pending_license_file IS NOT NULL)`).all(cutoff)) {
    if (!claim("UPDATE users SET license_file = NULL, pending_license_file = NULL WHERE id = ? AND status = 'rejected'", u.id)) continue;
    for (const f of [u.license_file, u.pending_license_file]) if (f) storage.remove(f);
    audit(null, 'user.license_deleted', 'user', u.id, '30 ימים אחרי דחיית ההרשמה');
  }

  // Registrations nobody approved or rejected for 90 days: the account and its license photo are deleted (S-09,
  // docs/privacy.md). The dashboard lists them all along. Never an account with bookings, or a manager.
  const unhandledSince = time.stamp(new Date(Date.now() - 90 * 86400000));
  for (const u of db.prepare(`SELECT id, email, first_name, last_name, id_number, phone, license_file, pending_license_file FROM users WHERE status = 'pending' AND role = 'user'
    AND created_at < ? AND NOT EXISTS (SELECT 1 FROM bookings WHERE user_id = users.id)`).all(unhandledSince)) {
    if (!claim("DELETE FROM users WHERE id = ? AND status = 'pending'", u.id)) continue;
    for (const f of [u.license_file, u.pending_license_file]) if (f) storage.remove(f);
    require('./db').forgetIdentifiers(u);
    audit(null, 'user.pending_expired', 'user', u.id, '90 ימים בלי אישור או דחייה');
  }
  // The action log keeps two years.
  db.prepare('DELETE FROM audit_log WHERE at < ?').run(time.stamp(new Date(Date.now() - 730 * 86400000)));

  // Abandoned registration attempts: delete the kept license image too.
  for (const d of db.prepare('SELECT * FROM registration_drafts WHERE expires_at < ?').all(Date.now())) {
    storage.remove(d.license_file);
    db.prepare('DELETE FROM registration_drafts WHERE token_hash = ?').run(d.token_hash);
  }
  db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(Date.now());
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('DELETE FROM login_codes WHERE expires_at < ?').run(Date.now());

  const after = await mail.drainOutbox(); // anything that failed just now and is already due (none, normally)
  const ms = Date.now() - started;
  const set = db.prepare('INSERT INTO job_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  set.run('last_run', time.stamp());
  set.run('last_run_by', by);
  set.run('last_run_ms', String(ms));
  return { ...summary, mail_sent: before.sent + after.sent, mail_failed: before.failed + after.failed, mail_waiting: after.waiting, ms };
}

function startJobs(intervalMs = 5 * 60000) {
  const tick = () => runJobs({ by: 'timer' }).catch((err) => console.error('[jobs]', err));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runJobs, startJobs, lastRun };
