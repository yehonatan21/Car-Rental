'use strict';
// Security report, round 3 (docs/SECURITY_REPORT.md): S-03 who is registered, S-04 common passwords,
// S-05 per-account limits on e-mailed codes and links, S-06 field lengths.
const { db, createUser, startServer, Client, registrationForm } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { passwordProblem } = require('../../src/passwords');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());
const client = () => new Client(srv.base);

test('S-04: common passwords, with or without a short ending, and the person\'s own name or e-mail are refused', () => {
  for (const p of ['Password1', 'qwerty123', '12345678', 'Dragon2024!', 'iloveyou', 'aaaaaaaa']) assert.ok(passwordProblem(p), p);
  assert.match(passwordProblem('tal.cohen99', { email: 'tal.cohen@x.org' }), /השם או את כתובת המייל/);
  assert.match(passwordProblem('short'), /לפחות 8 תווים/);
  assert.equal(passwordProblem('Kfar-Saba-Bus-42'), null);
  assert.equal(passwordProblem('מכונית-כחולה-ירוקה'), null);
});

test('S-04: registration and password change refuse a common password', async () => {
  const r = await client().post('/register', registrationForm({ email: 'weak@h3.test', password: 'Password1' }));
  assert.equal(r.status, 400);
  assert.match(r.text, /נפוצה מדי/);
  createUser({ email: 'change@h3.test' });
  const c = client();
  await c.login('change@h3.test');
  await c.post('/me/password', { current: 'Password1', password: 'football1' }, '/me/security');
  assert.match(c.flash().text, /נפוצה מדי/);
});

test('S-03: signing in to an unknown address takes as long as a wrong password', async () => {
  createUser({ email: 'known@h3.test' });
  const time = async (email) => {
    const t = process.hrtime.bigint();
    await client().req('POST', '/login', { email, password: 'wrong-guess-1' });
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const known = []; const unknown = [];
  for (let i = 0; i < 4; i++) { known.push(await time('known@h3.test')); unknown.push(await time(`ghost${i}@h3.test`)); }
  const median = (a) => a.sort((x, y) => x - y)[2];
  assert.ok(median(unknown) > median(known) * 0.5, `unknown ${median(unknown)} ms vs known ${median(known)} ms`);
});

test('S-05: at most 3 reset links an hour per account, whatever the network address; the answer stays the same', async () => {
  const u = createUser({ email: 'flood@h3.test' });
  const count = () => db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.password_reset_requested' AND target_id = ?").get(u.id).n;
  const answers = [];
  for (let i = 0; i < 5; i++) {
    const r = await client().req('POST', '/password/forgot', { email: 'flood@h3.test' }, { 'x-forwarded-for': `203.0.113.${i + 1}` });
    answers.push(r.status);
  }
  assert.ok(answers.every((s) => s === answers[0]), `same answer every time: ${answers}`);
  assert.ok(count() <= 3, `only 3 links (${count()})`);
});

test('S-06: text fields are cut to a sensible length', async () => {
  const r = await client().post('/register', registrationForm({ email: 'long@h3.test', first_name: 'א'.repeat(100000) }));
  assert.equal(r.status, 303);
  assert.equal(db.prepare("SELECT length(first_name) AS n FROM users WHERE email = 'long@h3.test'").get().n, 60);
});

test('S-08: a manager\'s session ends after 8 hours without activity; a visit extends a session', async () => {
  const auth = require('../../src/auth');
  createUser({ role: 'admin', email: 'idle-admin@h3.test' });
  const a = client();
  await a.login('idle-admin@h3.test');
  const row = () => db.prepare('SELECT s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?').get('idle-admin@h3.test');
  const left = row().expires_at - Date.now();
  assert.ok(left <= auth.IDLE_MS.admin && left > auth.IDLE_MS.admin - 60000, 'starts with 8 hours');
  db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)').run(Date.now() + 3600000, 'idle-admin@h3.test');
  assert.equal((await a.get('/admin')).status, 200);
  assert.ok(row().expires_at - Date.now() > auth.IDLE_MS.admin - 60000, 'a visit extends it to 8 hours again');
  db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)').run(Date.now() - 1, 'idle-admin@h3.test');
  assert.equal((await a.get('/admin')).status, 401, 'after 8 idle hours: signed out');
  createUser({ email: 'idle-user@h3.test' });
  const u = client();
  await u.login('idle-user@h3.test');
  const userLeft = db.prepare("SELECT s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'idle-user@h3.test'").get().expires_at - Date.now();
  assert.ok(userLeft > 13 * 86400000, 'a regular user: 14 days');
});

test('S-09: registrations nobody handled for 90 days are deleted with the photo; the action log keeps 2 years', async () => {
  const old = createUser({ email: 'stale@h3.test', status: 'pending' });
  const fresh = createUser({ email: 'fresh-pending@h3.test', status: 'pending' });
  db.prepare("UPDATE users SET created_at = datetime('now', 'localtime', '-91 days') WHERE id = ?").run(old.id);
  db.prepare("INSERT INTO audit_log (action, at) VALUES ('test.ancient', datetime('now', 'localtime', '-800 days'))").run();
  await require('../../src/jobs').runJobs();
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(old.id), undefined);
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(fresh.id));
  assert.equal(db.prepare("SELECT 1 FROM audit_log WHERE action = 'test.ancient'").get(), undefined);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'user.pending_expired' AND target_id = ?").get(old.id));
});

test('S-10: CSP forbids <base> and plugins; a Permissions-Policy is sent', async () => {
  const r = await fetch(srv.base + '/login');
  assert.match(r.headers.get('content-security-policy'), /base-uri 'none'; object-src 'none'/);
  assert.match(r.headers.get('permissions-policy'), /camera=\(\)/);
});
