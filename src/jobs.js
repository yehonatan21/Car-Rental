'use strict';
// Periodic housekeeping: closing finished bookings, reminders and license-expiry checks.
const { db, getSettings, audit } = require('./db');
const bookings = require('./bookings');
const mail = require('./mail');
const time = require('./time');
const storage = require('./storage');

const withUser = `SELECT b.*, u.first_name, u.last_name, u.email, v.plate, v.make, v.model
  FROM bookings b JOIN users u ON u.id = b.user_id JOIN vehicles v ON v.id = b.vehicle_id`;

async function runJobs() {
  const s = getSettings();
  const now = time.now();
  bookings.completeFinished();

  const pickups = db.prepare(`${withUser} WHERE b.status = 'approved' AND b.kind = 'booking' AND b.pickup_reminded = 0
    AND b.start_at > ? AND b.start_at <= ?`).all(now, time.addMinutes(now, s.pickup_reminder_hours * 60));
  for (const b of pickups) {
    db.prepare('UPDATE bookings SET pickup_reminded = 1 WHERE id = ?').run(b.id);
    await mail.pickupReminder(b);
  }

  const returns = db.prepare(`${withUser} WHERE b.status = 'approved' AND b.kind = 'booking' AND b.return_reminded = 0
    AND b.start_at <= ? AND b.end_at > ? AND b.end_at <= ?`).all(now, now, time.addMinutes(now, s.return_reminder_hours * 60));
  for (const b of returns) {
    db.prepare('UPDATE bookings SET return_reminded = 1 WHERE id = ?').run(b.id);
    await mail.returnReminder(b);
  }

  const staleBefore = time.addMinutes(now, -s.pending_alert_hours * 60).replace('T', ' ');
  const stale = db.prepare(`${withUser} WHERE b.status = 'pending' AND b.pending_alerted = 0 AND b.created_at <= ?`).all(staleBefore);
  if (stale.length) {
    for (const b of stale) db.prepare('UPDATE bookings SET pending_alerted = 1 WHERE id = ?').run(b.id);
    await mail.pendingTooLong(stale);
  }

  const today = time.today();
  const expired = db.prepare("SELECT * FROM users WHERE status = 'active' AND license_expiry < ?").all(today);
  if (expired.length) {
    for (const u of expired) {
      db.prepare("UPDATE users SET status = 'license_update' WHERE id = ?").run(u.id);
      audit(null, 'user.license_expired', 'user', u.id, u.license_expiry);
    }
    await mail.licensesExpiredAdmin(expired);
  }

  const expiring = db.prepare(`SELECT * FROM users WHERE status = 'active' AND license_expiry >= ? AND license_expiry <= ?
    AND (license_warned_for IS NULL OR license_warned_for != license_expiry)`).all(today, time.addDays(today, s.license_warn_days));
  for (const u of expiring) {
    db.prepare('UPDATE users SET license_warned_for = license_expiry WHERE id = ?').run(u.id);
    await mail.licenseExpiring(u);
  }

  // Abandoned registration attempts: delete the kept license image too.
  for (const d of db.prepare('SELECT * FROM registration_drafts WHERE expires_at < ?').all(Date.now())) {
    storage.remove(d.license_file);
    db.prepare('DELETE FROM registration_drafts WHERE token_hash = ?').run(d.token_hash);
  }
  db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(Date.now());
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('DELETE FROM login_codes WHERE expires_at < ?').run(Date.now());
}

function startJobs(intervalMs = 5 * 60000) {
  const tick = () => runJobs().catch((err) => console.error('[jobs]', err));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runJobs, startJobs };
