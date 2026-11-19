'use strict';
// node scripts/utilization.js [--days 30 | --from --to]
// How much the car is used: per day, per weekday, busiest hours, idle days, and requests that compete for a time.
const { all, run, range, overlapHours, round, time } = require('./lib/db');

run((a) => {
  const r = range(a);
  const rows = all(`SELECT kind, status, start_at, end_at FROM bookings
    WHERE status IN ('approved','completed') AND start_at < ? AND end_at > ?`, r.end, r.start);
  const days = [];
  for (let d = r.from; d <= r.to; d = time.addDays(d, 1)) days.push(d);
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0)); // [weekday][hour] = booked hours
  const perDay = days.map((d) => {
    const s = `${d}T00:00`; const e = `${time.addDays(d, 1)}T00:00`;
    let booked = 0; let blocked = 0;
    for (const b of rows) {
      const h = overlapHours(b.start_at, b.end_at, s, e);
      if (b.kind === 'block') blocked += h; else booked += h;
      if (b.kind === 'booking' && h) {
        for (let hr = 0; hr < 24; hr++) {
          const hs = `${d}T${String(hr).padStart(2, '0')}:00`;
          heat[time.parse(d).getDay()][hr] += overlapHours(b.start_at, b.end_at, hs, time.addMinutes(hs, 60));
        }
      }
    }
    return { date: d, booked_hours: round(booked), blocked_hours: round(blocked) };
  });
  const totalBooked = perDay.reduce((h, d) => h + d.booked_hours, 0);
  const byWeekday = time.HE_DAYS.map((name, i) => {
    const ds = perDay.filter((d) => time.parse(d.date).getDay() === i);
    return { day: name, avg_booked_hours: ds.length ? round(ds.reduce((h, d) => h + d.booked_hours, 0) / ds.length) : 0 };
  });
  const peaks = [];
  heat.forEach((hours, wd) => hours.forEach((h, hr) => { if (h) peaks.push({ day: time.HE_DAYS[wd], hour: `${String(hr).padStart(2, '0')}:00`, booked_hours: round(h) }); }));
  peaks.sort((x, y) => y.booked_hours - x.booked_hours);
  const competing = all(`SELECT a.id AS a, b.id AS b FROM bookings a JOIN bookings b ON a.id < b.id AND a.vehicle_id = b.vehicle_id
    AND a.start_at < b.end_at AND b.start_at < a.end_at
    WHERE a.kind = 'booking' AND b.kind = 'booking' AND a.status = 'pending' AND b.status = 'pending' AND a.end_at > ? AND a.start_at < ?`, r.start, r.end);
  return {
    period: { from: time.fmt(r.from), to: time.fmt(r.to), days: days.length },
    utilization_pct: round((totalBooked / (days.length * 24)) * 100),
    booked_hours: round(totalBooked),
    idle_days: perDay.filter((d) => !d.booked_hours).length,
    busiest_days: [...perDay].sort((x, y) => y.booked_hours - x.booked_hours).slice(0, 5).filter((d) => d.booked_hours).map((d) => ({ ...d, date: time.fmt(d.date) })),
    by_weekday: byWeekday,
    peak_hours: peaks.slice(0, 10),
    competing_pending_requests: competing.length,
    per_day: perDay.map((d) => ({ ...d, date: time.fmt(d.date) })),
  };
});
