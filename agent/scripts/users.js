'use strict';
// node scripts/users.js [--expiring-days 30] [--inactive-days 90]
// Users by status, registrations and licenses waiting for review, licenses about to expire, who uses the car most,
// active users who have not booked for a while. Never prints ID numbers or phone numbers.
const { all, run, round, time } = require('./lib/db');

run((a) => {
  const today = time.today();
  const soon = time.addDays(today, Number(a['expiring-days']) || 30);
  const idleSince = `${time.addDays(today, -(Number(a['inactive-days']) || 90))}T00:00`;
  const name = "first_name || ' ' || last_name";
  const byStatus = all("SELECT status, role, COUNT(*) AS n FROM users GROUP BY status, role");
  const waiting = all(`SELECT id, ${name} AS name, email, created_at FROM users WHERE status = 'pending' ORDER BY created_at`);
  const licenseReview = all(`SELECT id, ${name} AS name, pending_license_expiry FROM users WHERE pending_license_file IS NOT NULL`);
  const expiring = all(`SELECT id, ${name} AS name, license_expiry FROM users WHERE status = 'active' AND role = 'user'
    AND license_expiry IS NOT NULL AND license_expiry <= ? ORDER BY license_expiry`, soon);
  const top = all(`SELECT u.id, u.first_name || ' ' || u.last_name AS name, COUNT(b.id) AS bookings,
      SUM((julianday(b.end_at) - julianday(b.start_at)) * 24) AS hours
    FROM users u JOIN bookings b ON b.user_id = u.id AND b.kind = 'booking' AND b.status IN ('approved','completed') AND b.start_at >= ?
    GROUP BY u.id ORDER BY hours DESC LIMIT 10`, idleSince);
  const inactive = all(`SELECT u.id, u.first_name || ' ' || u.last_name AS name, MAX(b.start_at) AS last_booking FROM users u
    LEFT JOIN bookings b ON b.user_id = u.id AND b.kind = 'booking' AND b.status IN ('approved','completed')
    WHERE u.status = 'active' AND u.role = 'user' GROUP BY u.id HAVING last_booking IS NULL OR last_booking < ? ORDER BY last_booking`, idleSince);
  return {
    by_status: byStatus,
    registrations_waiting: waiting.map((u) => ({ ...u, waiting_days: round(time.hoursBetween(u.created_at.replace(' ', 'T').slice(0, 16), time.now()) / 24) })),
    licenses_to_review: licenseReview.map((u) => ({ ...u, pending_license_expiry: time.fmt(u.pending_license_expiry) })),
    licenses_expiring: expiring.map((u) => ({ ...u, license_expiry: time.fmt(u.license_expiry), expired: u.license_expiry < today })),
    top_users: top.map((u) => ({ ...u, hours: round(u.hours) })),
    inactive_users: inactive.map((u) => ({ ...u, last_booking: u.last_booking ? time.fmt(u.last_booking) : 'never' })),
  };
});
