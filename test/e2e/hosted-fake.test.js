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

test('a file kept in the database is sent a chunk at a time; a one-chunk file is still one query', async (t) => {
  const big = Buffer.alloc(2 * storage.CHUNK + 123);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  putStoredFile('three.png', big);
  putStoredFile('one.png', Buffer.from('small'));
  const u = createUser({ license_file: 'three.png' });
  const v = createUser({ license_file: 'one.png' });
  const queries = []; // every round trip to the files table: a list, or one chunk
  const prepare = db.prepare;
  t.mock.method(db, 'prepare', function recording(sql) {
    const stmt = prepare.call(this, sql);
    if (!/FROM files/.test(sql)) return stmt;
    return { ...stmt, all: (...a) => { queries.push('list'); return stmt.all(...a); }, get: (...a) => { queries.push('chunk'); return stmt.get(...a); } };
  });

  const r = await admin.req('GET', `/admin/users/${u.id}/license`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-length'), String(big.length));
  const got = Buffer.from(await (await fetch(`${srv.base}/admin/users/${u.id}/license`, { headers: { cookie: `sid=${admin.cookies.sid}` } })).arrayBuffer());
  assert.ok(got.equals(big), 'the whole file, in order');
  // Per request: the list with the first chunk, then the two other chunks one by one.
  assert.deepEqual(queries, ['list', 'chunk', 'chunk', 'list', 'chunk', 'chunk']);

  queries.length = 0;
  const one = await fetch(`${srv.base}/admin/users/${v.id}/license`, { headers: { cookie: `sid=${admin.cookies.sid}` } });
  assert.equal(await one.text(), 'small');
  assert.equal(queries.length, 1, 'one round trip for a file of one chunk');
});

test('a chunk missing from the database breaks the download (never a wrong file) and is recorded', async (t) => {
  putStoredFile('broken.pdf', Buffer.alloc(storage.CHUNK + 50, 3));
  db.prepare("DELETE FROM files WHERE name = 'broken.pdf' AND seq = 1").run();
  db.prepare("INSERT INTO files (name, seq, data) VALUES ('broken.pdf', 2, x'00')").run(); // a gap: seq 1 is missing
  const u = createUser({ license_file: 'broken.pdf' });
  t.mock.method(console, 'error', () => {});
  await assert.rejects((async () => {
    const res = await fetch(`${srv.base}/admin/users/${u.id}/license`, { headers: { cookie: `sid=${admin.cookies.sid}` } });
    await res.arrayBuffer();
  })(), 'the connection is cut before the file is complete');
  assert.match(db.prepare("SELECT message FROM error_log WHERE message LIKE 'stored file broken.pdf%'").get().message, /chunk 1 is missing/);
});
