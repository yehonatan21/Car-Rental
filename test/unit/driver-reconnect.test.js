'use strict';
// The hosted database's connection going stale (src/driver.js): a warm server instance keeps its connection while it
// sits idle, and Turso closes it. Safe steps are tried again on a new connection; writes and transactions are not.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wrapLibsql } = require('../../src/driver');

const STALE = 'Hrana(Http("connection closed before message completed"))';

/** A fake libsql connection: `broken` makes its next network step fail like a closed connection. */
function fakeConnections() {
  const made = [];
  const open = () => {
    const c = {
      id: made.length + 1, broken: false, log: [],
      fail() { if (c.broken) throw new Error(STALE); },
      exec(sql) { c.fail(); c.log.push(sql); },
      prepare(sql) {
        c.fail();
        return {
          get: () => { c.fail(); c.log.push(`get ${sql}`); return { n: c.id }; },
          all: () => { c.fail(); c.log.push(`all ${sql}`); return [{ n: c.id }]; },
          run: () => { c.fail(); c.log.push(`run ${sql}`); return { changes: 1, lastInsertRowid: 1 }; },
        };
      },
    };
    made.push(c);
    return c;
  };
  return { made, open };
}

test('a read on a stale connection is tried again on a new one, once', () => {
  const { made, open } = fakeConnections();
  const db = wrapLibsql(open);
  made[0].broken = true;
  assert.deepEqual(db.prepare('SELECT 1').get(), { n: 2 }, 'answered by the new connection');
  assert.equal(made.length, 2);
  assert.deepEqual(db.prepare('SELECT 2').all(), [{ n: 2 }], 'and the new one is kept');
  // A different error is not hidden.
  made[1].prepare = () => { throw new Error('SQLITE_ERROR: no such table: nope'); };
  assert.throws(() => db.prepare('SELECT * FROM nope'), /no such table/);
});

test('a write that fails on a stale connection is not repeated (it may have reached the database)', () => {
  const { made, open } = fakeConnections();
  const db = wrapLibsql(open);
  const stmt = db.prepare("INSERT INTO t VALUES ('x')");
  made[0].broken = true;
  assert.throws(() => stmt.run(), /connection closed/);
  assert.equal(made.length, 1, 'no second connection, no second insert');
});

test('after a minute idle a new connection is opened before anything is sent', (t) => {
  const { made, open } = fakeConnections();
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const db = wrapLibsql(open);
  db.prepare('SELECT 1').get();
  now += 30_000;
  db.prepare('SELECT 1').get();
  assert.equal(made.length, 1, '30 seconds: the same connection');
  now += 61_000;
  made[0].broken = true; // the server closed it meanwhile
  assert.deepEqual(db.prepare('SELECT 1').get(), { n: 2 });
  assert.equal(made.length, 2);
  assert.deepEqual(made[0].log.filter((l) => l.startsWith('get')).length, 2, 'the stale one was not even tried');
});

test('inside a transaction the connection never changes: a stale one fails the transaction', (t) => {
  const { made, open } = fakeConnections();
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const db = wrapLibsql(open);
  db.exec('BEGIN IMMEDIATE');
  now += 120_000; // even "idle" for long
  db.prepare('SELECT 1').get();
  assert.equal(made.length, 1, 'no new connection in the middle of the transaction');
  made[0].broken = true;
  assert.throws(() => db.prepare('SELECT 2').get(), /connection closed/, 'not moved to a new connection');
  assert.throws(() => db.exec('ROLLBACK'), /connection closed/);
  // Over (even though ROLLBACK itself failed): the next step may use a new connection again.
  assert.deepEqual(db.prepare('SELECT 3').get(), { n: 2 });
});
