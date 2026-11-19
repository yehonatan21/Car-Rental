'use strict';
// Reports for a site's managers (/admin/reports): how much the car is used, when, how fast requests are answered,
// cancellations and downtime, over a period. Fixed queries only: no free-form SQL and no personal data beyond names.
const { db } = require('./db');
const time = require('./time');

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** Hours of [s, e) inside [from, to) (local "YYYY-MM-DDTHH:MM" strings). */
function overlapHours(s, e, from, to) {
  const a = s > from ? s : from;
  const b = e < to ? e : to;
  return b > a ? time.hoursBetween(a, b) : 0;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** "2026-11-19 10:00:00" (created_at, history) → "2026-11-19T10:00". */
const local = (stamp) => String(stamp).replace(' ', 'T').slice(0, 16);

/**
 * The report for the days from..to (YYYY-MM-DD, both included), for the site's car. Only the past and the present
 * count as use: future bookings in the period are counted separately ("booked ahead").
 */
function usageReport(vehicleId, from, to) {
  const start = `${from}T00:00`;
  const end = `${time.addDays(to, 1)}T00:00`;
  const now = time.now();
  const until = end < now ? end : now; // use so far; the rest of the period is still ahead
  const days = [];
  for (let d = from; d <= to; d = time.addDays(d, 1)) days.push(d);
  const pastDays = days.filter((d) => `${d}T00:00` < until).length || 1;

  const rows = db.prepare(`SELECT id, user_id, kind, status, start_at, end_at, created_at FROM bookings
    WHERE vehicle_id = ? AND start_at < ? AND end_at > ?`).all(vehicleId, end, start);
  const used = rows.filter((b) => b.kind === 'booking' && ['approved', 'completed'].includes(b.status));
  const blocks = rows.filter((b) => b.kind === 'block' && b.status === 'approved');

  let bookedHours = 0;
  const weekday = Array(7).fill(0);
  const hourOfDay = Array(24).fill(0);
  const perDay = new Map(days.map((d) => [d, 0]));
  for (const b of used) {
    bookedHours += overlapHours(b.start_at, b.end_at, start, until);
    for (const d of days) {
      const ds = `${d}T00:00`;
      if (ds >= until) break;
      const h = overlapHours(b.start_at, b.end_at, ds, time.addDays(d, 1) + 'T00:00');
      if (!h) continue;
      perDay.set(d, perDay.get(d) + h);
      weekday[time.parse(d).getDay()] += h;
      for (let hr = 0; hr < 24; hr++) {
        const hs = `${d}T${String(hr).padStart(2, '0')}:00`;
        hourOfDay[hr] += overlapHours(b.start_at, b.end_at, hs, time.addMinutes(hs, 60));
      }
    }
  }
  const weekdayCount = Array(7).fill(0);
  for (const d of days) if (`${d}T00:00` < until) weekdayCount[time.parse(d).getDay()] += 1;

  // Requests made in the period, and what became of them.
  const requests = db.prepare(`SELECT b.id, b.status, b.created_at,
      (SELECT MIN(h.at) FROM booking_history h WHERE h.booking_id = b.id AND h.to_status IN ('approved', 'rejected')) AS decided_at,
      (SELECT h.note FROM booking_history h WHERE h.booking_id = b.id AND h.to_status = 'approved' ORDER BY h.id LIMIT 1) AS approve_note
    FROM bookings b WHERE b.vehicle_id = ? AND b.kind = 'booking' AND b.created_at >= ? AND b.created_at < ?
      AND b.created_by = b.user_id`).all(vehicleId, start.replace('T', ' '), end.replace('T', ' '));
  const decided = requests.filter((r) => r.decided_at);
  const answerHours = decided.map((r) => time.hoursBetween(local(r.created_at), local(r.decided_at)));
  const cancelled = rows.filter((b) => b.kind === 'booking' && b.status === 'cancelled').length;
  const rejected = requests.filter((r) => r.status === 'rejected').length;

  const top = new Map();
  for (const b of used) top.set(b.user_id, (top.get(b.user_id) || 0) + overlapHours(b.start_at, b.end_at, start, until));
  const names = top.size ? Object.fromEntries(db.prepare(`SELECT id, first_name || ' ' || last_name AS name FROM users WHERE id IN (${[...top.keys()].map(() => '?').join(',')})`)
    .all(...top.keys()).map((u) => [u.id, u.name])) : {};

  return {
    from, to, days: days.length, pastDays,
    bookings: used.length,
    bookedHours: round(bookedHours),
    utilizationPct: round((bookedHours / (pastDays * 24)) * 100),
    averageHours: used.length ? round(used.reduce((h, b) => h + time.hoursBetween(b.start_at, b.end_at), 0) / used.length) : 0,
    idleDays: days.filter((d) => `${d}T00:00` < until && !perDay.get(d)).length,
    aheadBookings: used.filter((b) => b.start_at >= now).length,
    weekday: weekday.map((h, i) => ({ day: time.HE_DAYS[i], avgHours: weekdayCount[i] ? round(h / weekdayCount[i]) : 0 })),
    hourOfDay: hourOfDay.map((h) => round(h)),
    requests: requests.length,
    autoApproved: requests.filter((r) => r.approve_note === 'אושרה אוטומטית').length,
    rejected,
    cancelled,
    stillWaiting: requests.filter((r) => r.status === 'pending').length,
    answerMedianHours: median(answerHours) == null ? null : round(median(answerHours)),
    answerMaxHours: answerHours.length ? round(Math.max(...answerHours)) : null,
    blockedHours: round(blocks.reduce((h, b) => h + overlapHours(b.start_at, b.end_at, start, end), 0)),
    topUsers: [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, h]) => ({ id, name: names[id] || `#${id}`, hours: round(h) })),
  };
}

module.exports = { usageReport };
