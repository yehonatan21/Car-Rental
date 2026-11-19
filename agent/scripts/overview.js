'use strict';
// node scripts/overview.js — the site at a glance: users, waiting items, the next 14 days, last 30 days' use, alerts.
const { all, one, run, overlapHours, round, time } = require('./lib/db');

run(() => {
  const now = time.now();
  const today = time.today();
  const usersByStatus = Object.fromEntries(all("SELECT status, COUNT(*) AS n FROM users WHERE role = 'user' GROUP BY status").map((r) => [r.status, r.n]));
  const admins = one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").n;
  const pending = all(`SELECT b.id, b.start_at, b.end_at, b.created_at, u.first_name || ' ' || u.last_name AS user_name
    FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.status = 'pending' AND b.kind = 'booking' ORDER BY b.created_at`);
  const upcoming = all(`SELECT b.id, b.kind, b.start_at, b.end_at, b.block_reason, u.first_name || ' ' || u.last_name AS user_name
    FROM bookings b LEFT JOIN users u ON u.id = b.user_id WHERE b.status = 'approved' AND b.end_at > ? AND b.start_at < ? ORDER BY b.start_at`,
  now, `${time.addDays(today, 14)}T00:00`);
  const from30 = `${time.addDays(today, -30)}T00:00`;
  const past = all(`SELECT start_at, end_at FROM bookings WHERE kind = 'booking' AND status IN ('approved','completed') AND end_at > ? AND start_at < ?`, from30, now);
  const bookedHours = past.reduce((h, b) => h + overlapHours(b.start_at, b.end_at, from30, now), 0);
  const vehicle = one('SELECT plate, make, model, status, insurance_renewal, registration_renewal, next_service FROM vehicles ORDER BY id LIMIT 1') || {};
  const soon = time.addDays(today, 30);
  const alerts = [];
  for (const [k, label] of [['insurance_renewal', 'insurance renewal'], ['registration_renewal', 'registration (test) renewal'], ['next_service', 'next service']]) {
    if (vehicle[k] && vehicle[k] <= soon) alerts.push(`${label}: ${time.fmt(vehicle[k])}${vehicle[k] < today ? ' (overdue)' : ''}`);
  }
  const licensesExpiring = one("SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND license_expiry IS NOT NULL AND license_expiry <= ?", soon).n;
  const settings = Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, Number(r.value)]));
  return {
    generated_at: time.fmt(now),
    users: { by_status: usersByStatus, admins },
    waiting: {
      booking_requests: pending.map((b) => ({ id: b.id, user: b.user_name, from: time.fmt(b.start_at), to: time.fmt(b.end_at), waiting_hours: round(time.hoursBetween(b.created_at.replace(' ', 'T').slice(0, 16), now)) })),
      registrations: usersByStatus.pending || 0,
      licenses_to_review: one('SELECT COUNT(*) AS n FROM users WHERE pending_license_file IS NOT NULL').n,
    },
    next_14_days: { bookings: upcoming.filter((b) => b.kind === 'booking').length, blocks: upcoming.filter((b) => b.kind === 'block').length,
      items: upcoming.map((b) => ({ id: b.id, kind: b.kind, who: b.kind === 'block' ? b.block_reason : b.user_name, from: time.fmt(b.start_at), to: time.fmt(b.end_at) })) },
    last_30_days: { bookings: past.length, booked_hours: round(bookedHours), utilization_pct: round((bookedHours / (30 * 24)) * 100) },
    vehicle: { plate: vehicle.plate, model: [vehicle.make, vehicle.model].filter(Boolean).join(' '), status: vehicle.status, alerts },
    licenses_expiring_30_days: licensesExpiring,
    rules: settings,
  };
});
