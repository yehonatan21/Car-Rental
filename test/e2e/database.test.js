'use strict';
// Database scenarios from the live site, with real app instances side by side on one database (local file, or the
// hosted libSQL server when SQLD_BIN is set): a new version starting on the data of the previous one, two versions
// answering at the same time during a release, and two admins acting at the same moment on different instances.
const { db, dataDir, createUser, inDays, startServer, Client, PNG, putStoredFile } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { storageInfo, setSetting, getSettings } = require('../../src/db');

const root = path.join(__dirname, '..', '..');
const hosted = Boolean(process.env.TURSO_DATABASE_URL);
const others = [];
let srv;

before(async () => {
  srv = await startServer();
  createUser({ role: 'admin', email: 'admin@db.test' });
});
after(async () => {
  for (const o of others) o.stop();
  await srv.close();
});

/**
 * Another instance of the app on the same database, in its own process: like the next deployment, or a second
 * Vercel instance. With a hosted database it also gets an empty temporary disk, as on Vercel.
 */
async function anotherInstance() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'db-inst-'));
  const child = spawn(process.execPath, ['--no-warnings', '-e',
    "require('./src/server').start({ port: 0, jobs: false }).then((s) => console.log('PORT ' + s.address().port))"], {
    cwd: root,
    env: { PATH: process.env.PATH, HTTPS: 'false', TZ: 'Asia/Jerusalem', DATA_DIR: hosted ? tmp : dataDir,
      TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL || '' },
  });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; const m = /PORT (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    child.on('exit', (code) => reject(new Error(`instance exited ${code}: ${log}`)));
  });
  const inst = {
    base: `http://127.0.0.1:${port}`,
    stop: () => { child.kill(); fs.rmSync(tmp, { recursive: true, force: true }); },
  };
  others.push(inst);
  return inst;
}

/** A browser: one cookie jar, talking to whichever instance answers. */
function browser(...bases) {
  const clients = bases.map((b) => new Client(b));
  for (const c of clients.slice(1)) c.cookies = clients[0].cookies;
  return clients;
}

function pendingRequest(email, start, end) {
  const u = createUser({ email });
  return Number(db.prepare(`INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status, created_by, created_at)
    VALUES (1, ?, ?, ?, 'pending', ?, ?)`).run(u.id, start, end, u.id, '2026-01-01 10:00:00').lastInsertRowid);
}
const statusOf = (id) => db.prepare('SELECT status FROM bookings WHERE id = ?').get(id).status;

test('a new version on the same database keeps everything, including the login', async () => {
  const [here] = browser(srv.base);
  await here.login('admin@db.test');
  const u = createUser({ email: 'keeps@db.test', first_name: 'שמורה', license_file: 'keeps.png' });
  putStoredFile('keeps.png', PNG);
  const b = pendingRequest('keeps-booker@db.test', inDays(9, '09:00'), inDays(9, '11:00'));
  setSetting('buffer_minutes', 17);
  db.prepare("UPDATE vehicles SET plate = '77-777-77' WHERE id = 1").run();
  await here.post('/admin/policies', { content: '# נהלים מעודכנים\n\n- כלל חדש' }, '/admin/policies');
  const before = storageInfo();

  const next = await anotherInstance();
  const [there] = browser(next.base);
  there.cookies = here.cookies; // the same browser, after the new version went live
  const dashboard = await there.get('/admin');
  assert.equal(dashboard.status, 200, 'still signed in: the session is in the database');
  assert.match((await there.get(`/admin/users/${u.id}`)).text, /שמורה/);
  const license = await there.get(`/admin/users/${u.id}/license`);
  assert.equal(license.status, 200);
  assert.deepEqual(Buffer.from(await (await fetch(`${next.base}/admin/users/${u.id}/license`, {
    headers: { cookie: `sid=${here.cookies.sid}` } })).arrayBuffer()), PNG, 'license image stored with the data');
  assert.match((await there.get(`/admin/bookings/${b}`)).text, new RegExp(`הזמנה #${b}`));
  assert.match((await there.get('/admin/settings')).text, /value="17"/);
  assert.match((await there.get('/admin/vehicle')).text, /77-777-77/);
  assert.match((await there.get('/policy')).text, /נהלים מעודכנים/);
  const health = JSON.parse((await there.get('/healthz')).text);
  assert.equal(health.storage.id, before.id, 'same database id: the same database, not a new one');
  next.stop();
});

test('two versions answering at once on one database: logins and bookings are shared', async () => {
  const other = await anotherInstance();
  const [a, b] = browser(srv.base, other.base);
  await a.login('admin@db.test');
  assert.equal((await b.get('/admin/bookings')).status, 200, 'signed in on the other instance too');

  const u = createUser({ email: 'shared@db.test' });
  const r = await b.post('/admin/bookings/new', { user_id: String(u.id), start: inDays(12, '09:00'), end: inDays(12, '10:00'), notify: '1' },
    '/admin/bookings/new');
  const id = Number(/\/admin\/bookings\/(\d+)$/.exec(r.location)?.[1]);
  assert.ok(id, `created on the other instance (${r.location})`);
  assert.equal((await a.get(`/admin/bookings/${id}`)).status, 200, 'and visible here at once');
  assert.equal(statusOf(id), 'approved');
  // Alternate between the two for a while: never a redirect, never signed out.
  for (let i = 0; i < 6; i++) assert.equal((await [a, b][i % 2].get('/admin/settings')).status, 200);
});

test('two admins approving overlapping requests on different instances at the same moment: one wins', async () => {
  const other = await anotherInstance();
  for (let round = 0; round < 3; round++) {
    const day = 20 + round;
    const x = pendingRequest(`race-x${round}@db.test`, inDays(day, '09:00'), inDays(day, '12:00'));
    const y = pendingRequest(`race-y${round}@db.test`, inDays(day, '10:00'), inDays(day, '13:00'));
    const [a] = browser(srv.base);
    const [b] = browser(other.base);
    await a.login('admin@db.test');
    await b.login('admin@db.test');
    const [ta, tb] = [await a.csrf(`/admin/bookings/${x}`), await b.csrf(`/admin/bookings/${y}`)];
    await Promise.all([
      a.req('POST', `/admin/bookings/${x}/approve`, { _csrf: ta }),
      b.req('POST', `/admin/bookings/${y}/approve`, { _csrf: tb }),
    ]);
    const statuses = [statusOf(x), statusOf(y)].sort();
    assert.deepEqual(statuses, ['approved', 'pending'], `round ${round}: never both approved (double booking)`);
  }
});

test('the same request approved twice at once is recorded once', async () => {
  const other = await anotherInstance();
  const id = pendingRequest('twice@db.test', inDays(30, '09:00'), inDays(30, '10:00'));
  const [a] = browser(srv.base);
  const [b] = browser(other.base);
  await a.login('admin@db.test');
  await b.login('admin@db.test');
  const [ta, tb] = [await a.csrf(`/admin/bookings/${id}`), await b.csrf(`/admin/bookings/${id}`)];
  await Promise.all([
    a.req('POST', `/admin/bookings/${id}/approve`, { _csrf: ta }),
    b.req('POST', `/admin/bookings/${id}/approve`, { _csrf: tb }),
  ]);
  assert.equal(statusOf(id), 'approved');
  const approvals = db.prepare("SELECT COUNT(*) AS n FROM booking_history WHERE booking_id = ? AND to_status = 'approved'").get(id).n;
  assert.equal(approvals, 1);
});

test('a refused booking leaves nothing half-saved', async () => {
  const [a] = browser(srv.base);
  await a.login('admin@db.test');
  const u = createUser({ email: 'refused@db.test' });
  db.prepare('DELETE FROM policy_acceptances WHERE user_id = ?').run(u.id); // cannot book yet
  const counts = () => [db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, db.prepare('SELECT COUNT(*) AS n FROM booking_history').get().n];
  const before = counts();
  const r = await a.post('/admin/bookings/new', { user_id: String(u.id), start: inDays(14, '14:10'), end: inDays(14, '17:00'), notify: '1' },
    '/admin/bookings/new');
  assert.match(r.location, /^\/admin\/bookings\/new\?start=/);
  assert.match(a.flash().text, /נהלי השאלת הרכב/);
  assert.deepEqual(counts(), before);
  assert.equal((await a.get(r.location)).status, 200, 'the form opens again with the reason');
});

test('an older database is upgraded in place on start, without losing data', async () => {
  const u = createUser({ email: 'old-db@db.test', first_name: 'ותיקה' });
  const id = storageInfo().id;
  // Make the database look like one from before the latest changes.
  db.exec('DROP TABLE app_meta');
  db.exec('DROP INDEX IF EXISTS users_google_sub');
  db.exec('ALTER TABLE users DROP COLUMN google_sub');
  const next = await anotherInstance();
  const [c] = browser(next.base);
  await c.login('admin@db.test');
  assert.match((await c.get(`/admin/users/${u.id}`)).text, /ותיקה/, 'data kept');
  assert.ok(db.prepare('PRAGMA table_info(users)').all().some((col) => col.name === 'google_sub'), 'column added back');
  const meta = JSON.parse((await c.get('/healthz')).text).storage;
  assert.match(meta.id, /^[0-9a-f]{8}$/, 'database id recorded again');
  assert.notEqual(meta.id, id, 'a database without an id gets a new one');
  assert.equal(getSettings().buffer_minutes >= 0, true);
  next.stop();
});
