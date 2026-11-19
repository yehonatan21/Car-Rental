'use strict';
// The UI/UX report's changes (docs/UX_REPORT.md, U-1 to U-19).
const { db, createUser, inDays, startServer, Client } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const time = require('../../src/time');

let srv, admin, user, u;
before(async () => {
  srv = await startServer();
  createUser({ role: 'admin', email: 'ux-admin@ux.test' });
  u = createUser({ email: 'ux-user@ux.test' });
  admin = new Client(srv.base); await admin.login('ux-admin@ux.test');
  user = new Client(srv.base); await user.login('ux-user@ux.test');
});
after(() => srv.close());
const visitor = () => new Client(srv.base);

test('U-1, U-3: visitors\' links keep their words; sign-in has one e-mail field, a code button and a show-password button', async () => {
  const page = (await visitor().get('/login')).text;
  assert.match(page, /<nav class="nav-desktop"[^>]*>[\s\S]*<span>התחברות<\/span>[\s\S]*<span>הרשמה<\/span>[\s\S]*<span>נהלים<\/span>/);
  assert.equal((page.match(/name="email"/g) || []).length, 1, 'one e-mail field');
  assert.match(page, /<button class="btn btn-light btn-block" formaction="\/login\/code" formnovalidate>/);
  assert.match(page, /data-reveal="login-password"[^>]*aria-label="הצגת הסיסמה" hidden/);
});

test('U-4, U-17: managers see waiting requests on "הזמנות"; the dashboard lists them before the car alerts; rules moved to settings', async () => {
  const b = db.prepare("INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status, kind) VALUES (1, ?, ?, ?, 'pending', 'booking')")
    .run(u.id, inDays(3), inDays(3, '12:00')).lastInsertRowid;
  db.prepare("UPDATE vehicles SET next_service = ? WHERE id = 1").run(time.addDays(time.today(), 3));
  const page = (await admin.get('/admin')).text;
  assert.match(page, /href="\/admin\/bookings"[^>]*>[\s\S]*?<span class="nav-badge" aria-label="1 ממתינות לאישור">1<\/span>/);
  assert.ok(page.indexOf('בקשות הזמנה ממתינות') < page.indexOf('התראות רכב'), 'waiting requests first');
  assert.doesNotMatch(page, /<a href="\/admin\/policies"/, 'not in the menu');
  const settings = (await admin.get('/admin/settings?tab=policies')).text;
  assert.match(settings, /data-tab="policies"[^>]*aria-selected="true"/);
  assert.match(settings, /פרסום גרסה חדשה/);
  assert.equal((await admin.post('/admin/policies', { content: '# נהלים\n\n- כלל' }, '/admin/settings?tab=policies')).location, '/admin/settings?tab=policies');
  db.prepare('DELETE FROM bookings WHERE id = ?').run(b);
});

test('U-5, U-12: list filters in a folding box; action columns and the rules page have names and headings', async () => {
  const list = (await admin.get('/admin/bookings?status=pending')).text;
  assert.match(list, /<details class="filter-box" open data-active>[\s\S]*סינון וחיפוש <span class="nav-badge">1<\/span>/);
  const users = (await admin.get('/admin/users')).text;
  assert.match(users, /<details class="filter-box" open >/);
  assert.match(users, /<th><span class="sr-only">פעולות<\/span><\/th>/);
  assert.match((await visitor().get('/policy')).text, /<h1>/);
});

test('U-6, U-14: the month view lists the chosen day; a phone opens the calendar on the day view', async () => {
  const day = time.addDays(time.today(), 2);
  const b = db.prepare("INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status, kind, purpose) VALUES (1, ?, ?, ?, 'approved', 'booking', 'יום')")
    .run(u.id, `${day}T10:00`, `${day}T12:00`).lastInsertRowid;
  const month = (await admin.get(`/calendar?view=month&date=${day}`)).text;
  assert.match(month, /<section class="day-list" id="day-list"[\s\S]*10:00–12:00/);
  assert.match(month, /class="m-cell[^"]*sel[^"]*"/);
  user.cookies.narrow = '1';
  assert.match((await user.get('/calendar')).text, /class="active"[^>]*>יום<|href="\?view=day[^"]*" class="active"/);
  delete user.cookies.narrow;
  assert.match((await user.get('/calendar')).text, /href="\?view=week[^"]*" class="active"/);
  db.prepare('DELETE FROM bookings WHERE id = ?').run(b);
});

test('U-2, U-9: duration buttons on booking forms; the personal area starts with the next booking', async () => {
  assert.match((await user.get('/bookings/new')).text, /data-times data-availability[\s\S]*|class="duration-chips"[\s\S]*data-dur="120">שעתיים/);
  assert.match((await user.get('/bookings/new')).text, /data-dur="1440">יום שלם/);
  assert.match((await admin.get('/admin/bookings/new')).text, /class="duration-chips"/);
  const b = db.prepare("INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status, kind) VALUES (1, ?, ?, ?, 'pending', 'booking')")
    .run(u.id, inDays(4, '08:00'), inDays(4, '10:00')).lastInsertRowid;
  const me = (await user.get('/me')).text;
  assert.match(me, /ההזמנה הבאה שלך[\s\S]*08:00 – 10:00[\s\S]*ביטול ההזמנה/);
  assert.ok(me.indexOf('ההזמנה הבאה שלך') < me.indexOf('פעולות מהירות'));
  db.prepare('DELETE FROM bookings WHERE id = ?').run(b);
});

test('U-10: the user card\'s actions are one form: the expected one first, the others sharing one note', async () => {
  const p = createUser({ email: 'ux-pending@ux.test', status: 'pending' });
  const card = (await admin.get(`/admin/users/${p.id}`)).text;
  assert.match(card, /<form method="post" action="\/admin\/users\/\d+\/approve" class="user-actions">[\s\S]*אישור המשתמש והרישיון[\s\S]*name="note"[\s\S]*formaction="\/admin\/users\/\d+\/reject" formnovalidate/);
  await admin.post(`/admin/users/${p.id}/reject`, { note: 'חסר רישיון' }, `/admin/users/${p.id}`);
  assert.equal(db.prepare('SELECT status FROM users WHERE id = ?').get(p.id).status, 'rejected');
});
