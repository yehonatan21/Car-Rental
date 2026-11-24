'use strict';
// Fewer round trips to the database: the setup runs only when db.js changed, the session and its user come in one
// query, and every response says how long the database took (Server-Timing).
const { db, createUser, startServer, Client } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

test('the database remembers which setup it has, so the next start skips it', () => {
  const v = db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get()?.value;
  const expected = crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, '../../src/db.js'))).digest('hex').slice(0, 16);
  assert.equal(v, expected);
});

test('Server-Timing: database time, number of queries and total time', async () => {
  const r = await fetch(srv.base + '/login');
  assert.match(r.headers.get('server-timing'), /^db;dur=\d+(\.\d)?;desc="\d+ quer(y|ies)", total;dur=\d+(\.\d)?$/);
});

test('one query loads the session and its user; expired and unknown sessions are told apart', async () => {
  const u = createUser({ email: 'perf@test.org' });
  const c = new Client(srv.base);
  await c.login('perf@test.org');
  const page = await fetch(srv.base + '/me', { headers: { cookie: `sid=${c.cookies.sid}` }, redirect: 'manual' });
  assert.equal(page.status, 200, 'signed in');
  assert.match(page.headers.get('server-timing'), /desc="\d+ quer/);
  db.prepare('UPDATE sessions SET expires_at = 1 WHERE user_id = ?').run(u.id);
  const gone = await fetch(srv.base + '/me', { headers: { cookie: `sid=${c.cookies.sid}` }, redirect: 'manual' });
  assert.equal(gone.status, 401, 'an expired session is signed out: the login form is shown in place');
  assert.match(gone.headers.get('set-cookie') || '', /sid=;/, 'and the stale cookie is cleared');
});

test('"my bookings" makes the same number of queries for 1 booking and for 40 (no query per row)', async () => {
  const { inDays } = require('../helpers');
  const u = createUser({ email: 'many-bookings@test.org' });
  const c = new Client(srv.base);
  await c.login(u.email);
  const queries = async () => Number(/desc="(\d+) quer/.exec((await c.get('/me/bookings')).headers.get('server-timing'))[1]);
  const add = (n, from) => {
    for (let i = 0; i < n; i++) {
      db.prepare("INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status) VALUES (1, ?, ?, ?, 'approved')")
        .run(u.id, inDays(from + i), inDays(from + i, '12:00'));
    }
  };
  add(1, -50); // one past booking
  const one = await queries();
  add(20, -40); // more history
  add(19, 2); // and upcoming ones, with their cancel buttons
  assert.equal(await queries(), one);
});
