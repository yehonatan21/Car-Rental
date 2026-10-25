'use strict';
// Data survives restarts/redeploys, in both storage modes (local file, or hosted libSQL when run with SQLD_BIN).
const { db, createUser, dataDir, startServer, putStoredFile, storedFile } = require('../helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { normalize, cleanRow } = require('../../src/driver');
const storage = require('../../src/storage');
const time = require('../../src/time');

const root = path.join(__dirname, '..', '..');

/** Runs code in a brand-new Node process using the same storage (what a redeploy/restart does). */
function inNewProcess(code) {
  return execFileSync(process.execPath, ['--no-warnings', '-e', code], {
    cwd: root, encoding: 'utf8',
    env: { PATH: process.env.PATH, TZ: 'Asia/Jerusalem', DATA_DIR: dataDir, TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL || '' },
  }).trim();
}

test('users, bookings and license files written now are there after a restart', () => {
  const u = createUser({ email: 'persist@test.org', first_name: 'קבועה', license_file: 'persist.png' });
  putStoredFile('persist.png', 'LICENSE-BYTES');
  db.prepare(`INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status, created_at) VALUES (1, ?, '2027-01-01T10:00', '2027-01-01T12:00', 'approved', ?)`)
    .run(u.id, time.stamp());

  const out = JSON.parse(inNewProcess(`
    const { db } = require('./src/db');
    const storage = require('./src/storage');
    const u = db.prepare("SELECT * FROM users WHERE email = 'persist@test.org'").get();
    const b = db.prepare('SELECT * FROM bookings WHERE user_id = ?').get(u.id);
    db.prepare("UPDATE users SET admin_note = 'written after restart' WHERE id = ?").run(u.id);
    console.log(JSON.stringify({ name: u.first_name, booking: b && b.status, file: String(storage.read(u.license_file)) }));`));
  assert.deepEqual(out, { name: 'קבועה', booking: 'approved', file: 'LICENSE-BYTES' });
  assert.equal(db.prepare('SELECT admin_note FROM users WHERE id = ?').get(u.id).admin_note, 'written after restart');
});

test('license files: stored where the database is (database when hosted), large files in chunks', () => {
  const big = Buffer.alloc(Math.round(2.5 * storage.CHUNK), 7);
  big[0] = 1; big[big.length - 1] = 9;
  const tmp = path.join(require('../../src/config').uploadsDir, 'big.png');
  fs.writeFileSync(tmp, big);
  storage.keep({ path: tmp, filename: 'big.png' });
  assert.ok(storedFile('big.png').equals(big));
  if (db.remote) {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files WHERE name = 'big.png'").get().n, 3, '3 chunks of 1 MB');
    assert.ok(!fs.existsSync(tmp), 'temporary upload removed');
  }
  storage.remove('big.png');
  assert.equal(storedFile('big.png'), null);
});

test('driver: booleans and undefined are normalized; libsql row quirks are cleaned', () => {
  assert.deepEqual(normalize([true, false, undefined, null, 0, 'x']), [1, 0, null, null, 0, 'x']);
  assert.deepEqual(cleanRow({ KEY: 'a', value: 1, _metadata: { duration: 1 } }), { key: 'a', value: 1 });
  assert.equal(cleanRow(undefined), undefined);
  // through the real driver (either mode)
  assert.equal(db.prepare('SELECT ? AS t').get(true).t, 1);
  const row = db.prepare("SELECT key, value FROM settings WHERE key = 'buffer_minutes'").get();
  assert.deepEqual(Object.keys(row), ['key', 'value']);
});

test('timestamps come from the app clock (not the database server, which is UTC when hosted)', () => {
  assert.match(time.stamp(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(time.stamp(new Date(2026, 9, 25, 9, 5, 7)), '2026-10-25 09:05:07');
  const u = createUser();
  const before = time.stamp(new Date(Date.now() - 2000));
  require('../../src/db').audit(u.id, 'test.stamp', 'user', u.id);
  const at = db.prepare("SELECT at FROM audit_log WHERE action = 'test.stamp'").get().at;
  assert.ok(at >= before && at <= time.stamp(), `${at} is local time`);
});

test('no code relies on SQLite\'s datetime(\'now\',\'localtime\') except schema fallbacks', () => {
  const files = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') && files.push(path.join(dir, e.name)));
  walk(path.join(root, 'src'));
  walk(path.join(root, 'scripts'));
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (/datetime\('now'/.test(line) && !/DEFAULT \(datetime|^\s*(\/\/|\*)/.test(line)) assert.fail(`${path.relative(root, f)}: ${line.trim()}`);
    }
  }
});

test('scheduled jobs endpoint for Vercel Cron requires the secret', async () => {
  const srv = await startServer();
  try {
    const call = (auth) => fetch(srv.base + '/internal/cron', { headers: auth ? { authorization: auth } : {} });
    delete process.env.CRON_SECRET;
    assert.equal((await call('Bearer anything')).status, 401, 'disabled without CRON_SECRET');
    process.env.CRON_SECRET = 's3cret-value';
    assert.equal((await call()).status, 401);
    assert.equal((await call('Bearer wrong')).status, 401);
    const ok = await call('Bearer s3cret-value');
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).status, 'ok');
  } finally {
    delete process.env.CRON_SECRET;
    await srv.close();
  }
});
