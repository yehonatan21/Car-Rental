'use strict';
// Main user journey: register → admin approval → booking request → admin decision → cancellation.
const { db, createUser, getUser, getBooking, inDays, startServer, Client, registrationForm, outbox, storedFile, storedFileCount } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setSetting } = require('../../src/db');
const time = require('../../src/time');

let srv, admin, alice, bob, aliceId, bobId, aliceBooking;
const client = () => new Client(srv.base);

before(async () => {
  srv = await startServer();
  createUser({ role: 'admin', email: 'admin@test.org' });
  admin = client();
  alice = client();
  bob = client();
  const r = await admin.login('admin@test.org');
  assert.equal(r.location, '/admin');
});
after(() => srv.close());

test('registration creates a pending user who cannot book yet', async () => {
  const r = await alice.post('/register', registrationForm({ email: 'alice@test.org', id_number: '123456782' }));
  assert.equal(r.status, 302);
  assert.equal(r.location, '/me');
  const u = db.prepare("SELECT * FROM users WHERE email = 'alice@test.org'").get();
  aliceId = u.id;
  assert.equal(u.status, 'pending');
  assert.equal(u.phone, '0501234567', 'phone normalized');
  assert.ok(storedFile(u.license_file), 'license stored privately');
  const acc = db.prepare('SELECT * FROM policy_acceptances WHERE user_id = ?').get(u.id);
  assert.equal(acc.policy_version, 1);
  assert.ok(acc.accepted_at, 'acceptance time recorded');
  assert.ok(u.privacy_accepted_at);

  assert.equal((await alice.get('/bookings/new')).status, 302, 'not allowed to book');
  assert.match((await alice.get('/me')).text, /ממתין לאישור/);
  assert.ok(outbox().some((m) => m.subject === 'משתמש חדש ממתין לאישור' && m.to.includes('admin@test.org')));
});

test('registration rejects invalid data and duplicates', async () => {
  const c = client();
  let r = await c.post('/register', registrationForm({ email: 'alice@test.org', id_number: '123456782' }));
  assert.equal(r.status, 400);
  assert.match(r.text, /קיים כבר משתמש/);
  r = await c.post('/register', registrationForm({ id_number: '123456789' }));
  assert.match(r.text, /תעודת הזהות אינו תקין/);
  r = await c.post('/register', registrationForm({ phone: '03-1234567' }));
  assert.match(r.text, /הטלפון הנייד אינו תקין/);
  r = await c.post('/register', registrationForm({ license_expiry: time.addDays(time.today(), -1) }));
  assert.match(r.text, /תאריך תוקף רישיון עתידי/);
  r = await c.post('/register', registrationForm({ accept_policy: null }));
  assert.match(r.text, /יש לאשר את נהלי השאלת הרכב/);
  r = await c.post('/register', registrationForm({ accept_privacy: null }));
  assert.match(r.text, /מדיניות הפרטיות/);
  r = await c.post('/register', registrationForm({ license: null }));
  assert.match(r.text, /יש להעלות צילום רישיון/);
  r = await c.post('/register', registrationForm({ password: 'short' }));
  assert.match(r.text, /לפחות 8 תווים/);
  assert.ok(r.text.includes('value="ישראל"'), 'form keeps entered values');
  // Failed attempts keep their upload in a draft (so it needn't be re-uploaded); abandoned drafts are cleaned up.
  db.prepare('UPDATE registration_drafts SET expires_at = ?').run(Date.now() - 1);
  await require('../../src/jobs').runJobs();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM registration_drafts').get().n, 0);
  assert.equal(storedFileCount(), 1, 'uploads from abandoned registrations are deleted');
});

test('admin approves the user, who can then book', async () => {
  await admin.post(`/admin/users/${aliceId}/approve`, { license_expiry: time.addDays(time.today(), 365) }, `/admin/users/${aliceId}`);
  const u = getUser(aliceId);
  assert.equal(u.status, 'active');
  assert.equal(u.license_verified, 1);
  assert.equal((await alice.get('/bookings/new')).status, 200);
  assert.ok(outbox().some((m) => m.subject === 'החשבון שלך אושר' && m.to.includes('alice@test.org')));
});

test('booking request is pending and shows the required message', async () => {
  const r = await alice.post('/bookings/new', { start: inDays(3, '09:00'), end: inDays(3, '13:00'), purpose: 'קניות', accept_rules: '1' }, '/bookings/new');
  assert.equal(r.status, 200);
  assert.match(r.text, /בקשת ההזמנה התקבלה וממתינה לאישור המנהל. ההזמנה אינה סופית עד לקבלת אישור./);
  aliceBooking = db.prepare('SELECT * FROM bookings WHERE user_id = ?').get(aliceId);
  assert.equal(aliceBooking.status, 'pending');
  assert.ok(outbox().some((m) => m.subject === 'בקשת הזמנה חדשה ממתינה לאישור'));
  assert.ok(!outbox().some((m) => m.subject === 'ההזמנה אושרה'), 'no final confirmation before approval');
});

test('booking form requires accepting the rules', async () => {
  const r = await alice.post('/bookings/new', { start: inDays(8), end: inDays(8, '12:00') }, '/bookings/new');
  assert.equal(r.status, 400);
  assert.match(r.text, /יש לאשר את נהלי השימוש/);
});

test('availability API reports busy/free without personal details', async () => {
  const free = JSON.parse((await alice.get(`/api/availability?start=${inDays(3, '09:00')}&end=${inDays(3, '10:00')}`)).text);
  assert.equal(free.ok, true, 'pending requests do not occupy the slot');
  const bad = JSON.parse((await alice.get('/api/availability?start=x&end=y')).text);
  assert.equal(bad.ok, false);
  assert.equal((await client().get('/api/availability')).status, 302, 'login required');
});

test('availability API warns about rule violations before the form is sent', async () => {
  const check = async (start, end) => JSON.parse((await alice.get(`/api/availability?start=${start}&end=${end}`)).text);
  let r = await check(inDays(1, '16:18'), time.addDays(time.today(), 366) + 'T16:00');
  assert.equal(r.ok, false);
  assert.match(r.message, /משך הזמנה מקסימלי הוא 7 ימים/, 'a year-long booking is flagged live');
  r = await check(inDays(-1, '10:00'), inDays(-1, '12:00'));
  assert.match(r.message, /כבר עבר/);
  r = await check(inDays(1, '12:00'), inDays(1, '10:00'));
  assert.match(r.message, /אחרי מועד האיסוף/);
  r = await check(inDays(1, '16:18'), inDays(1, '18:07'));
  assert.equal(r.ok, true, 'any minute is accepted');
});

test('date fields accept any minute (no 15-minute step)', async () => {
  const page = (await alice.get('/bookings/new')).text;
  assert.match(page, /type="datetime-local" name="start"/);
  assert.doesNotMatch(page, /step="900"/);
  assert.match(page, /משך הזמנה מקסימלי: 7 ימים \(168 שעות\)/);
  const r = await alice.post('/bookings/new', { start: inDays(25, '16:18'), end: inDays(25, '17:47'), accept_rules: '1' }, '/bookings/new');
  assert.equal(r.status, 200);
  db.prepare("DELETE FROM bookings WHERE start_at = ?").run(inDays(25, '16:18'));
});

test('competing requests: admin chooses one, overlap is refused at approval', async () => {
  await bob.post('/register', registrationForm({ email: 'bob@test.org' }));
  bobId = db.prepare("SELECT id FROM users WHERE email = 'bob@test.org'").get().id;
  await admin.post(`/admin/users/${bobId}/approve`, { license_expiry: time.addDays(time.today(), 365) }, `/admin/users/${bobId}`);
  const r = await bob.post('/bookings/new', { start: inDays(3, '12:00'), end: inDays(3, '15:00'), accept_rules: '1' }, '/bookings/new');
  assert.equal(r.status, 200, 'pending request does not block the slot');
  const bobBooking = db.prepare('SELECT * FROM bookings WHERE user_id = ?').get(bobId);

  assert.match((await admin.get(`/admin/bookings/${bobBooking.id}`)).text, /בקשות ממתינות נוספות/);

  await admin.post(`/admin/bookings/${bobBooking.id}/approve`, {}, `/admin/bookings/${bobBooking.id}`);
  assert.equal(getBooking(bobBooking.id).status, 'approved');
  assert.match(admin.flash().text, /בקשות ממתינות נוספות לאותו מועד/);
  assert.ok(outbox().some((m) => m.subject === 'ההזמנה אושרה' && m.to.includes('bob@test.org')));

  await admin.post(`/admin/bookings/${aliceBooking.id}/approve`, {}, `/admin/bookings/${aliceBooking.id}`);
  assert.equal(getBooking(aliceBooking.id).status, 'pending');
  assert.match(admin.flash().text, /הרכב תפוס/);

  await admin.post(`/admin/bookings/${aliceBooking.id}/reject`, { note: 'הרכב תפוס' }, `/admin/bookings/${aliceBooking.id}`);
  assert.equal(getBooking(aliceBooking.id).status, 'rejected');
  assert.ok(outbox().some((m) => m.subject === 'בקשת ההזמנה לא אושרה' && m.to.includes('alice@test.org')));

  const again = await alice.post('/bookings/new', { start: inDays(3, '14:00'), end: inDays(3, '16:00'), accept_rules: '1' }, '/bookings/new');
  assert.equal(again.status, 400, 'approved slot now blocks new requests');
});

test('turnaround buffer is enforced through the form', async () => {
  setSetting('buffer_minutes', 30);
  let r = await alice.post('/bookings/new', { start: inDays(3, '15:15'), end: inDays(3, '17:00'), accept_rules: '1' }, '/bookings/new');
  assert.equal(r.status, 400);
  r = await alice.post('/bookings/new', { start: inDays(3, '15:30'), end: inDays(3, '17:00'), accept_rules: '1' }, '/bookings/new');
  assert.equal(r.status, 200);
  setSetting('buffer_minutes', 0);
});

test('privacy: users see "busy" but not who booked; admin sees names', async () => {
  const date = time.addDays(time.today(), 3);
  for (const view of ['day', 'week', 'month']) {
    const page = await alice.get(`/calendar?view=${view}&date=${date}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /תפוס/);
    assert.doesNotMatch(page.text, /bob@test.org|ישראל ישראלי/, view);
    assert.doesNotMatch(page.text, /admin\/bookings\//, 'no links to other bookings');
  }
  assert.match((await admin.get(`/calendar?view=day&date=${date}`)).text, /ישראל ישראלי/);
});

test('users cannot see or cancel other users\' bookings', async () => {
  const bobBooking = db.prepare('SELECT * FROM bookings WHERE user_id = ?').get(bobId);
  await alice.post(`/me/bookings/${bobBooking.id}/cancel`, {}, '/me/bookings');
  assert.equal(getBooking(bobBooking.id).status, 'approved');
  assert.match(alice.flash().text, /לא נמצאה/);
  assert.equal((await alice.get(`/admin/bookings/${bobBooking.id}`)).status, 403);
  assert.doesNotMatch((await alice.get('/me/bookings')).text, /bob/);
});

test('late cancellation of an approved booking is reserved for the admin', async () => {
  const id = Number(db.prepare(`INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status) VALUES (1, ?, ?, ?, 'approved')`)
    .run(aliceId, time.addMinutes(time.now(), 120), time.addMinutes(time.now(), 240)).lastInsertRowid);
  assert.match((await alice.get('/me/bookings')).text, /ביטול דרך המנהל בלבד/);
  await alice.post(`/me/bookings/${id}/cancel`, {}, '/me/bookings');
  assert.equal(getBooking(id).status, 'approved');
  await admin.post(`/admin/bookings/${id}/cancel`, { note: 'בקשת המשתמשת' }, `/admin/bookings/${id}`);
  assert.equal(getBooking(id).status, 'cancelled');
  const hist = db.prepare('SELECT * FROM booking_history WHERE booking_id = ? ORDER BY id DESC').get(id);
  assert.equal(hist.to_status, 'cancelled');
  assert.ok(hist.actor_id);
  const cancelMails = outbox().filter((m) => m.subject === 'הזמנה בוטלה');
  assert.ok(cancelMails.some((m) => m.to.includes('alice@test.org')) && cancelMails.some((m) => m.to.includes('admin@test.org')), 'user and admin notified');
});

test('user can cancel their own pending request', async () => {
  const pending = db.prepare("SELECT * FROM bookings WHERE user_id = ? AND status = 'pending'").get(aliceId);
  await alice.post(`/me/bookings/${pending.id}/cancel`, {}, '/me/bookings');
  assert.equal(getBooking(pending.id).status, 'cancelled');
});

test('license must be valid for the whole booking period', async () => {
  db.prepare('UPDATE users SET license_expiry = ? WHERE id = ?').run(time.addDays(time.today(), 5), aliceId);
  const r = await alice.post('/bookings/new', { start: inDays(6), end: inDays(7), accept_rules: '1' }, '/bookings/new');
  assert.equal(r.status, 400);
  assert.match(r.text, /אינו בתוקף לכל תקופת ההזמנה/);
  db.prepare('UPDATE users SET license_expiry = ? WHERE id = ?').run(time.addDays(time.today(), 365), aliceId);
});

test('maintenance block occupies the calendar', async () => {
  await admin.post('/admin/blocks/new', { start: inDays(10, '08:00'), end: inDays(10, '18:00'), reason: 'טיפול' }, '/admin/blocks/new');
  const r = await alice.post('/bookings/new', { start: inDays(10, '09:00'), end: inDays(10, '10:00'), accept_rules: '1' }, '/bookings/new');
  assert.equal(r.status, 400);
  assert.match(r.text, /חסימת תחזוקה/);
  assert.match((await alice.get(`/calendar?view=day&date=${time.addDays(time.today(), 10)}`)).text, /לא זמין/);
});

test('policy re-acceptance is required after a material change', async () => {
  await admin.post('/admin/policies', { content: '# נהלים חדשים', requires_reaccept: '1' }, '/admin/policies');
  const r = await alice.get('/bookings/new');
  assert.equal(r.status, 302);
  assert.match(r.location, /policy\/accept/);
  assert.match((await alice.get('/me')).text, /נהלי השאלת הרכב עודכנו/);
  await alice.post('/policy/accept', { version: '2', agree: '1', next: '/bookings/new' }, '/policy/accept');
  assert.equal((await alice.get('/bookings/new')).status, 200);
  assert.equal(db.prepare('SELECT MAX(policy_version) AS v FROM policy_acceptances WHERE user_id = ?').get(aliceId).v, 2);
});

test('a minor policy change does not require re-acceptance', async () => {
  await admin.post('/admin/policies', { content: '# נהלים – תיקון ניסוח' }, '/admin/policies');
  assert.equal((await alice.get('/bookings/new')).status, 200);
});

test('blocked users are logged out and cannot book', async () => {
  await admin.post(`/admin/users/${bobId}/block`, { note: 'הפרת נהלים' }, `/admin/users/${bobId}`);
  assert.equal(getUser(bobId).status, 'blocked');
  assert.match(admin.flash().text, /הזמנות פתוחות/, 'admin warned about open bookings');
  const r = await bob.get('/bookings/new');
  assert.equal(r.status, 302);
  assert.match(r.location, /login/);
});

test('every main page renders for admin and user', async () => {
  for (const url of ['/admin', '/admin/users', '/admin/users?status=pending&q=ישראל', '/admin/bookings',
    '/admin/bookings?status=pending&q=ישראל&kind=booking&from=2020-01-01&to=2099-01-01', '/admin/vehicle',
    '/admin/policies', '/admin/settings', '/admin/audit', '/calendar?view=month', '/calendar?view=week', '/me', '/me/security',
    '/admin/bookings/new', `/admin/bookings/new?start=${inDays(1)}`, '/admin/blocks/new', `/admin/users/${aliceId}`]) {
    assert.equal((await admin.get(url)).status, 200, url);
  }
  for (const url of ['/me', '/me/bookings', '/me/license', '/me/security', '/calendar', '/policy', '/policy/accept', '/privacy']) {
    assert.equal((await alice.get(url)).status, 200, url);
  }
});
