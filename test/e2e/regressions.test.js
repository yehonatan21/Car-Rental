'use strict';
// Problems seen on the live site, replayed so they cannot come back unnoticed. Every flow follows its redirects the
// way a browser does and must end on a real page within a few hops (never ERR_TOO_MANY_REDIRECTS, never a crash).
const { db, createUser, inDays, startServer, Client, nextIdNumber } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../../src/config');

const root = path.join(__dirname, '..', '..');
let srv, admin;

before(async () => {
  srv = await startServer();
  createUser({ role: 'admin', email: 'admin@reg.test' });
  admin = new Client(srv.base);
  await admin.login('admin@reg.test');
});
after(() => srv.close());

/**
 * Follows redirects from `first` (a response) like a browser: GET each Location, at most `max` hops, and returns the
 * hops plus the final response. `clients` take turns per hop, to imitate two deployments answering one browser.
 */
async function follow(first, clients, max = 6) {
  const hops = [];
  let r = first;
  for (let i = 0; r.status >= 300 && r.status < 400; i++) {
    assert.ok(i < max, `redirect loop: ${hops.join(' → ')}`);
    const url = r.location.replace(/#.*/, '');
    hops.push(url);
    r = await clients[i % clients.length].get(url);
  }
  return { r, hops };
}

/** A flow must end on a real page: a 200 page, or the login form shown in place (401). Never an error or a loop. */
async function landsOn(first, clients = [admin]) {
  const { r, hops } = await follow(first, clients);
  const loginForm = r.status === 401 && /action="\/login"/.test(r.text);
  assert.ok(r.status === 200 || loginForm, `ended with ${r.status} after ${hops.join(' → ')}`);
  return { page: r.text, hops, status: r.status };
}

test('test e-mail: back on the settings page with a message, whatever the mail server does', async () => {
  const saved = config.smtp;
  try {
    for (const [smtp, expected] of [
      [null, /לא נשלח/], // no mail server configured
      [{ host: '127.0.0.1', port: 9, secure: false, connectionTimeout: 2000, greetingTimeout: 2000, socketTimeout: 2000 }, /נכשלה/], // server down
    ]) {
      config.smtp = smtp;
      const r = await admin.post('/admin/settings/test-email', {}, '/admin/settings');
      const { page, hops } = await landsOn(r);
      assert.deepEqual(hops, ['/admin/settings']);
      assert.match(page, /מערכת ונתונים/, 'the settings page itself renders');
      assert.match(admin.flash()?.text || page, expected);
    }
  } finally {
    config.smtp = saved;
  }
});

test('manual booking: its page opens right after it is created', async () => {
  const u = createUser({ email: 'manual-reg@reg.test' });
  const r = await admin.post('/admin/bookings/new', { user_id: String(u.id), start: inDays(4, '09:00'), end: inDays(4, '12:00'), notify: '1' },
    '/admin/bookings/new');
  const b = db.prepare('SELECT id FROM bookings WHERE user_id = ?').get(u.id);
  assert.ok(b, 'created');
  const { page, hops } = await landsOn(r);
  assert.deepEqual(hops, [`/admin/bookings/${b.id}`]);
  assert.match(page, new RegExp(`הזמנה #${b.id}`));
});

test('new reservation page opens (signed in, and with a login from another deployment)', async () => {
  const url = `/admin/bookings/new?start=${encodeURIComponent(inDays(1, '13:51'))}`;
  assert.match((await landsOn(await admin.get(url))).page, /הזמנה ידנית/);
  const stale = new Client(srv.base);
  stale.cookies.sid = 'a-token-only-another-database-knows';
  const { page, hops, status } = await landsOn(await stale.get(url), [stale]);
  assert.deepEqual(hops, [], 'no redirect at all: the login form is shown in place');
  assert.equal(status, 401);
  assert.match(page, /התחברות/);
  assert.ok(page.includes(`name="next" value="${url.replace(/&/g, '&amp;')}"`), 'and continues to the page after signing in');
  assert.equal(stale.cookies.sid, undefined, 'the unknown login cookie is removed');
});

test('two deployments with separate databases answering in turn: no redirect loop', async () => {
  // A second server with its own, empty database, like the next deployment while the old one still answers.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-other-'));
  const other = spawn(process.execPath, ['--no-warnings', '-e',
    "require('./src/server').start({ port: 0, jobs: false }).then((s) => console.log('PORT ' + s.address().port))"],
  { cwd: root, env: { PATH: process.env.PATH, HTTPS: 'false', DATA_DIR: tmp, TZ: 'Asia/Jerusalem' } });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = '';
      other.stdout.on('data', (d) => { out += d; const m = /PORT (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
      other.on('exit', (code) => reject(new Error('other server exited ' + code)));
    });
    // One browser (one cookie jar), signed in on the current deployment.
    const here = new Client(srv.base);
    await here.login('admin@reg.test');
    const there = new Client(`http://127.0.0.1:${port}`);
    there.cookies = here.cookies;
    for (const url of ['/admin/settings', '/admin', `/admin/bookings/new?start=${encodeURIComponent(inDays(1, '10:00'))}`]) {
      const { page } = await landsOn(await there.get(url), [here, there]);
      assert.match(page, /התחברות|לוח בקרה|הגדרות|הזמנה ידנית/);
    }
  } finally {
    other.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an old or mistyped link lands on the main page, signed in or not', async () => {
  for (const c of [admin, new Client(srv.base)]) {
    for (const url of ['/admin/bookings/999999', '/admin/users/999999', '/no-such-page']) {
      await landsOn(await c.get(url), [c]);
    }
  }
});

test('first start of several instances at once on a new hosted database', { skip: !process.env.SQLD_BIN && 'needs SQLD_BIN' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-race-'));
  const port = 30000 + (process.pid % 20000);
  const sqld = spawn(process.env.SQLD_BIN, ['--http-listen-addr', `127.0.0.1:${port}`, '--db-path', path.join(tmp, 'db')], { stdio: 'ignore' });
  try {
    const url = `http://127.0.0.1:${port}`;
    const Database = require('libsql');
    for (let i = 0; ; i++) {
      try { new Database(url, {}).prepare('SELECT 1').get([]); break; } catch { assert.ok(i < 300, 'sqld did not start'); await new Promise((r) => setTimeout(r, 100)); }
    }
    const env = (i) => ({ PATH: process.env.PATH, TZ: 'Asia/Jerusalem', DATA_DIR: path.join(tmp, `d${i}`), TURSO_DATABASE_URL: url,
      ADMIN_EMAIL: 'boss@race.test', ADMIN_PASSWORD: 'RaceAdmin1' });
    const codes = await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((resolve) => {
      spawn(process.execPath, ['--no-warnings', '-e', "require('./src/server')"], { cwd: root, env: env(i), stdio: 'ignore' }).on('exit', resolve);
    })));
    assert.deepEqual(codes, [0, 0, 0, 0, 0, 0], 'every instance started');
    const check = new Database(url, {});
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'boss@race.test'").get([]).n, 1);
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM vehicles').get([]).n, 1);
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM policies').get([]).n, 1);
  } finally {
    sqld.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('registration still works end to end after all of the above', async () => {
  const c = new Client(srv.base);
  const fd = new FormData();
  for (const [k, v] of Object.entries({ first_name: 'נטע', last_name: 'בר', id_number: nextIdNumber(), phone: '0541234567',
    email: 'reg-flow@reg.test', password: 'Password123', license_expiry: inDays(400).slice(0, 10), accept_policy: '1', accept_privacy: '1',
    policy_version: '1' })) fd.set(k, v);
  fd.set('license', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'license.png');
  const { page } = await landsOn(await c.post('/register', fd), [c]);
  assert.match(page, /ממתין/);
});

test('adding a user: the browser lands on the new user card', async () => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ first_name: 'יעל', last_name: 'שחר', id_number: nextIdNumber(), phone: '0527654321',
    email: 'added@reg.test', role: 'user', send_invite: '1' })) fd.set(k, v);
  const { page, hops } = await landsOn(await admin.post('/admin/users/new', fd, '/admin/users/new'));
  const u = db.prepare("SELECT id FROM users WHERE email = 'added@reg.test'").get();
  assert.deepEqual(hops, [`/admin/users/${u.id}`]);
  assert.match(page, /יעל שחר/);
});

test('never a bare "Not found": a form re-sent to a page address, or an action on a deleted user, goes home', async () => {
  const token = await admin.csrf('/admin/users');
  for (const url of ['/admin/users/2', '/admin/users/999999/block', '/no-such-form']) {
    const r = await admin.req('POST', url, { _csrf: token });
    assert.equal(r.status, 303, url);
    assert.equal(r.location, '/', url);
    assert.doesNotMatch(r.text, /^Not found$/);
    await landsOn(r);
  }
  // A missing file is still a plain 404 (an <img> or stylesheet must not receive a whole page).
  assert.equal((await admin.get('/static/nope.png')).status, 404);
});

test('redirects are never stored by the browser or the CDN', async () => {
  const r = await admin.post('/admin/settings/test-email', {}, '/admin/settings');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  await landsOn(r);
});

test('a login cookie that is not recognised is logged with the reason (and nothing secret)', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const c = new Client(srv.base);
  c.cookies.sid = 'not-a-real-session-token';
  const r = await c.get('/admin/settings');
  assert.equal(r.status, 401);
  const line = warn.mock.calls.map((x) => x.arguments[0]).find((m) => /\[session\]/.test(m));
  assert.match(line, /login cookie not recognised \(unknown\) on GET \/admin\/settings/);
  assert.doesNotMatch(line, /not-a-real-session-token/);
});
