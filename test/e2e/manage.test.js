'use strict';
// The management API of a client instance (routes/manage.js), which the master console uses: only with the
// instance's MANAGE_TOKEN; status, branding, managers, one-time sign-in links and suspending the whole site.
const { db, createUser, startServer, Client, PNG, outbox, inDays } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { brand } = require('../../src/brand');

const TOKEN = 'm'.repeat(20) + '-test-manage-token-0123456789';
let srv;

before(async () => { srv = await startServer(); });
after(() => srv.close());

/** Calls the management API like the console does. */
async function api(method, path, body, token = TOKEN) {
  const res = await fetch(srv.base + path, {
    method, redirect: 'manual',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, headers: res.headers };
}

test('without MANAGE_TOKEN the API does not exist; with it, only the right token is accepted', async () => {
  delete process.env.MANAGE_TOKEN;
  assert.deepEqual((await api('GET', '/api/manage/status')).data, { error: 'not_enabled' });
  process.env.MANAGE_TOKEN = 'too-short';
  assert.equal((await api('GET', '/api/manage/status')).status, 404, 'a short token does not turn it on');
  process.env.MANAGE_TOKEN = TOKEN;
  assert.equal((await api('GET', '/api/manage/status', null, null)).status, 401);
  assert.equal((await api('GET', '/api/manage/status', null, TOKEN + 'x')).status, 401);
  const ok = await api('GET', '/api/manage/status');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.data.app, 'car-rental');
  // A signed-in browser session gives no access: only the token does.
  const admin = createUser({ role: 'admin' });
  const browser = new Client(srv.base);
  await browser.login(admin.email);
  assert.equal((await browser.get('/api/manage/admins')).status, 401);
});

test('status: name, colour and the numbers the console shows', async () => {
  createUser({ status: 'pending' });
  const u = createUser();
  const v = db.prepare('SELECT id FROM vehicles LIMIT 1').get().id;
  const add = (status, start, end) => db.prepare(`INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))`).run(v, u.id, start, end, status);
  add('pending', inDays(3), inDays(3, '12:00'));
  add('approved', inDays(5), inDays(5, '12:00'));
  add('approved', inDays(6), inDays(6, '12:00'));
  const { data } = await api('GET', '/api/manage/status');
  assert.equal(data.branding.name, brand().name);
  assert.equal(data.branding.color, '#0b7a63');
  assert.equal(data.counts.pendingUsers, 1);
  assert.equal(data.counts.pendingBookings, 1);
  assert.equal(data.counts.upcomingBookings, 2);
  assert.equal(data.counts.bookings, 3);
  assert.ok(data.counts.users >= 2);
  assert.equal(data.suspended, null);
  assert.equal(data.mail.configured, false);
  assert.ok(data.storage.id);
  assert.ok(data.lastBookingAt);
});

test('branding from the console: name, colour, contact details and logo; bad values are refused', async () => {
  let r = await api('POST', '/api/manage/branding', {
    org_name: 'גמח מרכזי', brand_color: '#1D4ED8', contact_phone: '050-7654321', contact_email: 'office@central.org', welcome_text: 'ברוכים הבאים', by: 'boss@master.org',
    logo: { type: 'image/png', data: PNG.toString('base64') },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.branding.name, 'גמח מרכזי');
  assert.equal(r.data.branding.color, '#1d4ed8');
  assert.equal(r.data.branding.logo, true);
  const home = await (await fetch(srv.base + '/')).text();
  assert.match(home, /<title>ברוכים הבאים · גמח מרכזי<\/title>/);
  assert.match(home, /--primary:#1d4ed8/);
  const logo = await fetch(`${srv.base}/brand/logo`);
  assert.equal(logo.status, 200);
  assert.deepEqual(Buffer.from(await logo.arrayBuffer()), PNG);
  assert.match(db.prepare("SELECT details FROM audit_log WHERE action = 'manage.branding' ORDER BY id DESC").get().details, /boss@master\.org/);

  assert.equal((await api('POST', '/api/manage/branding', { brand_color: 'blue' })).status, 400);
  r = await api('POST', '/api/manage/branding', { contact_email: 'nope' });
  assert.equal(r.status, 400);
  assert.match(r.data.message, /המייל ליצירת קשר/);
  assert.equal((await api('POST', '/api/manage/branding', { logo: { type: 'application/pdf', data: 'JVBERi0=' } })).status, 400);
  assert.equal(brand().contactEmail, 'office@central.org', 'nothing changed by refused requests');

  r = await api('POST', '/api/manage/branding', { remove_logo: true, org_name: '' });
  assert.equal(r.data.branding.logo, false);
  assert.equal(r.data.branding.name, 'הזמנת רכב', 'an empty name goes back to the default');
  assert.equal((await fetch(`${srv.base}/brand/logo`)).status, 404);
});

test('managers: a new one gets an invitation with a link to choose a password, and can then manage the site', async () => {
  let r = await api('POST', '/api/manage/admins', { email: 'New.Manager@Client.org', first_name: 'דנה', last_name: 'כהן', invited_by: 'יהונתן' });
  assert.equal(r.status, 200);
  assert.equal(r.data.created, true);
  assert.equal(r.data.emailed, false, 'no mail server in the tests');
  assert.match(r.data.link, /^\/password\/reset\?token=/);
  const m = outbox().find((x) => x.to.includes('new.manager@client.org'));
  assert.match(m.subject, /הוזמנת לנהל את מערכת הזמנת הרכב/);
  assert.match(m.body, /יהונתן הזמין\/ה אותך לנהל/);

  const list = (await api('GET', '/api/manage/admins')).data.admins;
  const added = list.find((a) => a.email === 'new.manager@client.org');
  assert.equal(added.invitePending, true);

  const browser = new Client(srv.base);
  const token = decodeURIComponent(r.data.link.split('token=')[1]);
  assert.equal((await browser.get(r.data.link)).status, 200);
  const reset = await browser.post('/password/reset', { token, password: 'Manager-Kfar-9', confirm: 'Manager-Kfar-9' });
  assert.equal(reset.status, 303);
  await browser.login('new.manager@client.org', 'Manager-Kfar-9');
  assert.equal((await browser.get('/admin')).status, 200);
  assert.equal((await api('GET', '/api/manage/admins')).data.admins.find((a) => a.id === added.id).invitePending, false);

  // Someone already registered, whose address is proven, becomes a manager and keeps their password.
  const member = createUser({ email: 'member@client.org' });
  db.prepare("UPDATE users SET email_verified_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(member.id);
  r = await api('POST', '/api/manage/admins', { email: 'member@client.org' });
  assert.deepEqual([r.data.created, r.data.promoted, r.data.link], [false, true, null]);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(member.id).role, 'admin');
  // An account whose address was never proven gets an invitation instead: its password may not be the owner's (SEC-003).
  const unproven = createUser({ email: 'unproven@client.org' });
  r = await api('POST', '/api/manage/admins', { email: 'unproven@client.org' });
  assert.match(r.data.link, /^\/password\/reset\?token=/);
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(unproven.id).password_hash, null);

  r = await api('POST', `/api/manage/admins/${member.id}/remove`, {});
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(member.id).role, 'user');
  assert.equal((await api('POST', '/api/manage/admins/999999/remove', {})).status, 404);
  assert.equal((await api('POST', '/api/manage/admins', { email: 'bad' })).status, 400);
});

test('a one-time sign-in link for the console admin: works once, for 2 minutes', async () => {
  const r = await api('POST', '/api/manage/login-link', { email: 'boss@master.org', first_name: 'יהונתן', last_name: 'מנהל' });
  assert.equal(r.status, 200);
  assert.match(r.data.path, /^\/manage\/sso\?token=/);
  const boss = db.prepare('SELECT * FROM users WHERE email = ?').get('boss@master.org');
  assert.deepEqual([boss.role, boss.status], ['admin', 'active']);

  const browser = new Client(srv.base);
  const go = await browser.get(r.data.path);
  assert.equal(go.status, 303);
  assert.equal(go.location, '/admin');
  const page = await browser.get('/admin');
  assert.equal(page.status, 200);
  assert.match(page.text, /יהונתן מנהל/);

  assert.equal((await new Client(srv.base).get(r.data.path)).status, 400, 'used up');
  const old = await api('POST', '/api/manage/login-link', { email: 'boss@master.org' });
  db.prepare('UPDATE sso_tokens SET expires_at = ?').run(Date.now() - 1);
  const expired = await new Client(srv.base).get(old.data.path);
  assert.equal(expired.status, 400);
  assert.match(expired.text, /קישור הכניסה אינו תקף/);

  // The console admin was blocked by the client's managers: signing in from the console makes them a manager again.
  db.prepare("UPDATE users SET status = 'blocked' WHERE email = 'boss@master.org'").run();
  await api('POST', '/api/manage/login-link', { email: 'boss@master.org' });
  assert.equal(db.prepare("SELECT status FROM users WHERE email = 'boss@master.org'").get().status, 'active');
});

test('suspending: every page shows the notice; the health check and the API keep working; resuming', async () => {
  let r = await api('POST', '/api/manage/suspend', { suspended: true, message: 'החשבון בבדיקה' });
  assert.equal(r.data.suspended.message, 'החשבון בבדיקה');
  for (const path of ['/', '/login', '/calendar', '/admin']) {
    const page = await fetch(srv.base + path, { redirect: 'manual' });
    assert.equal(page.status, 503, path);
    const text = await page.text();
    assert.match(text, /השירות מושהה זמנית/);
    assert.match(text, /החשבון בבדיקה/);
    assert.doesNotMatch(text, /href="\/register"/, 'no navigation into the closed site');
  }
  assert.equal((await fetch(srv.base + '/login', { method: 'POST', body: new URLSearchParams({ email: 'x@y.z', password: 'x' }) })).status, 503);
  assert.equal((await fetch(srv.base + '/healthz')).status, 200);
  assert.equal((await api('GET', '/api/manage/status')).data.suspended.message, 'החשבון בבדיקה');

  r = await api('POST', '/api/manage/suspend', { suspended: false });
  assert.equal(r.data.suspended, null);
  assert.equal((await fetch(srv.base + '/login')).status, 200);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'manage.resume'").get());
});

test('users: found by name or e-mail, and a new password set from the console signs them out everywhere', async () => {
  const u = createUser({ first_name: 'רונית', last_name: 'שמש', email: 'ronit@client.org' });
  const r = await api('GET', '/api/manage/users?q=' + encodeURIComponent('רונית שמש'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.users.map((x) => x.email), ['ronit@client.org']);
  assert.equal(r.data.users[0].hasPassword, true);
  assert.equal(r.data.users[0].id_number, undefined, 'no ID numbers leave the site');
  assert.equal((await api('GET', '/api/manage/users?q=ronit%40client')).data.users.length, 1);
  assert.equal((await api('GET', '/api/manage/users?q=%25')).data.users.length, 0, 'a % is searched as itself');
  assert.equal((await api('GET', `/api/manage/users/${u.id}`)).data.user.email, 'ronit@client.org');
  assert.equal((await api('GET', '/api/manage/users/999999')).status, 404);

  const before = new Client(srv.base);
  await before.login('ronit@client.org');
  assert.equal((await api('POST', `/api/manage/users/${u.id}/password`, { password: 'short' })).status, 400);
  const set = await api('POST', `/api/manage/users/${u.id}/password`, { password: 'NewSecret123', notify: true, by: 'owner@master.org' });
  assert.equal(set.status, 200);
  assert.equal((await before.get('/me')).status, 401, 'signed out everywhere');
  await assert.rejects(new Client(srv.base).login('ronit@client.org', 'Password1'), /login failed/);
  await new Client(srv.base).login('ronit@client.org', 'NewSecret123');
  const m = outbox().find((x) => x.to.includes('ronit@client.org') && /סיסמה חדשה/.test(x.subject));
  assert.ok(m, 'told by e-mail');
  assert.doesNotMatch(m.body, /NewSecret123/, 'the password itself is never e-mailed');
  assert.match(db.prepare("SELECT details FROM audit_log WHERE action = 'manage.password_set' ORDER BY id DESC").get().details, /owner@master\.org/);
});

test('guessing the token is cut off', async () => {
  let last;
  for (let i = 0; i < 22; i++) last = await api('GET', '/api/manage/status', null, 'wrong-token');
  assert.equal(last.status, 429);
});
