'use strict';
// Passkeys, manager levels (owner / manager / read-only) and confirming identity before sensitive actions.
const { db, createUser, startServer, Client } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { FakeAuthenticator, pageOptions } = require('../fake-authenticator');
const passkeys = require('../../src/passkeys');

let srv;
before(async () => { process.env.PASSKEYS = 'on'; srv = await startServer(); }); // switched off by default (src/passkeys.js)
after(() => { delete process.env.PASSKEYS; return srv.close(); });
const client = () => new Client(srv.base);

/** Adds a passkey to the signed-in client c; returns the authenticator. */
async function addPasskey(c, name = 'הטלפון שלי') {
  const csrf = await c.csrf('/me/security');
  const r = await c.req('POST', '/me/passkeys/options', { _csrf: csrf });
  assert.equal(r.status, 200);
  const { token, options } = JSON.parse(r.text);
  const device = new FakeAuthenticator();
  const saved = await c.post('/me/passkeys', { token, credential: JSON.stringify(device.create(options, srv.base)), name }, '/me/security');
  assert.equal(saved.location, '/me/security#passkeys');
  assert.match(c.flash().text, /נוסף/);
  return device;
}

/** Answers a passkey page (sign-in or confirmation) with `device`; returns the response. */
async function answer(c, page, device, action) {
  const { options, token } = pageOptions(page.text);
  return c.post(action, { token, credential: JSON.stringify(device.get(options, srv.base)) });
}

test('a manager adds a passkey; from then on signing in needs it, after the password or the e-mailed code', async () => {
  const u = createUser({ role: 'admin', email: 'pk-admin@pk.test' });
  const c = client();
  await c.login('pk-admin@pk.test');
  assert.match((await c.get('/me/security')).text, /מפתחות גישה \(Passkeys\)[\s\S]*data-passkey="create"/);
  const device = await addPasskey(c);
  assert.equal(passkeys.list(u.id).length, 1);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'user.passkey_add' AND target_id = ?").get(u.id));

  // Password: no session yet, the passkey page instead.
  const b = client();
  const step = await b.post('/login', { email: 'pk-admin@pk.test', password: 'Password1', next: '/admin/users' });
  assert.equal(step.status, 200);
  assert.match(step.text, /אימות עם מפתח גישה/);
  assert.equal(b.cookies.sid, undefined, 'not signed in by the password alone');
  // Another device's answer is refused.
  const stranger = new FakeAuthenticator();
  const wrong = await answer(b, step, stranger, '/login/passkey');
  assert.equal(wrong.status, 401);
  assert.equal(b.cookies.sid, undefined);
  // The right device (on a fresh challenge: each one is single use).
  const again = await b.post('/login', { email: 'pk-admin@pk.test', password: 'Password1', next: '/admin/users' });
  const ok = await answer(b, again, device, '/login/passkey');
  assert.equal(ok.location, '/admin/users', 'continues to the page asked for');
  assert.ok(b.cookies.sid);
  assert.equal((await answer(client(), again, device, '/login/passkey')).status, 401, 'a challenge works once');

  // The e-mailed code alone is not enough either.
  const auth = require('../../src/auth');
  const code = auth.createLoginCode(u.id);
  const viaCode = client();
  const r = await viaCode.post('/login/code/verify', { email: 'pk-admin@pk.test', code });
  assert.match(r.text, /אימות עם מפתח גישה/);
  assert.equal(viaCode.cookies.sid, undefined);
});

test('sensitive actions ask to confirm identity after 10 minutes: with the passkey, or the password', async () => {
  const owner = createUser({ role: 'admin', email: 'reauth-owner@pk.test' });
  const target = createUser({ email: 'reauth-target@pk.test' });
  const c = client();
  await c.login('reauth-owner@pk.test');
  const old = () => db.prepare('UPDATE sessions SET auth_at = ? WHERE user_id = ?').run(Date.now() - 11 * 60000, owner.id);
  old();
  const r = await c.req('POST', `/admin/users/${target.id}/delete`, { confirm: '1', _csrf: await c.csrf(`/admin/users/${target.id}`) },
    { referer: `${srv.base}/admin/users/${target.id}` });
  assert.equal(r.status, 303);
  assert.match(r.location, /^\/reauth\?back=%2Fadmin%2Fusers%2F\d+$/);
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(target.id), 'not deleted yet');
  // Without a passkey: the password.
  const page = await c.get(r.location);
  assert.match(page.text, /אישור זהות[\s\S]*name="password"/);
  assert.equal((await c.post('/reauth', { password: 'wrong-pass-1', back: `/admin/users/${target.id}` }, r.location)).location, `/reauth?back=%2Fadmin%2Fusers%2F${target.id}`);
  assert.equal((await c.post('/reauth', { password: 'Password1', back: `/admin/users/${target.id}` }, r.location)).location, `/admin/users/${target.id}`);
  assert.equal((await c.post(`/admin/users/${target.id}/delete`, { confirm: '1' }, `/admin/users/${target.id}`)).location, '/admin/users');
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(target.id), undefined, 'deleted after confirming');

  // With a passkey: the passkey (a password is not accepted instead).
  const device = await addPasskey(c);
  old();
  const page2 = await c.get('/reauth?back=%2Fadmin%2Fusers');
  assert.match(page2.text, /data-passkey="get"/);
  assert.doesNotMatch(page2.text, /name="password"/);
  const done = await answer(c, page2, device, '/reauth/passkey');
  assert.equal(done.location, '/admin/users');
  assert.ok(Date.now() - db.prepare('SELECT auth_at FROM sessions WHERE user_id = ?').get(owner.id).auth_at < 5000);
});

test('levels: until an owner is chosen every manager acts as one; then only the owner changes managers', async () => {
  const boss = createUser({ role: 'admin', email: 'boss@lvl.test' });
  const mgr = createUser({ role: 'admin', email: 'mgr@lvl.test' });
  const viewer = createUser({ role: 'admin', email: 'viewer@lvl.test' });
  const plain = createUser({ email: 'plain@lvl.test' });
  db.prepare("UPDATE users SET admin_level = NULL WHERE role = 'admin'").run();
  const b = client(); await b.login('boss@lvl.test');
  const m = client(); await m.login('mgr@lvl.test');
  const v = client(); await v.login('viewer@lvl.test');

  // No owner yet: a manager may set levels.
  assert.equal((await b.post(`/admin/users/${viewer.id}/level`, { level: 'viewer' }, `/admin/users/${viewer.id}`)).status, 303);
  assert.equal(db.prepare('SELECT admin_level FROM users WHERE id = ?').get(viewer.id).admin_level, 'viewer');
  await m.post(`/admin/users/${boss.id}/level`, { level: 'owner' }, `/admin/users/${boss.id}`);
  assert.equal(db.prepare('SELECT admin_level FROM users WHERE id = ?').get(boss.id).admin_level, 'owner');

  // Now: the manager can no longer change managers or delete users.
  await m.post(`/admin/users/${plain.id}/make-admin`, {}, `/admin/users/${plain.id}`);
  assert.match(m.flash().text, /רק הבעלים/);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(plain.id).role, 'user');
  await m.post(`/admin/users/${plain.id}/delete`, { confirm: '1' }, `/admin/users/${plain.id}`);
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(plain.id));
  assert.match((await m.get(`/admin/users/${plain.id}`)).text, /מינוי מנהלים ושינוי הרשאות: רק הבעלים/);
  // ...but still does everything else.
  await m.post(`/admin/users/${plain.id}/note`, { note: 'הערה' }, `/admin/users/${plain.id}`);
  assert.equal(m.flash().type, 'success');
  // The owner can.
  await b.post(`/admin/users/${plain.id}/make-admin`, {}, `/admin/users/${plain.id}`);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(plain.id).role, 'admin');

  // Read-only: sees, changes nothing.
  const page = await v.get('/admin/users');
  assert.equal(page.status, 200);
  assert.match(page.text, /הרשאת צפייה בלבד/);
  await v.post(`/admin/users/${mgr.id}/note`, { note: 'x' }, '/admin/users');
  assert.match(v.flash().text, /צפייה בלבד/);
  db.prepare("UPDATE users SET admin_level = NULL WHERE role = 'admin'").run();
});

test('an owner removes a manager\'s passkeys after a lost device; PASSKEY_RESET does it for the main admin once', async () => {
  const owner = createUser({ role: 'admin', email: 'pko@pk.test' });
  const lost = createUser({ role: 'admin', email: 'lost@pk.test' });
  const l = client(); await l.login('lost@pk.test');
  await addPasskey(l);
  const o = client(); await o.login('pko@pk.test');
  await o.post(`/admin/users/${lost.id}/passkeys/remove`, {}, `/admin/users/${lost.id}`);
  assert.equal(passkeys.list(lost.id).length, 0);
  assert.equal(owner.role, 'admin');

  const l2 = client(); await l2.login('lost@pk.test'); // back to the password
  await addPasskey(l2);
  process.env.PASSKEY_RESET = 'lost@pk.test';
  try {
    passkeys.resetFromEnv();
    assert.equal(passkeys.list(lost.id).length, 0);
    const l3 = client(); await l3.login('lost@pk.test');
    await addPasskey(l3);
    passkeys.resetFromEnv();
    assert.equal(passkeys.list(lost.id).length, 1, 'not again at the next start');
  } finally {
    delete process.env.PASSKEY_RESET;
  }
});

test('switched off (the default): nobody is asked for a passkey, even with one saved, and the screens are hidden', async () => {
  const u = createUser({ role: 'admin', email: 'pk-off@pk.test' });
  const c = client();
  await c.login('pk-off@pk.test');
  await addPasskey(c);
  delete process.env.PASSKEYS;
  try {
    const b = client();
    const r = await b.post('/login', { email: 'pk-off@pk.test', password: 'Password1' });
    assert.equal(r.status, 303, 'signed in with the password alone');
    assert.doesNotMatch((await b.get('/me/security')).text, /מפתחות גישה \(Passkeys\)/);
    assert.equal(passkeys.consoleRequires(), false);
    assert.equal(passkeys.list(u.id).length, 1, 'the saved passkey is kept for later');
  } finally {
    process.env.PASSKEYS = 'on';
  }
});
