'use strict';
// R2 security hardening: multipart forms and the CSRF check (SEC-004), files that are what they claim (SEC-008),
// registration attempts per address, malformed cookies (SEC-013), /healthz in production (SEC-014), safe redirects
// (SEC-011), the console's client addresses (SEC-007) and deleting rejected registrations' photos after 30 days.
const { db, createUser, startServer, Client, PNG, registrationForm, storedFileCount, putStoredFile } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../src/config');
const time = require('../../src/time');

let srv, admin;
before(async () => {
  srv = await startServer();
  createUser({ role: 'admin', email: 'r2-admin@test.org' });
  admin = new Client(srv.base);
  await admin.login('r2-admin@test.org');
});
after(() => srv.close());

const cookieOf = (c) => Object.entries(c.cookies).map(([k, v]) => `${k}=${v}`).join('; ');

test('SEC-004: a multipart POST to an address without an upload is refused; from another site, refused before storing', async () => {
  const victim = createUser({ email: 'victim@test.org' });
  const fd = new FormData();
  fd.set('note', 'x');
  // The old hole: "block this user" sent as multipart skipped the token check.
  let r = await fetch(`${srv.base}/admin/users/${victim.id}/block`, { method: 'POST', body: fd, headers: { cookie: cookieOf(admin) }, redirect: 'manual' });
  assert.equal(r.status, 415);
  assert.equal(db.prepare('SELECT status FROM users WHERE id = ?').get(victim.id).status, 'active', 'not blocked');

  const files = storedFileCount();
  const upload = new FormData();
  upload.set('license', new Blob([PNG], { type: 'image/png' }), 'x.png');
  r = await fetch(`${srv.base}/me/license`, { method: 'POST', body: upload, headers: { cookie: cookieOf(admin), origin: 'https://evil.example' }, redirect: 'manual' });
  assert.equal(r.status, 403);
  r = await fetch(`${srv.base}/me/license`, { method: 'POST', body: upload, headers: { cookie: cookieOf(admin), 'sec-fetch-site': 'cross-site' }, redirect: 'manual' });
  assert.equal(r.status, 403, 'no Origin, but the browser says it came from another site');
  assert.equal(storedFileCount(), files, 'nothing stored');

  // A urlencoded POST without Origin from another site (Fetch Metadata) is refused too.
  r = await fetch(`${srv.base}/admin/users/${victim.id}/block`, { method: 'POST', body: 'note=x',
    headers: { cookie: cookieOf(admin), 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' }, redirect: 'manual' });
  assert.equal(r.status, 403);
});

test('SEC-008: a file that is not really an image or PDF is deleted and refused', async () => {
  const files = storedFileCount();
  const c = new Client(srv.base);
  const r = await c.post('/register', registrationForm({ licenseBlob: new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), licenseName: 'fake.png' }), '/register');
  assert.equal(r.status, 303);
  assert.match(c.flash().text, /אינו תמונה או PDF תקינים/);
  assert.equal(storedFileCount(), files, 'the fake file is gone');
  // A real PDF passes the check.
  const pdf = new Blob(['%PDF-1.4\n%…\n'], { type: 'application/pdf' });
  const c2 = new Client(srv.base);
  await c2.post('/register', registrationForm({ licenseBlob: pdf, licenseName: 'license.pdf', email: 'real-pdf@test.org' }), '/register');
  assert.doesNotMatch(c2.flash()?.text || '', /אינו תמונה או PDF/, 'not bounced by the file check');
  assert.ok(db.prepare("SELECT 1 FROM users WHERE email = 'real-pdf@test.org'").get(), 'registered');
});

test('registration: at most 20 attempts an hour from one address, and the refused file is not kept', async () => {
  db.prepare("DELETE FROM throttle WHERE key LIKE 'register:%'").run();
  const c = new Client(srv.base);
  for (let i = 0; i < 20; i++) await c.post('/register', registrationForm({ license: null, first_name: '' }), '/register');
  const files = storedFileCount();
  const r = await c.post('/register', registrationForm(), '/register');
  assert.equal(r.status, 429);
  assert.match(r.text, /יותר מדי ניסיונות הרשמה/);
  assert.equal(storedFileCount(), files);
  db.prepare("DELETE FROM throttle WHERE key LIKE 'register:%'").run();
});

test('SEC-013: a malformed cookie is ignored, not a 500', async () => {
  const r = await fetch(srv.base + '/login', { headers: { cookie: 'sid=%E0%A4%A; flash=%' } });
  assert.equal(r.status, 200);
});

test('SEC-014: in production /healthz says only "ok", unless asked with the cron secret', async () => {
  const saved = config.production;
  config.production = true;
  process.env.CRON_SECRET = 'h'.repeat(32);
  try {
    assert.deepEqual(await (await fetch(srv.base + '/healthz')).json(), { status: 'ok' });
    const full = await (await fetch(srv.base + '/healthz', { headers: { authorization: `Bearer ${'h'.repeat(32)}` } })).json();
    assert.ok(full.storage, 'details with the secret');
  } finally {
    config.production = saved;
    delete process.env.CRON_SECRET;
  }
});

test('SEC-011: an upload error goes back only to this site\'s pages', async () => {
  const big = new FormData();
  big.set('license', new Blob([Buffer.alloc(config.uploadMaxBytes + 10)], { type: 'image/png' }), 'big.png');
  const r = await fetch(srv.base + '/register', { method: 'POST', body: big, headers: { referer: 'https://evil.example/phish' }, redirect: 'manual' });
  assert.ok([302, 303].includes(r.status));
  assert.equal(r.headers.get('location'), '/', 'not to the other site');
});

test('SEC-007: the console only talks to public https sites', () => {
  const master = require('../../src/master');
  const saved = config.production;
  config.production = true;
  try {
    for (const bad of ['http://site.example', 'https://10.0.0.5', 'https://[::1]', 'https://127.0.0.1', 'https://localhost',
      'https://intranet', 'https://db.internal', 'https://x.local', 'https://site.example:8443']) {
      assert.equal(master.normalizeUrl(bad), null, bad);
    }
    assert.equal(master.normalizeUrl('car-rental-x.vercel.app'), 'https://car-rental-x.vercel.app');
  } finally {
    config.production = saved;
  }
  assert.equal(master.normalizeUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000', 'local test sites outside production');
});

test('a rejected registration\'s license photo is deleted 30 days after the rejection', async () => {
  putStoredFile('rejected-old.png', 'x');
  putStoredFile('rejected-new.png', 'x');
  const old = createUser({ email: 'rej-old@test.org', status: 'rejected', license_file: 'rejected-old.png' });
  const recent = createUser({ email: 'rej-new@test.org', status: 'rejected', license_file: 'rejected-new.png' });
  db.prepare('UPDATE users SET rejected_at = ? WHERE id = ?').run(time.stamp(new Date(Date.now() - 31 * 86400000)), old.id);
  db.prepare('UPDATE users SET rejected_at = ? WHERE id = ?').run(time.stamp(new Date(Date.now() - 5 * 86400000)), recent.id);
  await require('../../src/jobs').runJobs({ by: 'timer' });
  assert.equal(db.prepare('SELECT license_file FROM users WHERE id = ?').get(old.id).license_file, null);
  assert.equal(require('../../src/storage').read('rejected-old.png'), null, 'the file is gone');
  assert.equal(db.prepare('SELECT license_file FROM users WHERE id = ?').get(recent.id).license_file, 'rejected-new.png', 'kept until 30 days');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'user.license_deleted' AND target_id = ?").get(old.id));
});
