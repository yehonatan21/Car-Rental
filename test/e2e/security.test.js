'use strict';
// Access control, CSRF, XSS, upload restrictions and HTTP hardening.
const { db, createUser, startServer, Client, registrationForm, inDays, putStoredFile } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bookings = require('../../src/bookings');

let srv, admin, user, adminUser, plainUser;
const client = () => new Client(srv.base);

before(async () => {
  srv = await startServer();
  adminUser = createUser({ role: 'admin', email: 'admin@sec.test' });
  plainUser = createUser({ email: 'user@sec.test', license_file: 'secret.png' });
  putStoredFile('secret.png', 'PNGDATA');
  admin = client();
  user = client();
  await admin.login('admin@sec.test');
  await user.login('user@sec.test');
});
after(() => srv.close());

test('health endpoint', async () => {
  const r = await client().get('/healthz');
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.text).status, 'ok');
});

test('security headers are set', async () => {
  const r = await client().get('/login');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('session cookie is HttpOnly and SameSite', async () => {
  const res = await fetch(srv.base + '/login', {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=user%40sec.test&password=Password1',
  });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('sid='));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
});

test('anonymous users are redirected to login, keeping the target', async () => {
  for (const url of ['/me', '/calendar', '/bookings/new', '/admin', '/admin/users/1']) {
    const r = await client().get(url);
    assert.equal(r.status, 302, url);
    assert.equal(r.location, '/login?next=' + encodeURIComponent(url));
  }
});

test('regular users get 403 on every admin page and action', async () => {
  for (const url of ['/admin', '/admin/users', `/admin/users/${plainUser.id}`, `/admin/users/${plainUser.id}/license`,
    '/admin/bookings', '/admin/bookings/new', '/admin/blocks/new', '/admin/vehicle', '/admin/policies', '/admin/settings', '/admin/audit']) {
    assert.equal((await user.get(url)).status, 403, url);
  }
  for (const url of [`/admin/users/${plainUser.id}/approve`, `/admin/users/${plainUser.id}/make-admin`, '/admin/settings', '/admin/policies']) {
    assert.equal((await user.post(url, { license_expiry: '2099-01-01', content: 'x' })).status, 403, url);
  }
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(plainUser.id).role, 'user', 'cannot self-promote');
});

test('license files are only served to admins, never cached, and every view is logged', async () => {
  assert.equal((await user.get(`/admin/users/${plainUser.id}/license`)).status, 403);
  const r = await admin.get(`/admin/users/${plainUser.id}/license`);
  assert.equal(r.status, 200);
  assert.equal(r.text, 'PNGDATA');
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'license.view' AND target_id = ?").get(plainUser.id));
  assert.equal((await admin.get(`/admin/users/${plainUser.id}/license?pending=1`)).status, 404);
  for (const url of ['/static/../data/licenses/secret.png', '/licenses/secret.png', '/data/licenses/secret.png']) {
    assert.notEqual((await client().get(url)).text, 'PNGDATA', url);
  }
});

test('POST without a valid CSRF token is rejected', async () => {
  let r = await admin.req('POST', `/admin/users/${plainUser.id}/block`, {});
  assert.equal(r.status, 403);
  r = await admin.req('POST', `/admin/users/${plainUser.id}/block`, { _csrf: 'forged' });
  assert.equal(r.status, 403);
  assert.equal(db.prepare('SELECT status FROM users WHERE id = ?').get(plainUser.id).status, 'active');
});

test('cross-origin POSTs are rejected even with a token', async () => {
  const token = await admin.csrf('/admin');
  const r = await admin.req('POST', `/admin/users/${plainUser.id}/block`, { _csrf: token }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  const anon = await client().req('POST', '/login', { email: 'a', password: 'b' }, { origin: 'https://evil.example' });
  assert.equal(anon.status, 403);
});

test('CSRF tokens are per session', async () => {
  const userToken = await user.csrf('/me');
  const r = await admin.req('POST', '/admin/settings', { _csrf: userToken, buffer_minutes: '99' });
  assert.equal(r.status, 403);
});

test('stored XSS: user-supplied fields are escaped everywhere', async () => {
  const evil = '<script>alert(1)</script>';
  const c = client();
  await c.post('/register', registrationForm({ first_name: evil, last_name: '"><img src=x onerror=alert(2)>', email: 'xss@sec.test' }));
  db.prepare("UPDATE users SET status = 'active', license_verified = 1 WHERE email = 'xss@sec.test'").run();
  const u = db.prepare("SELECT * FROM users WHERE email = 'xss@sec.test'").get();
  bookings.createRequest(u, { vehicleId: 1, start: inDays(4), end: inDays(4, '12:00'), purpose: evil, notes: evil });
  for (const url of ['/admin', '/admin/users', `/admin/users/${u.id}`, '/admin/bookings', `/calendar?view=month&date=${inDays(4).slice(0, 10)}`]) {
    const page = (await admin.get(url)).text;
    assert.doesNotMatch(page, /<script>alert|<img src=x/, url);
  }
  assert.doesNotMatch((await c.get('/me')).text, /<script>alert/);
});

test('reflected XSS via query parameters is escaped', async () => {
  const r = await admin.get('/admin/users?q=%22%3E%3Cscript%3Ealert(1)%3C/script%3E');
  assert.doesNotMatch(r.text, /<script>alert/);
  const r2 = await client().get('/login?next=%22%3E%3Cscript%3Ealert(1)%3C/script%3E');
  assert.doesNotMatch(r2.text, /<script>alert/);
});

test('open redirects after login are blocked', async () => {
  for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)']) {
    const c = client();
    const r = await c.post('/login', { email: 'user@sec.test', password: 'Password1', next });
    assert.match(r.location, /^\/(?![/\\])/, `${next} → ${r.location}`);
  }
  const ok = await client().post('/login', { email: 'user@sec.test', password: 'Password1', next: '/me/bookings' });
  assert.equal(ok.location, '/me/bookings');
});

test('uploads: only images/PDF accepted, size limited', async () => {
  const c = client();
  let r = await c.post('/register', registrationForm({ licenseBlob: new Blob(['#!/bin/sh'], { type: 'text/x-shellscript' }), licenseName: 'x.sh' }));
  assert.equal(r.status, 400);
  assert.match(r.text, /יש להעלות צילום רישיון/);
  r = await c.post('/register', registrationForm({ licenseBlob: new Blob([Buffer.alloc(9 * 1024 * 1024)], { type: 'image/png' }) }));
  assert.equal(r.status, 302);
  assert.match(c.flash().text, /גדול מדי/);
  r = await c.post('/register', registrationForm({ licenseBlob: new Blob(['%PDF-1.4'], { type: 'application/pdf' }), licenseName: 'l.pdf', email: 'pdf@sec.test' }));
  assert.equal(r.status, 302);
  const file = db.prepare("SELECT license_file FROM users WHERE email = 'pdf@sec.test'").get().license_file;
  assert.match(file, /^[0-9a-f]{32}\.pdf$/, 'random server-side file name, never the client name');
});

test('wrong password and unknown e-mail give the same answer', async () => {
  const a = await client().post('/login', { email: 'user@sec.test', password: 'wrong-password' });
  const b = await client().post('/login', { email: 'nobody@sec.test', password: 'wrong-password' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.match(a.text, /דואר אלקטרוני או סיסמה שגויים/);
  assert.match(b.text, /דואר אלקטרוני או סיסמה שגויים/);
});

test('one-time code request does not reveal whether an e-mail is registered', async () => {
  const a = await client().post('/login/code', { email: 'user@sec.test' });
  const b = await client().post('/login/code', { email: 'nobody@sec.test' });
  assert.equal(a.status, b.status);
  assert.match(b.text, /רשומה במערכת, נשלח אליה קוד/);
  assert.match(a.text, /רשומה במערכת, נשלח אליה קוד/);
});

test('logout destroys the session server-side', async () => {
  const c = client();
  await c.login('user@sec.test');
  const sid = c.cookies.sid;
  await c.post('/logout', {}, '/me');
  const stale = new Client(srv.base);
  stale.cookies.sid = sid;
  assert.equal((await stale.get('/me')).status, 302);
});

test('admins cannot change their own status or role', async () => {
  await admin.post(`/admin/users/${adminUser.id}/block`, {}, '/admin');
  await admin.post(`/admin/users/${adminUser.id}/remove-admin`, {}, '/admin');
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(adminUser.id);
  assert.equal(me.status, 'active');
  assert.equal(me.role, 'admin');
});

test('unknown pages return 404', async () => {
  assert.equal((await client().get('/nope')).status, 404);
  assert.equal((await admin.get('/admin/users/999999')).status, 404);
  assert.equal((await admin.get('/admin/bookings/999999')).status, 404);
});

test('a blocked admin loses all admin powers, even after logging in again', async () => {
  const other = createUser({ email: 'other@sec.test' });
  const booking = Number(db.prepare(`INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status) VALUES (1, ?, ?, ?, 'approved')`)
    .run(other.id, inDays(15), inDays(15, '12:00')).lastInsertRowid);
  const exAdmin = createUser({ role: 'admin', email: 'blocked-admin@sec.test' });
  await admin.post(`/admin/users/${exAdmin.id}/block`, {}, `/admin/users/${exAdmin.id}`);
  assert.equal(db.prepare('SELECT role, status FROM users WHERE id = ?').get(exAdmin.id).status, 'blocked');

  const c = client();
  await c.login('blocked-admin@sec.test');
  for (const url of ['/admin', '/admin/users', `/admin/users/${other.id}/license`]) assert.equal((await c.get(url)).status, 403, url);
  assert.doesNotMatch((await c.get('/me')).text, /href="\/admin"/, 'no admin menu');
  const cal = (await c.get(`/calendar?view=day&date=${inDays(15).slice(0, 10)}`)).text;
  assert.doesNotMatch(cal, /בדיקה משתמש/, 'calendar does not reveal who booked');
  await c.post(`/me/bookings/${booking}/cancel`, {}, '/me/bookings');
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(booking).status, 'approved', 'cannot cancel other users\' bookings');
});

test('no third-party or Vercel scripts outside Vercel; CSP allows only same-origin scripts', async () => {
  const r = await client().get('/login');
  assert.doesNotMatch(r.text, /_vercel\/insights/);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
});
