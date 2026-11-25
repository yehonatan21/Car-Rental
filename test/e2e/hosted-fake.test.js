'use strict';
// The hosted-database mode without a sqld server: `libsql` is replaced by an in-memory stand-in (fixtures/fake-libsql.js),
// and the database URL is one the Vercel Turso integration makes for a single deployment. Covers opening the hosted
// database, files kept inside it, and the "a new database for every deployment" warning (log and settings page).
// The full suite against a real libSQL server is `SQLD_BIN=… npm run test:libsql`.
const FakeLibsql = require('../fixtures/fake-libsql');

delete process.env.SQLD_BIN; // this file brings its own stand-in, also when the suite runs against sqld

const HOST = 'dpl-abc123-vercel-icfg-x1y2.turso.io';
// A key that expires on 1/1/2030 (its JWT "exp"), so the settings page shows its expiry.
const jwt = ['{"alg":"none"}', `{"exp":${Date.UTC(2030, 0, 1) / 1000}}`].map((p) => Buffer.from(p).toString('base64url')).join('.') + '.sig';
process.env.TURSO_DATABASE_URL = `libsql://${HOST}`;
process.env.TURSO_AUTH_TOKEN = `Bearer ${jwt}`;

const warnings = [];
const warn = console.warn;
console.warn = (...a) => { warnings.push(a.join(' ')); };
const { db, createUser, startServer, Client, putStoredFile, storedFile } = require('../helpers');
console.warn = warn;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../../src/storage');
const { storageInfo } = require('../../src/db');

let srv, admin;
before(async () => {
  srv = await startServer();
  createUser({ role: 'admin', email: 'admin@hosted.test' });
  admin = new Client(srv.base);
  await admin.login('admin@hosted.test');
});
after(() => srv.close());

test('the hosted database is opened over HTTPS, with the key (without "Bearer"), foreign keys on', () => {
  assert.equal(db.remote, true);
  assert.equal(FakeLibsql.opened[0].url, `https://${HOST}`);
  assert.deepEqual(FakeLibsql.opened[0].options, { authToken: jwt });
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.ok(!('_metadata' in db.prepare('SELECT 1 AS one').get()), 'the extra libsql property is removed');
});

test('a database made for one deployment is flagged: in the startup log and on the settings page', async () => {
  const s = storageInfo();
  assert.equal(s.kind, 'hosted');
  assert.equal(s.host, HOST);
  assert.equal(s.perDeployment, true);
  assert.equal(s.keyExpiresAt, '2030-01-01T00:00:00.000Z');
  assert.ok(warnings.some((w) => /separate database created for this one deployment/.test(w)));
  const page = await admin.get('/admin/settings?tab=health');
  assert.match(page.text, /מסד נתונים חדש לכל גרסה/);
  assert.ok(page.text.includes(HOST));
  assert.match(page.text, /תקף עד 01\/01\/2030/);
});

test('files are kept inside the database in chunks, read back whole, and removed', () => {
  const big = Buffer.alloc(storage.CHUNK + 10, 7);
  putStoredFile('big.pdf', big);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files WHERE name = 'big.pdf'").get().n, 2);
  assert.ok(storedFile('big.pdf').equals(big));
  storage.remove('big.pdf');
  assert.equal(storedFile('big.pdf'), null);
  assert.equal(storedFile('nothing.png'), null);
});

test('the status counts the files kept in the database, in the same few round trips', async () => {
  process.env.MANAGE_TOKEN = 'h'.repeat(20) + '-hosted-manage-token-0123';
  try {
    putStoredFile('a.png', Buffer.alloc(10, 1));
    putStoredFile('b.pdf', Buffer.alloc(storage.CHUNK + 5, 2)); // two chunks, one file
    const r = await fetch(`${srv.base}/api/manage/status`, { headers: { authorization: `Bearer ${process.env.MANAGE_TOKEN}` } });
    const data = await r.json();
    assert.deepEqual(data.metrics.files, { count: 2, bytes: 10 + storage.CHUNK + 5 });
    assert.ok(Number(/desc="(\d+) quer/.exec(r.headers.get('server-timing'))[1]) <= 6);
  } finally {
    delete process.env.MANAGE_TOKEN;
  }
});
