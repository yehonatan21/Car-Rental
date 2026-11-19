'use strict';
// node scripts/bookings.js [--days 30 | --from YYYY-MM-DD --to YYYY-MM-DD] [--status pending|approved|completed|rejected|cancelled]
// Bookings in a period, with totals by status, by person, by weekday and by pickup hour.
const { all, run, range, overlapHours, round, time } = require('./lib/db');

const STATUSES = ['pending', 'approved', 'completed', 'rejected', 'cancelled'];

run((a) => {
  const r = range(a);
  if (a.status && !STATUSES.includes(a.status)) throw new Error(`--status must be one of ${STATUSES.join(', ')}`);
  const rows = all(`SELECT b.id, b.kind, b.status, b.start_at, b.end_at, b.purpose, b.block_reason, b.created_at,
      u.first_name || ' ' || u.last_name AS user_name
    FROM bookings b LEFT JOIN users u ON u.id = b.user_id
    WHERE b.start_at < ? AND b.end_at > ? ${a.status ? 'AND b.status = ?' : ''} ORDER BY b.start_at`,
  ...[r.end, r.start, ...(a.status ? [a.status] : [])]);
  const bookings = rows.filter((b) => b.kind === 'booking');
  const count = (list, key) => Object.entries(list.reduce((m, b) => { const k = key(b); m[k] = (m[k] || 0) + 1; return m; }, {})).sort((x, y) => y[1] - x[1]);
  const used = bookings.filter((b) => ['approved', 'completed'].includes(b.status));
  return {
    period: { from: time.fmt(r.from), to: time.fmt(r.to) },
    totals: { bookings: bookings.length, blocks: rows.length - bookings.length, by_status: Object.fromEntries(count(bookings, (b) => b.status)) },
    booked_hours: round(used.reduce((h, b) => h + overlapHours(b.start_at, b.end_at, r.start, r.end), 0)),
    average_hours: used.length ? round(used.reduce((h, b) => h + time.hoursBetween(b.start_at, b.end_at), 0) / used.length) : 0,
    top_users: count(used, (b) => b.user_name).slice(0, 10).map(([user, n]) => ({ user, bookings: n })),
    by_weekday: Object.fromEntries(time.HE_DAYS.map((d, i) => [d, used.filter((b) => time.parse(b.start_at).getDay() === i).length])),
    by_pickup_hour: Object.fromEntries(count(used, (b) => b.start_at.slice(11, 13) + ':00').sort()),
    rejected_or_cancelled: bookings.filter((b) => ['rejected', 'cancelled'].includes(b.status)).length,
    items: rows.slice(0, 200).map((b) => ({ id: b.id, kind: b.kind, status: b.status, who: b.kind === 'block' ? b.block_reason : b.user_name,
      from: time.fmt(b.start_at), to: time.fmt(b.end_at), hours: round(time.hoursBetween(b.start_at, b.end_at)), purpose: b.purpose || undefined })),
    truncated: rows.length > 200 || undefined,
  };
});
