'use strict';
// The server's own safety nets, as on Vercel: the jobs run on a visit when no scheduled run happened, and a failure
// there never fails the visit; an unexpected error in a page is a friendly 500 page and is recorded.
process.env.VERCEL = '1'; // DATA_DIR is set by the helpers, so this is not a temporary database
const { db, createUser, startServer, Client } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let srv;
before(async () => { srv = await startServer(); });
after(() => { delete process.env.VERCEL; return srv.close(); });

test('on Vercel a visit runs the overdue jobs; when that fails the visit still gets its page', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  const prepare = db.prepare;
  t.mock.method(db, 'prepare', function failing(sql) {
    if (/FROM job_state/.test(sql)) throw new Error('database is locked');
    return prepare.call(this, sql);
  });
  const r = await new Client(srv.base).get('/login');
  assert.equal(r.status, 200);
  db.prepare.mock.restore();
  assert.ok(errors.mock.calls.some((c) => c.arguments[0] === '[jobs]'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM error_log WHERE where_ = 'jobs'").get().n, 1);
});

test('an unexpected error in a page: a 500 page without details, and the error is recorded with its route', async (t) => {
  const u = createUser();
  const c = new Client(srv.base);
  await c.login(u.email);
  t.mock.method(console, 'error', () => {});
  const prepare = db.prepare;
  t.mock.method(db, 'prepare', function failing(sql) {
    if (/FROM bookings WHERE user_id = \? AND kind = 'booking' AND end_at > \?/.test(sql)) throw new Error('disk I/O error');
    return prepare.call(this, sql);
  });
  const r = await c.get('/me');
  db.prepare.mock.restore();
  assert.equal(r.status, 500);
  assert.match(r.text, /אירעה שגיאה/);
  assert.doesNotMatch(r.text, /disk I\/O/);
  const e = db.prepare("SELECT * FROM error_log WHERE message = 'disk I/O error'").get();
  assert.equal(e.route, 'GET /me');
  assert.equal(e.where_, 'request');
});
