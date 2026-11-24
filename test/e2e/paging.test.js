'use strict';
// Long lists stay small: the users and bookings lists come 50 to a page, the dashboard shows the first 10 of each
// list with a link to the rest, the calendar renders a booking window only for pending requests, and versioned
// static files are cached for a year.
const { db, createUser, inDays, startServer, Client } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const time = require('../../src/time');

let srv, admin, owner;
before(async () => {
  srv = await startServer();
  createUser({ role: 'admin', email: 'admin@page.test' });
  owner = createUser({ email: 'owner@page.test' });
  admin = new Client(srv.base);
  await admin.login('admin@page.test');
});
after(() => srv.close());

const addBooking = (status, day, hour = 8) => db.prepare(`INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status, purpose, kind)
  VALUES (1, ?, ?, ?, ?, 'דפדוף', 'booking')`).run(owner.id, inDays(day, `${String(hour).padStart(2, '0')}:00`),
  inDays(day, `${String(hour).padStart(2, '0')}:30`), status).lastInsertRowid;

test('users list: 50 per page, with a pager that keeps the filters', async () => {
  for (let i = 0; i < 55; i++) createUser({ email: `many${i}@page.test`, last_name: 'רבים' });
  const first = await admin.get('/admin/users?q=' + encodeURIComponent('רבים'));
  assert.equal(first.status, 200);
  assert.equal((first.text.match(/href="\/admin\/users\/\d+"/g) || []).length >= 50, true);
  assert.match(first.text, /class="pager"/);
  assert.match(first.text, /עמוד 1 מתוך 2 · 55 רשומות/);
  assert.match(first.text, /href="\?q=%D7%A8%D7%91%D7%99%D7%9D&amp;page=2" rel="next"/, 'the next link keeps the search');
  const second = await admin.get('/admin/users?q=' + encodeURIComponent('רבים') + '&page=2');
  assert.match(second.text, /עמוד 2 מתוך 2/);
  assert.match(second.text, /rel="prev"/);
  assert.doesNotMatch(second.text, /rel="next"/);
  const beyond = await admin.get('/admin/users?q=' + encodeURIComponent('רבים') + '&page=99');
  assert.match(beyond.text, /עמוד 2 מתוך 2/, 'a page past the end shows the last one');
});

test('bookings list: paged too; a short list has no pager', async () => {
  for (let i = 0; i < 52; i++) addBooking('approved', 40 + i);
  const all = await admin.get('/admin/bookings?q=' + encodeURIComponent('דפדוף'));
  assert.match(all.text, /עמוד 1 מתוך 2/);
  const few = await admin.get('/admin/bookings?q=nothing-matches-this');
  assert.doesNotMatch(few.text, /class="pager"/);
});

test('dashboard: the first 10 pending requests, with a link to all of them', async () => {
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(addBooking('pending', 200 + i));
  const page = await admin.get('/admin');
  assert.match(page.text, /href="\/admin\/bookings\?status=pending">לכל \d+ הבקשות הממתינות/);
  const shown = ids.filter((id) => page.text.includes(`/admin/bookings/${id}/approve`));
  assert.equal(shown.length, 10, "the first 10 rows, not all 12");
  db.prepare("DELETE FROM bookings WHERE status = 'pending' AND purpose = 'דפדוף'").run();
});

test('calendar: a booking window only for pending requests', async () => {
  const day = 3;
  const pending = addBooking('pending', day, 9);
  const approved = addBooking('approved', day, 12);
  const page = await admin.get(`/calendar?view=month&date=${time.addDays(time.today(), day)}`);
  assert.match(page.text, new RegExp(`<dialog class="ev-dialog" id="bk-${pending}"`));
  assert.doesNotMatch(page.text, new RegExp(`id="bk-${approved}"`));
  db.prepare('DELETE FROM bookings WHERE id IN (?, ?)').run(pending, approved);
});

test('static files: a year with ?v=, a week without', async () => {
  const versioned = await fetch(srv.base + '/static/style.css?v=abc');
  assert.equal(versioned.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const plain = await fetch(srv.base + '/static/style.css');
  assert.equal(plain.headers.get('cache-control'), 'public, max-age=604800');
});

test('calendar month: no window for a request hidden behind "+N"; the chosen day lists them all', async () => {
  const day = 5;
  const ids = [8, 9, 10, 11, 12].map((h) => addBooking('pending', day, h));
  const target = time.addDays(time.today(), day);
  const other = target.slice(8) === '01' ? `${target.slice(0, 8)}02` : `${target.slice(0, 8)}01`; // same month, another day
  const page = await admin.get(`/calendar?view=month&date=${other}`);
  const windows = ids.filter((id) => page.text.includes(`<dialog class="ev-dialog" id="bk-${id}"`));
  assert.deepEqual(windows, ids.slice(0, 3), 'the 3 shown in the day cell');
  assert.match(page.text, /class="more"[^>]*>\+2</);
  const chosen = await admin.get(`/calendar?view=month&date=${target}`);
  assert.match(chosen.text, /id="day-list"/);
  assert.equal(ids.filter((id) => chosen.text.includes(`<dialog class="ev-dialog" id="bk-${id}"`)).length, 5, 'the chosen day lists all 5, each with its window');
  const day1 = await admin.get(`/calendar?view=day&date=${time.addDays(time.today(), day)}`);
  assert.equal(ids.filter((id) => day1.text.includes(`id="bk-${id}"`)).length, 5, 'the day view shows all of them');
  db.prepare(`DELETE FROM bookings WHERE id IN (${ids.join(',')})`).run();
});

test('"my bookings": the history comes 50 to a page, newest first; the upcoming ones are on every page', async () => {
  const member = createUser({ email: 'history@page.test' });
  const c = new Client(srv.base);
  await c.login(member.email);
  const add = (status, day) => db.prepare(`INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status, purpose, kind)
    VALUES (1, ?, ?, ?, ?, ?, 'booking')`).run(member.id, inDays(day), inDays(day, '12:00'), status, `day ${day}`);
  for (let d = -60; d < -5; d++) add(d % 7 ? 'completed' : 'cancelled', d); // 55 past ones
  add('approved', 3);
  add('pending', 4);
  add('cancelled', 5); // in the future but not open: history
  const history = (text) => text.split('id="history"')[1];
  const upcoming = (text) => text.split('id="history"')[0];

  const first = await c.get('/me/bookings');
  assert.equal((history(first.text).match(/<tr id="b-/g) || []).length, 50);
  assert.equal((upcoming(first.text).match(/<tr id="b-/g) || []).length, 2, 'the approved and the pending one');
  assert.match(first.text, /עמוד 1 מתוך 2 · 56 רשומות/);
  assert.match(history(first.text), /day 5</, 'newest first: the cancelled future booking leads the history');
  assert.match(first.text, /href="\?page=2" rel="next"/);

  const second = await c.get('/me/bookings?page=2');
  assert.equal((history(second.text).match(/<tr id="b-/g) || []).length, 6);
  assert.match(history(second.text), /day -60</, 'the oldest is on the last page');
  assert.equal((upcoming(second.text).match(/<tr id="b-/g) || []).length, 2, 'upcoming bookings stay on every page');
  assert.match(second.text, /rel="prev"/);

  // Someone else's bookings never count.
  const other = new Client(srv.base);
  await other.login('owner@page.test');
  assert.doesNotMatch((await other.get('/me/bookings')).text, /day -?\d+</);
});
