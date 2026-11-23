'use strict';
// Failure paths of the small modules that the flows never reach: a database that refuses a write while an error or an
// e-mail is being recorded, a push service that can't be reached, a passkey answer the library rejects, a provider
// that does not answer, a slow request, a malformed cookie, the e-mails left to Vercel's waitUntil.
const { db, createUser } = require('../helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../src/config');

/** Sets config values for the rest of the test (put back afterwards). Not t.mock.property: mocking the same property
 * twice in one test makes the test runner exit silently (Node 22). */
function setConfig(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, config[k]]));
  Object.assign(config, values);
  t.after(() => Object.assign(config, saved));
}

/** Makes db.prepare throw for statements matching `re` (others work as usual) for the rest of the test. */
function failingDb(t, re) {
  const prepare = db.prepare;
  t.mock.method(db, 'prepare', function failing(sql) {
    if (re.test(sql)) throw new Error('database is locked');
    return prepare.call(this, sql);
  });
}

test('later(): on Vercel with SMTP the work is handed to waitUntil and the answer does not wait for it', async (t) => {
  const { later } = require('../../src/later');
  setConfig(t, { onVercel: true, smtp: { host: 'smtp.example.org' } });
  let done = false;
  const r = await later(async () => { await new Promise((ok) => setTimeout(ok, 20)); done = true; return 'sent'; });
  assert.equal(r, undefined, 'resolved before the work finished');
  assert.equal(done, false);
  // A failure in such work is logged, never thrown at the request.
  const errors = t.mock.method(console, 'error', () => {});
  config.onVercel = false;
  assert.equal(await later(() => { throw new Error('smtp down'); }, 'test e-mails'), undefined);
  assert.match(errors.mock.calls[0].arguments[0], /\[later\] test e-mails/);
});

test('errors: no frame for an error from outside the app; recording never throws, even when the database fails', (t) => {
  const errors = require('../../src/errors');
  const outside = new Error('x');
  outside.stack = 'Error: x\n    at f (node:internal/x:1:1)\n    at g (/app/node_modules/lib/index.js:2:3)';
  assert.equal(errors.frame(outside), null);
  assert.equal(errors.frame({}), null);
  const logged = t.mock.method(console, 'error', () => {});
  failingDb(t, /INSERT INTO error_log/);
  assert.doesNotThrow(() => errors.record(new Error('boom')));
  assert.match(logged.mock.calls[0].arguments[0], /could not record the error/);
});

test('timing: a request slower than a second is logged with its database share', (t) => {
  const timing = require('../../src/timing');
  let now = 0n;
  t.mock.method(process.hrtime, 'bigint', () => now);
  const warn = t.mock.method(console, 'warn', () => {});
  const res = { headersSent: false, setHeader() {}, writeHead() { return 'written'; } };
  timing.middleware({ method: 'GET', path: '/slow' }, res, () => {
    timing.track(() => { now += 300_000_000n; }); // a 300 ms query
    now += 1_200_000_000n;
  });
  assert.equal(res.writeHead(200), 'written');
  assert.match(warn.mock.calls[0].arguments[0], /^\[slow\] GET \/slow 1500 ms \(database 300 ms, 1 queries\)/);
});

test('redirect guard: a malformed loop cookie counts as no loop', () => {
  const { guard } = require('../../src/redirect-guard');
  const sent = [];
  const res = { redirect: (...a) => sent.push(a), cookie: (k, v) => sent.push(['cookie', k, JSON.parse(Buffer.from(v, 'base64url'))]), set() {} };
  guard({ method: 'GET', path: '/x', cookies: { rloop: 'bm90IGpzb24' /* "not json" */ } }, res, () => {});
  res.redirect('/y');
  assert.equal(sent[0][2].n, 1, 'counting starts again');
  assert.deepEqual(sent[1], ['/y']);
});

test('Google relay: a state whose target is not an address is this site\'s own', () => {
  const { relayTarget } = require('../../src/google');
  assert.equal(relayTarget(`r.${Buffer.from('not an address').toString('base64url')}.${'a'.repeat(20)}`), null);
  assert.equal(relayTarget(`r.${Buffer.from('ftp://files.example.org').toString('base64url')}.${'a'.repeat(20)}`), null);
});

test('mail: a failed count or outbox write never fails the send; the SMTP check without SMTP; the last failure', async (t) => {
  const mail = require('../../src/mail');
  const logged = t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  await mail.verifyTransport();
  // SMTP that "sends" without a network (nodemailer's JSON transport), and a database refusing the bookkeeping.
  setConfig(t, { smtp: { jsonTransport: true } });
  failingDb(t, /INSERT INTO mail_daily|INSERT INTO mail_outbox/);
  assert.equal(await mail.send('a@test.org', 'with a key', ['x'], null, { key: 'edge:1' }), true);
  assert.ok(logged.mock.calls.some((c) => /could not count the message/.test(c.arguments[0])));
  assert.ok(logged.mock.calls.some((c) => /could not record the message in the outbox/.test(c.arguments[0])));
  db.prepare.mock.restore();

  // The last failure: from the action log (another instance may have hit it).
  config.smtp = null;
  assert.equal(mail.status().lastError, null);
  db.prepare("INSERT INTO audit_log (action, details, at) VALUES ('mail.failed', 'x → y: refused', '2020-01-01 10:00:00')").run();
  const s = mail.status();
  assert.equal(s.lastError.message, 'x → y: refused');
  assert.equal(s.lastError.at.getFullYear(), 2020);
  failingDb(t, /FROM audit_log/);
  assert.equal(mail.status().lastError, null, 'a database error is no failure to show');
});

test('push: removing every device; a push service that can\'t be reached; a database error while notifying', async (t) => {
  const push = require('../../src/push');
  const u = createUser();
  const sub = (n) => ({ endpoint: `https://push.example.org/${n}`, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } });
  push.subscribe(u.id, sub(1), 'ua');
  push.subscribe(u.id, sub(2), 'ua');
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  assert.equal(await push.notify(u.id, { title: 'x' }), 0, 'nothing delivered, nothing thrown');
  assert.equal(push.devices(u.id).length, 2, 'an unreachable service does not forget the devices');
  assert.equal(push.unsubscribe(u.id), true);
  assert.equal(push.devices(u.id).length, 0);
  assert.equal(push.unsubscribe(u.id), false);
  t.mock.method(console, 'error', () => {});
  failingDb(t, /FROM push_subscriptions WHERE user_id IN/);
  assert.equal(await push.notify(u.id, { title: 'x' }), 0);
});

test('passkeys: an answer the library rejects is a message to show; removing one key', async () => {
  const passkeys = require('../../src/passkeys');
  const u = createUser();
  const req = { hostname: 'localhost', protocol: 'http', get: () => 'localhost:3000' };
  const reg = await passkeys.registrationOptions(req, u);
  await assert.rejects(passkeys.register(req, u, reg.token, '{"id":"abc","response":{}}', 'phone'), /^Error: המפתח לא נשמר: /);

  db.prepare("INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES ('key-1', ?, 'AAAA', 0, '[\"usb\"]', 'phone', '2026-01-01 10:00')").run(u.id);
  const auth = await passkeys.authenticationOptions(req, u, 'reauth');
  await assert.rejects(passkeys.authenticate(req, auth.token, '{"id":"key-1","response":{}}', 'reauth'), /^Error: האימות נכשל: /);

  assert.equal(passkeys.remove(u.id, 'nope', u.id), false);
  assert.equal(passkeys.remove(u.id, 'key-1', u.id), true);
  assert.equal(passkeys.list(u.id).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.passkey_remove' AND target_id = ?").get(u.id).n, 1);
});

test('provisioning: a provider that does not answer gives a clear error with the address (no query string)', async () => {
  const { api } = require('../../src/provision');
  const call = api(async () => { throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.turso.tech') }); }, 'https://api.turso.tech/v1', 't');
  await assert.rejects(call('GET', '/organizations/x?secret=1'), /^Error: GET https:\/\/api\.turso\.tech\/v1\/organizations\/x → no answer: getaddrinfo ENOTFOUND/);
  const plain = api(async () => { throw new Error('socket hang up'); }, 'https://api.vercel.com', 't');
  await assert.rejects(plain('POST', '/v9/projects'), /no answer: socket hang up/);
});

test('scheduled jobs on a normal server: run at once, then on a timer; a failing run is logged and recorded', async (t) => {
  const jobs = require('../../src/jobs');
  const timer = jobs.startJobs(60_000);
  clearInterval(timer);
  await new Promise((ok) => setTimeout(ok, 50)); // let the first run finish
  assert.ok(jobs.lastRun());
  const logged = t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  failingDb(t, /FROM bookings/);
  clearInterval(jobs.startJobs(60_000));
  await new Promise((ok) => setTimeout(ok, 50));
  assert.ok(logged.mock.calls.some((c) => c.arguments[0] === '[jobs]'));
  db.prepare.mock.restore();
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM error_log WHERE where_ = 'jobs'").get().n >= 1);
});

test('hosted driver: a read that fails on a stale connection after the statement was prepared is tried once more', (t) => {
  const { wrapLibsql } = require('../../src/driver');
  t.mock.method(console, 'warn', () => {});
  let opened = 0;
  let failNext = true;
  const conn = { exec() {}, prepare: () => ({ get: () => { if (failNext) { failNext = false; throw new Error('STREAM_EXPIRED'); } return { n: opened }; }, all: () => [], run: () => ({}) }) };
  const hosted = wrapLibsql(() => { opened += 1; return conn; });
  // The statement is prepared again (on a new connection only if preparing fails too) and the read repeated once.
  assert.deepEqual(hosted.prepare('SELECT 1').get(), { n: 1 });
  // Inside a transaction the same failure is not hidden.
  failNext = true;
  hosted.exec('BEGIN');
  assert.throws(() => hosted.prepare('SELECT 1').get(), /STREAM_EXPIRED/);
  hosted.exec('ROLLBACK');
});
