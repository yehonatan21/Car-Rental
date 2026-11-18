'use strict';
// Security hardening (analysis/car-rental/SECURITY_FINDINGS.md): each test replays the attack and shows it is blocked.
process.env.MASTER_CONSOLE = 'true';
process.env.ADMIN_EMAIL = 'owner@hard.test';
process.env.ADMIN_PASSWORD = 'OwnerPass1';
process.env.MANAGE_TOKEN = 'h'.repeat(40);
const { db, createUser, startServer, Client, registrationForm } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../../src/auth');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());
const client = () => new Client(srv.base);
const api = (path, body) => fetch(srv.base + path, { method: 'POST', headers: { authorization: `Bearer ${'h'.repeat(40)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

test('SEC-001: another manager of the site hosting the console cannot change the main admin\'s account', async () => {
  const owner = db.prepare("SELECT * FROM users WHERE email = 'owner@hard.test'").get();
  createUser({ role: 'admin', email: 'site-manager@hard.test' });
  const m = client();
  await m.login('site-manager@hard.test');
  for (const [method, path, body] of [['GET', `/admin/users/${owner.id}/password`], ['POST', `/admin/users/${owner.id}/password`, { password: 'Taken-Over-1' }],
    ['POST', `/admin/users/${owner.id}/send-reset`, {}], ['POST', `/admin/users/${owner.id}/remove-admin`, {}], ['POST', `/admin/users/${owner.id}/block`, {}]]) {
    const r = method === 'GET' ? await m.get(path) : await m.post(path, body, `/admin/users/${owner.id}`);
    assert.equal(r.location, `/admin/users/${owner.id}`, path);
  }
  const after = db.prepare('SELECT * FROM users WHERE id = ?').get(owner.id);
  assert.deepEqual([after.role, after.status, after.password_hash], [owner.role, owner.status, owner.password_hash]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?').get(owner.id).n, 0);
  await client().login('owner@hard.test', 'OwnerPass1');
});

test('SEC-002: signing in to your own account does not reset the counter of the account being guessed', async () => {
  const victim = createUser({ email: 'victim@hard.test', password: 'VictimPass1' });
  createUser({ email: 'attacker@hard.test', password: 'Attacker1' });
  const c = client();
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 4; i++) await c.req('POST', '/login', { email: 'victim@hard.test', password: `guess-${round}-${i}` });
    await c.req('POST', '/login', { email: 'attacker@hard.test', password: 'Attacker1' }); // used to reset everything
  }
  const r = await c.req('POST', '/login', { email: 'victim@hard.test', password: 'VictimPass1' });
  assert.equal(r.status, 429, 'blocked after 10 failures even with the right password');
  // Counters are in the database: every server instance sees the same ones.
  assert.ok(db.prepare('SELECT count FROM throttle WHERE key = ?').get(`login:acct:${victim.id}`).count > 10);
  // The attacker's own sign-ins still work (they gave their count back), and a locked password does not lock the
  // e-mailed code: the real owner can still get in.
  await client().login('attacker@hard.test', 'Attacker1');
  const owner = client();
  const code = auth.createLoginCode(victim.id);
  const r2 = await owner.req('POST', '/login/code/verify', { email: 'victim@hard.test', code });
  assert.equal(r2.status, 303, 'signed in with the e-mailed code despite the locked password');
});

test('SEC-003: an account registered with someone else\'s address loses its password before it becomes a manager', async () => {
  // The attacker registers with the future manager's address and a password they know.
  const reg = await client().post('/register', registrationForm({ email: 'future-manager@hard.test', password: 'AttackerPw1' }));
  assert.equal(reg.status, 303);
  const pre = db.prepare("SELECT * FROM users WHERE email = 'future-manager@hard.test'").get();
  assert.equal(pre.email_verified_at, null);
  const attacker = client();
  await attacker.login('future-manager@hard.test', 'AttackerPw1');
  // The console makes that address a manager of the site.
  const r = await api('/api/manage/admins', { email: 'future-manager@hard.test' });
  assert.equal(r.promoted, true);
  assert.match(r.link, /^\/password\/reset\?token=/, 'the real owner gets an invitation to choose a password');
  const now = db.prepare('SELECT * FROM users WHERE id = ?').get(pre.id);
  assert.deepEqual([now.role, now.password_hash], ['admin', null]);
  assert.equal((await attacker.get('/admin')).status, 401, 'the attacker\'s session ended');
  await assert.rejects(client().login('future-manager@hard.test', 'AttackerPw1'), /login failed/);
  // The owner uses the invitation. It was shown to the console, not e-mailed, so it proves nothing yet; an e-mailed
  // sign-in code does. After that a later promotion keeps the owner's password.
  const token = decodeURIComponent(r.link.split('token=')[1]);
  await client().post('/password/reset', { token, password: 'RealOwner1', confirm: 'RealOwner1' });
  assert.equal(db.prepare('SELECT email_verified_at FROM users WHERE id = ?').get(pre.id).email_verified_at, null);
  assert.equal((await client().req('POST', '/login/code/verify', { email: 'future-manager@hard.test', code: auth.createLoginCode(pre.id) })).status, 303);
  assert.ok(db.prepare('SELECT email_verified_at FROM users WHERE id = ?').get(pre.id).email_verified_at);
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(pre.id);
  await api('/api/manage/admins', { email: 'future-manager@hard.test' });
  await client().login('future-manager@hard.test', 'RealOwner1');
});

test('SEC-003: a proven address keeps its password; e-mailed codes and reset links prove the address', () => {
  const u = createUser({ email: 'proven@hard.test' });
  auth.markEmailVerified(u.id);
  assert.equal(auth.distrustUnverified(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)), false);
  const v = createUser({ email: 'coded@hard.test' });
  assert.equal(auth.consumeLoginCode(v.id, auth.createLoginCode(v.id)), true);
  assert.ok(db.prepare('SELECT email_verified_at FROM users WHERE id = ?').get(v.id).email_verified_at);
});

test('SEC-003: only a link that was really e-mailed proves the address; the ADMIN_EMAIL account is proven from the start', () => {
  const shown = createUser({ email: 'shown@hard.test' });
  auth.resetPassword(auth.createPasswordReset(shown.id), 'Shown-Pass1');
  assert.equal(db.prepare('SELECT email_verified_at FROM users WHERE id = ?').get(shown.id).email_verified_at, null, 'a link shown to an admin');
  const mailed = createUser({ email: 'mailed@hard.test' });
  const t = auth.createPasswordReset(mailed.id);
  auth.markResetDelivered(t);
  auth.resetPassword(t, 'Mailed-Pass1');
  assert.ok(db.prepare('SELECT email_verified_at FROM users WHERE id = ?').get(mailed.id).email_verified_at, 'a link that was e-mailed');
  assert.ok(db.prepare("SELECT email_verified_at FROM users WHERE email = 'owner@hard.test'").get().email_verified_at);
});
