'use strict';
// End-to-end tests against a real server on a throwaway database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'car-booking-test-'));

const { app } = require('../src/server');
const { db, setSetting } = require('../src/db');
const auth = require('../src/auth');
const time = require('../src/time');
const { validIsraeliId } = require('../src/routes/public');

let server, base;

class Client {
  constructor() { this.cookies = {}; }
  async req(method, url, body) {
    const headers = { cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ') };
    let payload = body;
    if (body && !(body instanceof FormData)) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(body).toString();
    }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (v === '' || /Expires=Thu, 01 Jan 1970/.test(c)) delete this.cookies[k]; else this.cookies[k] = v;
    }
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
  }
  get(url) { return this.req('GET', url); }
  async csrf(url = '/me') {
    const page = await this.get(url);
    const m = page.text.match(/name="_csrf" value="([^"]+)"/);
    return m && m[1];
  }
  async post(url, body = {}, from) {
    if (body instanceof FormData) return this.req('POST', url, body);
    const token = await this.csrf(from);
    return this.req('POST', url, token ? { ...body, _csrf: token } : body);
  }
  async flash() {
    const f = this.cookies.flash;
    return f ? JSON.parse(Buffer.from(decodeURIComponent(f), 'base64url').toString()) : null;
  }
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const inDays = (d, hh = '10:00') => `${time.addDays(time.today(), d)}T${hh}`;

async function register(client, { email, id, expiry = time.addDays(time.today(), 365) }) {
  const fd = new FormData();
  fd.set('first_name', 'ישראל'); fd.set('last_name', 'ישראלי'); fd.set('id_number', id);
  fd.set('phone', '050-1234567'); fd.set('email', email); fd.set('password', 'Password1');
  fd.set('license_expiry', expiry); fd.set('accept_policy', '1'); fd.set('accept_privacy', '1'); fd.set('policy_version', '1');
  fd.set('license', new Blob([PNG], { type: 'image/png' }), 'license.png');
  return client.req('POST', '/register', fd);
}

const admin = new Client();
const alice = new Client();
const bob = new Client();
let aliceId, bobId;

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  db.prepare(`INSERT INTO users (first_name, last_name, id_number, phone, email, password_hash, role, status)
    VALUES ('מנהלת', 'ראשית', '000000018', '0500000000', 'admin@test.org', ?, 'admin', 'active')`).run(auth.hashPassword('AdminPass1'));
  const r = await admin.post('/login', { email: 'admin@test.org', password: 'AdminPass1' }, '/login');
  assert.equal(r.location, '/admin');
});

after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('Israeli ID validation', () => {
  assert.ok(validIsraeliId('000000018'));
  assert.ok(!validIsraeliId('123456789'));
  assert.ok(validIsraeliId('123456782'));
});

test('TOTP matches RFC 6238 reference vector', () => {
  // RFC 6238 SHA-1 secret "12345678901234567890" at T=59s → 94287082 (last 6 digits: 287082)
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(auth.totpAt(secret, 1), '287082');
  assert.ok(auth.verifyTotp(secret, '287082', 59000));
});

test('registration creates a pending user who cannot book', async () => {
  const r = await register(alice, { email: 'alice@test.org', id: '123456782' });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/me');
  const u = db.prepare("SELECT * FROM users WHERE email = 'alice@test.org'").get();
  aliceId = u.id;
  assert.equal(u.status, 'pending');
  assert.equal(u.phone, '0501234567');
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'licenses', u.license_file)));
  const acc = db.prepare('SELECT * FROM policy_acceptances WHERE user_id = ?').get(u.id);
  assert.equal(acc.policy_version, 1);
  assert.ok(acc.accepted_at);

  const page = await alice.get('/bookings/new');
  assert.equal(page.status, 302); // redirected away, not allowed yet
  const outbox = fs.readdirSync(path.join(process.env.DATA_DIR, 'outbox'));
  assert.ok(outbox.length >= 1, 'admin notified by e-mail');
});

test('registration rejects bad data and duplicates', async () => {
  const c = new Client();
  const r = await register(c, { email: 'alice@test.org', id: '123456782' });
  assert.equal(r.status, 400);
  assert.match(r.text, /קיים כבר משתמש/);
  const r2 = await register(c, { email: 'x@test.org', id: '123456789' });
  assert.match(r2.text, /תעודת הזהות אינו תקין/);
});

test('license images are private to admins', async () => {
  assert.equal((await alice.get(`/admin/users/${aliceId}/license`)).status, 403);
  assert.equal((await new Client().get(`/admin/users/${aliceId}/license`)).status, 302);
  const r = await admin.get(`/admin/users/${aliceId}/license`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.equal((await new Client().get('/static/../data/licenses')).status, 404);
});

test('POST without CSRF token is rejected', async () => {
  const r = await admin.req('POST', `/admin/users/${aliceId}/approve`, { license_expiry: time.addDays(time.today(), 365) });
  assert.equal(r.status, 403);
});

test('admin approves user; user can then book', async () => {
  const r = await admin.post(`/admin/users/${aliceId}/approve`, { license_expiry: time.addDays(time.today(), 365) }, `/admin/users/${aliceId}`);
  assert.equal(r.status, 302);
  assert.equal(db.prepare('SELECT status FROM users WHERE id = ?').get(aliceId).status, 'active');
  assert.equal((await alice.get('/bookings/new')).status, 200);
});

let aliceBooking;
test('booking request is pending and shows the required message', async () => {
  const r = await alice.post('/bookings/new', { start: inDays(3, '09:00'), end: inDays(3, '13:00'), purpose: 'קניות', accept_rules: '1' }, '/bookings/new');
  assert.equal(r.status, 200);
  assert.match(r.text, /בקשת ההזמנה התקבלה וממתינה לאישור המנהל. ההזמנה אינה סופית עד לקבלת אישור./);
  aliceBooking = db.prepare('SELECT * FROM bookings WHERE user_id = ?').get(aliceId);
  assert.equal(aliceBooking.status, 'pending');
});

test('pending requests do not block others; admin chooses; overlap is prevented at approval', async () => {
  await register(bob, { email: 'bob@test.org', id: '000000026' });
  bobId = db.prepare("SELECT id FROM users WHERE email = 'bob@test.org'").get().id;
  await admin.post(`/admin/users/${bobId}/approve`, { license_expiry: time.addDays(time.today(), 365) }, `/admin/users/${bobId}`);
  const r = await bob.post('/bookings/new', { start: inDays(3, '12:00'), end: inDays(3, '15:00'), accept_rules: '1' }, '/bookings/new');
  assert.equal(r.status, 200, 'pending request does not block the slot');
  const bobBooking = db.prepare('SELECT * FROM bookings WHERE user_id = ?').get(bobId);

  const page = await admin.get(`/admin/bookings/${bobBooking.id}`);
  assert.match(page.text, /בקשות ממתינות נוספות/);

  await admin.post(`/admin/bookings/${bobBooking.id}/approve`, {}, `/admin/bookings/${bobBooking.id}`);
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(bobBooking.id).status, 'approved');

  await admin.post(`/admin/bookings/${aliceBooking.id}/approve`, {}, `/admin/bookings/${aliceBooking.id}`);
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(aliceBooking.id).status, 'pending');
  assert.match((await admin.flash()).text, /הרכב תפוס/);

  const again = await alice.post('/bookings/new', { start: inDays(3, '14:00'), end: inDays(3, '16:00'), accept_rules: '1' }, '/bookings/new');
  assert.equal(again.status, 400, 'approved slot now blocks new requests');
});

test('turnaround buffer is enforced', async () => {
  setSetting('buffer_minutes', 30);
  const r = await alice.post('/bookings/new', { start: inDays(3, '15:15'), end: inDays(3, '17:00'), accept_rules: '1' }, '/bookings/new');
  assert.equal(r.status, 400);
  const ok = await alice.post('/bookings/new', { start: inDays(3, '15:30'), end: inDays(3, '17:00'), accept_rules: '1' }, '/bookings/new');
  assert.equal(ok.status, 200);
  setSetting('buffer_minutes', 0);
});

test('users see "busy" but not who booked; admin sees names', async () => {
  const date = time.addDays(time.today(), 3);
  const userCal = await alice.get(`/calendar?view=day&date=${date}`);
  assert.match(userCal.text, /תפוס/);
  assert.doesNotMatch(userCal.text, /bob@test.org|ישראלי \(|ישראל ישראלי/);
  const adminCal = await admin.get(`/calendar?view=day&date=${date}`);
  assert.match(adminCal.text, /ישראל ישראלי/);
});

test('users cannot see or cancel other users\' bookings', async () => {
  const bobBooking = db.prepare('SELECT * FROM bookings WHERE user_id = ?').get(bobId);
  await alice.post(`/me/bookings/${bobBooking.id}/cancel`, {}, '/me/bookings');
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(bobBooking.id).status, 'approved');
  assert.equal((await alice.get(`/admin/bookings/${bobBooking.id}`)).status, 403);
});

test('late cancellation of an approved booking is reserved for the admin', async () => {
  const id = Number(db.prepare(`INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status) VALUES (1, ?, ?, ?, 'approved')`)
    .run(aliceId, time.addMinutes(time.now(), 120), time.addMinutes(time.now(), 240)).lastInsertRowid);
  await alice.post(`/me/bookings/${id}/cancel`, {}, '/me/bookings');
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(id).status, 'approved');
  await admin.post(`/admin/bookings/${id}/cancel`, { note: 'בקשת המשתמשת' }, `/admin/bookings/${id}`);
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(id).status, 'cancelled');
  const hist = db.prepare('SELECT * FROM booking_history WHERE booking_id = ? ORDER BY id DESC').get(id);
  assert.equal(hist.to_status, 'cancelled');
  assert.ok(hist.actor_id);
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
});

test('policy re-acceptance is required after a material change', async () => {
  await admin.post('/admin/policies', { content: '# נהלים חדשים', requires_reaccept: '1' }, '/admin/policies');
  const r = await alice.get('/bookings/new');
  assert.equal(r.status, 302);
  assert.match(r.location, /policy\/accept/);
  await alice.post('/policy/accept', { version: '2', agree: '1' }, '/policy/accept');
  assert.equal((await alice.get('/bookings/new')).status, 200);
});

test('blocked users are logged out and cannot book', async () => {
  await admin.post(`/admin/users/${bobId}/block`, {}, `/admin/users/${bobId}`);
  assert.equal(db.prepare('SELECT status FROM users WHERE id = ?').get(bobId).status, 'blocked');
  const r = await bob.get('/bookings/new');
  assert.equal(r.status, 302);
  assert.match(r.location, /login/);
});

test('one-time e-mail code login', async () => {
  const c = new Client();
  await c.post('/login/code', { email: 'alice@test.org' }, '/login');
  const code = auth.createLoginCode(aliceId); // replaces the mailed one; reading the mail is out of scope here
  const r = await c.post('/login/code/verify', { email: 'alice@test.org', code }, '/login');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/calendar');
});

test('every page renders for admin', async () => {
  for (const url of ['/admin', '/admin/users', '/admin/bookings', '/admin/bookings?status=pending&q=ישראל', '/admin/vehicle',
    '/admin/policies', '/admin/settings', '/admin/audit', '/calendar?view=month', '/calendar?view=week', '/me', '/me/security',
    '/admin/bookings/new', '/admin/blocks/new', `/admin/users/${aliceId}`]) {
    const r = await admin.get(url);
    assert.equal(r.status, 200, url);
  }
});

test('jobs complete finished bookings and flag expired licenses', async () => {
  const { runJobs } = require('../src/jobs');
  const id = Number(db.prepare(`INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status) VALUES (1, ?, ?, ?, 'approved')`)
    .run(aliceId, inDays(-2), inDays(-1)).lastInsertRowid);
  db.prepare('UPDATE users SET license_expiry = ? WHERE id = ?').run(time.addDays(time.today(), -1), aliceId);
  await runJobs();
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(id).status, 'completed');
  assert.equal(db.prepare('SELECT status FROM users WHERE id = ?').get(aliceId).status, 'license_update');
});
