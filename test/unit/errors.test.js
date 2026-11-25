'use strict';
// Error reporting (src/errors.js): grouped by kind, nothing personal kept, summarised for the console.
const { db } = require('../helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const errors = require('../../src/errors');

const boom = (msg) => { try { throw new TypeError(msg); } catch (e) { return e; } };

test('the same error from the same place is one kind, counted; ids in the message do not split it', () => {
  db.prepare('DELETE FROM error_log').run();
  const req = { method: 'POST', baseUrl: '/admin', path: '/bookings/123/approve' };
  for (const id of [5, 6, 7]) errors.record(boom(`Cannot read properties of undefined (booking ${id})`), { req });
  errors.record(boom('another thing'), { where: 'jobs' });
  errors.flush(); // repeats within a few seconds are counted in memory first (see the burst test below)
  const rows = db.prepare('SELECT * FROM error_log ORDER BY count DESC').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].count, 3);
  assert.equal(rows[0].name, 'TypeError');
  assert.equal(rows[0].route, 'POST /admin/bookings/:id/approve', 'no ids, no query string');
  assert.match(rows[0].frame, /^test\/unit\/errors\.test\.js:\d+$/, 'where in the app\'s code');
  assert.equal(rows[1].where_, 'jobs');
});

test('nothing personal or secret is kept from the message', () => {
  const m = errors.clean("UNIQUE failed for 'dana@example.com' with token eyJabc.def.ghi at libsql://user:pw@db.turso.io phone 0541234567");
  assert.doesNotMatch(m, /dana|example\.com|eyJ|pw@|0541234567/);
  assert.equal(errors.clean('x'.repeat(1000)).length, 300);
  assert.equal(errors.clean("Cannot read properties of undefined (reading 'getTime')"), "Cannot read properties of undefined (reading 'getTime')", 'names in code are kept');
  assert.equal(errors.clean("no such user 'דנה כהן'"), "no such user '…'");
});

test('the summary for the console: kinds in 24 hours, new ones, the latest first; old ones dropped by the jobs', async () => {
  db.prepare('DELETE FROM error_log').run();
  errors.record(boom('fresh one'));
  db.prepare("INSERT INTO error_log (fp, name, message, where_, count, first_at, last_at) VALUES ('old1', 'Error', 'old but again today', 'request', 4, '2020-01-01 00:00:00', ?)")
    .run(require('../../src/time').stamp());
  db.prepare("INSERT INTO error_log (fp, name, message, where_, count, first_at, last_at) VALUES ('old2', 'Error', 'long gone', 'request', 1, '2020-01-01 00:00:00', '2020-01-02 00:00:00')").run();
  const s = errors.summary();
  assert.equal(s.kinds24h, 2);
  assert.equal(s.new24h, 1);
  assert.deepEqual(s.recent.map((r) => r.message).sort(), ['fresh one', 'old but again today']);
  assert.ok(s.recent[0].stack !== undefined);
  await require('../../src/jobs').runJobs();
  assert.equal(db.prepare("SELECT 1 FROM error_log WHERE fp = 'old2'").get(), undefined, 'kept 30 days');
  assert.ok(db.prepare("SELECT 1 FROM error_log WHERE fp = 'old1'").get());
});

test('an error storm is one write per kind: repeats are counted in memory, then written with the next write or flush()', (t) => {
  db.prepare('DELETE FROM error_log').run();
  const writes = [];
  const prepare = db.prepare;
  t.mock.method(db, 'prepare', function recording(sql) { if (/INSERT INTO error_log/.test(sql)) writes.push(sql); return prepare.call(this, sql); });
  const row = (m) => db.prepare('SELECT * FROM error_log WHERE message = ?').get(m);

  for (let i = 0; i < 50; i++) errors.record(boom('storm'), { req: { method: 'GET', baseUrl: '', path: '/me' } });
  assert.equal(writes.length, 1, 'the first one is written at once; the other 49 wait');
  assert.equal(row('storm').count, 1);
  errors.record(boom('a different kind'));
  assert.equal(writes.length, 2, 'a new kind is written at once, storm or not');

  assert.equal(errors.flush(), 49);
  assert.equal(row('storm').count, 50);
  assert.equal(errors.flush(), 0, 'nothing held any more');

  // After the window, the next one is written straight away, with whatever was held since.
  errors.record(boom('storm'));
  const now = Date.now;
  t.mock.method(Date, 'now', () => now.call(Date) + errors.WINDOW_MS + 1);
  errors.record(boom('storm'));
  assert.equal(row('storm').count, 52);
});

test('a database that fails is not asked again by every repeat; nothing is lost once it answers', (t) => {
  db.prepare('DELETE FROM error_log').run();
  const logged = t.mock.method(console, 'error', () => {});
  let failing = true;
  let attempts = 0;
  const prepare = db.prepare;
  t.mock.method(db, 'prepare', function maybeFailing(sql) {
    if (/INSERT INTO error_log/.test(sql)) { attempts += 1; if (failing) throw new Error('database is locked'); }
    return prepare.call(this, sql);
  });
  for (let i = 0; i < 20; i++) errors.record(boom('while down'));
  assert.equal(attempts, 1, 'one attempt, not twenty');
  assert.ok(logged.mock.calls.some((c) => /could not record the error/.test(c.arguments[0])));
  assert.equal(errors.flush(), 0, 'still failing: flush gives up quietly and keeps them');
  assert.ok(logged.mock.calls.some((c) => /could not record held-back errors/.test(c.arguments[0])));
  failing = false;
  assert.equal(errors.flush(), 20);
  const r = db.prepare("SELECT * FROM error_log WHERE message = 'while down'").get();
  assert.equal(r.count, 20, 'all of them, the first one included');
});

test('the scheduled jobs write what is held back', async () => {
  db.prepare('DELETE FROM error_log').run();
  errors.record(boom('between runs'));
  errors.record(boom('between runs'));
  errors.record(boom('between runs'));
  assert.equal(db.prepare("SELECT count FROM error_log WHERE message = 'between runs'").get().count, 1);
  await require('../../src/jobs').runJobs();
  assert.equal(db.prepare("SELECT count FROM error_log WHERE message = 'between runs'").get().count, 3);
});
