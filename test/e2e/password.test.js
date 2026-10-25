'use strict';
// "Forgot password": e-mailed single-use link, expiry, sessions ended, admin can send a link.
const { db, createUser, startServer, Client, outbox } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../../src/auth');

let srv, admin;
const client = () => new Client(srv.base);
before(async () => {
  srv = await startServer();
  createUser({ role: 'admin', email: 'admin@pw.test' });
  admin = client();
  await admin.login('admin@pw.test');
});
after(() => srv.close());

const lastLink = (email) => {
  const m = outbox().filter((x) => x.subject === 'איפוס סיסמה' && x.to.includes(email)).pop();
  return m && /\/password\/reset\?token=([A-Za-z0-9_%-]+)/.exec(m.body)?.[1];
};

test('login page links to "forgot password"', async () => {
  assert.match((await client().get('/login')).text, /href="\/password\/forgot">שכחתי סיסמה/);
  assert.equal((await client().get('/password/forgot')).status, 200);
});

test('full reset: e-mail link → new password → old one stops working, everyone logged out', async () => {
  createUser({ email: 'forgot@pw.test', password: 'OldPassword1' });
  const loggedIn = client();
  await loggedIn.login('forgot@pw.test', 'OldPassword1');

  const c = client();
  const r = await c.post('/password/forgot', { email: 'forgot@pw.test' });
  assert.match(r.text, /בדקו את תיבת הדואר/);
  assert.match(r.text, /הקישור מודפס בחלון השרת/, 'development hint without SMTP');
  const token = decodeURIComponent(lastLink('forgot@pw.test'));
  assert.ok(token);

  const form = await c.get(`/password/reset?token=${encodeURIComponent(token)}`);
  assert.equal(form.status, 200);
  assert.match(form.headers.get('cache-control'), /no-store/);

  let bad = await c.post('/password/reset', { token, password: 'NewPassword1', confirm: 'Different1' });
  assert.match(bad.text, /הסיסמאות אינן זהות/);
  bad = await c.post('/password/reset', { token, password: 'short', confirm: 'short' });
  assert.match(bad.text, /לפחות 8 תווים/);

  const ok = await c.post('/password/reset', { token, password: 'NewPassword1', confirm: 'NewPassword1' });
  assert.equal(ok.location, '/login');
  assert.match(c.flash().text, /הסיסמה עודכנה/);
  assert.equal((await loggedIn.get('/me')).status, 302, 'existing sessions ended');
  assert.equal((await client().post('/login', { email: 'forgot@pw.test', password: 'OldPassword1' })).status, 401);
  await client().login('forgot@pw.test', 'NewPassword1');
  assert.ok(outbox().some((m) => m.subject === 'הסיסמה שלך שונתה' && m.to.includes('forgot@pw.test')));

  const reuse = await c.post('/password/reset', { token, password: 'Another123', confirm: 'Another123' });
  assert.equal(reuse.status, 400, 'single use');
  assert.match(reuse.text, /הקישור אינו תקף/);
});

test('unknown e-mail gets the same answer; no e-mail sent', async () => {
  const before = outbox().length;
  const r = await client().post('/password/forgot', { email: 'nobody@pw.test' });
  assert.equal(r.status, 200);
  assert.match(r.text, /אם הכתובת/);
  assert.equal(outbox().length, before);
});

test('expired, forged and superseded links are refused', async () => {
  const u = createUser({ email: 'expire@pw.test' });
  const t1 = auth.createPasswordReset(u.id);
  const t2 = auth.createPasswordReset(u.id);
  assert.equal(auth.checkPasswordReset(t1), null, 'a new link cancels the previous one');
  assert.equal(auth.checkPasswordReset(t2), u.id);
  db.prepare('UPDATE password_resets SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await client().get(`/password/reset?token=${t2}`)).status, 400);
  assert.equal((await client().get('/password/reset?token=forged')).status, 400);
  assert.equal((await client().get('/password/reset')).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE token_hash = ?').get(t2).n, 0, 'only hashes are stored');
});

test('admin can send a reset link from the user card (also to themselves)', async () => {
  const u = createUser({ email: 'byadmin@pw.test' });
  assert.match((await admin.get(`/admin/users/${u.id}`)).text, /שליחת קישור לאיפוס סיסמה/);
  await admin.post(`/admin/users/${u.id}/send-reset`, {}, `/admin/users/${u.id}`);
  assert.match(admin.flash().text, /נשלח אל byadmin@pw.test/);
  assert.ok(lastLink('byadmin@pw.test'));
  const me = db.prepare("SELECT id FROM users WHERE email = 'admin@pw.test'").get();
  await admin.post(`/admin/users/${me.id}/send-reset`, {}, `/admin/users/${me.id}`);
  assert.ok(lastLink('admin@pw.test'));
  assert.equal((await new Client(srv.base).post(`/admin/users/${u.id}/send-reset`, {})).status, 302, 'not for anonymous users');
});

test('requests are throttled', async () => {
  let last;
  for (let i = 0; i < 7; i++) last = await client().post('/password/forgot', { email: 'flood@pw.test' });
  assert.equal(last.status, 429);
});
