'use strict';
// Account screens and their less travelled paths: confirming who you are with an e-mailed code (an account without a
// password), a passkey answer that fails, removing a passkey, the policy page sent without its box ticked, the
// availability check against a taken slot, the personal page with several bookings, a manager's own new license,
// sign-in codes asked for too often, a password-reset e-mail that can't be sent, and the managers' rules about who may
// delete or set the password of whom.
process.env.PASSKEYS = 'on';
const { db, createUser, startServer, Client, inDays, outbox, clearOutbox } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mail = require('../../src/mail');

let srv;
before(async () => { srv = await startServer(); });
after(() => { delete process.env.PASSKEYS; return srv.close(); });

async function signedIn(overrides) {
  const u = createUser(overrides);
  const c = new Client(srv.base);
  await c.login(u.email);
  return { u, c };
}
const insertBooking = (userId, start, end, status = 'approved') => Number(db.prepare(
  'INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status) VALUES (1, ?, ?, ?, ?)').run(userId, start, end, status).lastInsertRowid);

test('an account without a password confirms who it is with an e-mailed code', async () => {
  const { u, c } = await signedIn();
  db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(u.id);
  db.prepare('UPDATE sessions SET auth_at = 0 WHERE user_id = ?').run(u.id);

  const page = await c.get('/reauth?back=/me/security');
  assert.match(page.text, /לחשבון אין סיסמה/);
  assert.match(page.text, /action="\/reauth\/code"/);

  clearOutbox();
  const sent = await c.post('/reauth/code', { back: '/me/security' }, '/reauth');
  assert.equal(sent.status, 200);
  assert.match(sent.text, /שלחנו קוד בן 6 ספרות/);
  const code = /קוד התחברות: (\d{6})/.exec(outbox().at(-1).subject)[1];

  const wrong = await c.post('/reauth', { code: '000000', back: '/me/security' }, '/reauth');
  assert.equal(wrong.status, 303);
  assert.match(wrong.location, /^\/reauth\?back=/);
  assert.match(c.flash().text, /הקוד שגוי/);

  const ok = await c.post('/reauth', { code, back: '/me/security' }, '/reauth');
  assert.equal(ok.status, 303);
  assert.equal(ok.location, '/me/security');
  assert.ok(db.prepare('SELECT auth_at FROM sessions WHERE user_id = ?').get(u.id).auth_at > 0);
});

test('a code can\'t be sent: the person is told, and goes back', async (t) => {
  const { c } = await signedIn();
  t.mock.method(mail, 'loginCode', async () => false);
  const r = await c.post('/reauth/code', { back: '/me' }, '/me');
  assert.equal(r.status, 303);
  assert.equal(r.location, '/me');
  assert.match(c.flash().text, /לא ניתן לשלוח קוד/);
});

test('passkeys: a failed answer is shown; a key is listed and removed (only the owner\'s own)', async () => {
  const { u, c } = await signedIn({ role: 'admin' });
  const bad = await c.post('/me/passkeys', { token: 'expired', credential: '{}', name: 'x' }, '/me/security');
  assert.equal(bad.location, '/me/security#passkeys');
  assert.match(c.flash().text, /הבקשה פגה/);

  db.prepare(`INSERT INTO passkeys (id, user_id, public_key, counter, name, created_at, last_used_at)
    VALUES ('k1', ?, 'AAAA', 0, 'הטלפון שלי', '2026-01-01 10:00', '2026-02-01 09:30')`).run(u.id);
  const page = await c.get('/me/security');
  assert.match(page.text, /הטלפון שלי/);
  assert.match(page.text, /שימוש אחרון 01\/02\/2026/);

  // Confirming with a passkey answer that does not check out goes back to the confirmation page.
  const reauth = await c.post('/reauth/passkey', { token: 'nope', credential: '{}' }, '/me/security');
  assert.equal(reauth.location, '/reauth');
  assert.match(c.flash().text, /הבקשה פגה/);

  // Someone else's key id: nothing happens.
  const other = createUser({ role: 'admin' });
  db.prepare("INSERT INTO passkeys (id, user_id, public_key, counter, name, created_at) VALUES ('k2', ?, 'AAAA', 0, 'x', '2026-01-01')").run(other.id);
  await c.post('/me/passkeys/k2/remove', {}, '/me/security');
  assert.equal(c.flash(), null);
  assert.ok(db.prepare("SELECT 1 FROM passkeys WHERE id = 'k2'").get());

  const removed = await c.post('/me/passkeys/k1/remove', {}, '/me/security');
  assert.equal(removed.location, '/me/security#passkeys');
  assert.equal(c.flash().text, 'מפתח הגישה הוסר');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?").get(u.id).n, 0);
});

test('the policy form sent without its box ticked asks again', async () => {
  const { c } = await signedIn();
  const r = await c.post('/policy/accept', { version: '1' }, '/policy/accept');
  assert.equal(r.status, 303);
  assert.equal(r.location, '/policy/accept');
  assert.equal(c.flash().text, 'יש לסמן את תיבת האישור');
});

test('availability check: a taken slot says when it is taken; the personal page lists the further bookings', async () => {
  const { u, c } = await signedIn();
  insertBooking(u.id, inDays(3), inDays(4));
  insertBooking(u.id, inDays(6), inDays(7), 'pending');
  const r = JSON.parse((await c.get(`/api/availability?start=${inDays(3, '12:00')}&end=${inDays(3, '14:00')}`)).text);
  assert.equal(r.ok, false);
  assert.match(r.message, /הרכב תפוס בחלק מהזמן/);
  const me = await c.get('/me');
  assert.match(me.text, /הזמנות נוספות/);
  assert.match(me.text, /class="plain upcoming"/);
  db.exec('DELETE FROM bookings');
});

test('a manager who uploaded a new license of their own is pointed to approving it', async () => {
  const { u, c } = await signedIn({ role: 'admin' });
  db.prepare("UPDATE users SET pending_license_file = 'new.png' WHERE id = ?").run(u.id);
  const me = await c.get('/me');
  assert.match(me.text, new RegExp(`/admin/users/${u.id}#license`));
});

test('sign-in codes asked for too often are refused', async () => {
  const c = new Client(srv.base);
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await c.post('/login/code', { email: 'nobody@codes.test' })).status);
  assert.equal(statuses.at(-1), 429);
});

test('a password-reset e-mail that can\'t be sent: the form says so', async (t) => {
  const u = createUser({ email: 'forgot@gaps.test' });
  t.mock.method(mail, 'passwordReset', async () => false);
  const r = await new Client(srv.base).post('/password/forgot', { email: u.email });
  assert.equal(r.status, 503);
  assert.match(r.text, /שליחת המייל נכשלה/);
});

test('managers: the ADMIN_EMAIL account can\'t be deleted; only the owner sets another manager\'s password', async () => {
  process.env.ADMIN_EMAIL = 'main@gaps.test';
  try {
    const main = createUser({ role: 'admin', email: 'main@gaps.test' });
    const { u: ownerUser, c: owner } = await signedIn({ role: 'admin' });
    db.prepare("UPDATE users SET admin_level = 'owner' WHERE id = ?").run(ownerUser.id);
    const del = await owner.post(`/admin/users/${main.id}/delete`, { confirm: '1' }, `/admin/users/${main.id}`);
    assert.equal(del.location, `/admin/users/${main.id}#delete`);
    assert.match(owner.flash().text, /ADMIN_EMAIL/);
    assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(main.id));

    const { c: manager } = await signedIn({ role: 'admin' }); // not the owner, and the site has one
    const other = createUser({ role: 'admin' });
    const pw = await manager.post(`/admin/users/${other.id}/password`, { password: 'Another-Pass-77' }, `/admin/users/${other.id}`);
    assert.equal(pw.location, `/admin/users/${other.id}`);
    assert.match(manager.flash().text, /רק הבעלים/);
  } finally {
    delete process.env.ADMIN_EMAIL;
  }
});
