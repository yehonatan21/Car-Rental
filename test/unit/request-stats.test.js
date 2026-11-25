'use strict';
// Visitors' request times (src/timing.js counts, src/request-stats.js saves and summarizes), for the console's
// monitoring: the numbers that decide whether the hosted database driver is worth replacing.
const { db, startServer, Client } = require('../helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const stats = require('../../src/request-stats');
const timing = require('../../src/timing');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());
beforeEach(() => { timing.takeTotals(); db.exec('DELETE FROM request_stats'); });

const saved = () => db.prepare('SELECT * FROM request_stats').all();

test('visitors\' requests are counted; files, the health check, the console\'s polling and the cron are not', async () => {
  const c = new Client(srv.base);
  for (let i = 0; i < 3; i++) await c.get('/login');
  for (const p of ['/static/style.css', '/healthz', '/favicon.ico', '/api/manage/status', '/internal/cron']) await c.get(p);
  assert.equal(stats.save(), 3);
  const [row] = saved();
  assert.equal(row.requests, 3);
  assert.match(row.hour, /^\d{4}-\d\d-\d\d \d\d$/, 'one row per hour, no finer');
  assert.equal(row.t0 + row.t1 + row.t2 + row.t3 + row.t4 + row.t5 + row.t6 + row.t7 + row.t8 + row.t9 + row.t10, 3);
  assert.ok(row.total_ms > 0);
  assert.equal(stats.save(), 0, 'nothing new to save');
});

test('saving adds to the hour\'s row; a save that fails keeps its counts for the next one', async (t) => {
  const c = new Client(srv.base);
  await c.get('/login');
  stats.save();
  await c.get('/login');
  await c.get('/login');
  const logged = t.mock.method(console, 'error', () => {});
  const prepare = db.prepare;
  t.mock.method(db, 'prepare', function failing(sql) {
    if (/INSERT INTO request_stats/.test(sql)) throw new Error('database is locked');
    return prepare.call(this, sql);
  });
  assert.equal(stats.save(), 0);
  assert.match(logged.mock.calls[0].arguments[0], /could not save the request times/);
  db.prepare.mock.restore();
  assert.equal(stats.save(), 2, 'the two kept from the failed save');
  assert.equal(saved()[0].requests, 3);
});

test('after a response the totals are saved at most once a minute', async (t) => {
  const c = new Client(srv.base);
  const now = Date.now;
  let offset = stats.SAVE_MS + 1;
  t.mock.method(Date, 'now', () => now.call(Date) + offset);
  await c.get('/login'); // a minute after the last save: saved after this response
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(saved()[0]?.requests, 1);
  await c.get('/login');
  await c.get('/login'); // within the minute: counted, not yet saved
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(saved()[0].requests, 1);
  offset += stats.SAVE_MS + 1;
  await c.get('/login');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(saved()[0].requests, 4);
});

test('percentiles from the buckets, and the summary the status reports', () => {
  //            ≤5 ≤10 ≤25 ≤50 ≤100 ≤250 ≤500 ≤1000 ≤2500 ≤5000 >5000
  const t = [0, 10, 40, 30, 15, 3, 1, 1, 0, 0, 0];
  assert.equal(stats.percentile(t, 0.5), 25);
  assert.equal(stats.percentile(t, 0.95), 100);
  assert.equal(stats.percentile([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4], 0.5), null, 'above 5 s');
  assert.equal(stats.percentile(Array(11).fill(0), 0.5), null);
  const s = stats.summarize({ requests: 100, totalMs: 4000, dbMs: 1000, queries: 450, t, d: [60, 30, 10, 0, 0, 0, 0, 0, 0, 0, 0] });
  assert.deepEqual(s, { requests: 100, p50: 25, p95: 100, dbP95: 25, dbShare: 25, queries: 4.5 }); // 60+30 < 95 of 100: the third bucket
  assert.equal(stats.summarize(JSON.stringify({ requests: 0 })), null, 'nothing counted yet');
  assert.equal(stats.summarize('not json'), null);
  assert.equal(stats.summarize({ requests: 1, totalMs: 0, dbMs: 0, queries: 0, t: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], d: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }).dbShare, 0);
});

test('the site\'s status carries the last 24 hours, in the same single statement', async () => {
  process.env.MANAGE_TOKEN = 'r'.repeat(20) + '-request-stats-token-0123';
  try {
    const c = new Client(srv.base);
    for (let i = 0; i < 4; i++) await c.get('/login');
    stats.save();
    db.prepare("INSERT INTO request_stats (hour, requests, total_ms, db_ms, queries, t10) VALUES ('2020-01-01 00', 99, 1, 1, 1, 99)").run(); // long ago
    const r = await fetch(`${srv.base}/api/manage/status`, { headers: { authorization: `Bearer ${process.env.MANAGE_TOKEN}` } });
    const { metrics } = await r.json();
    assert.equal(metrics.requests.requests, 4, 'only the last 24 hours');
    assert.ok(metrics.requests.p95 >= metrics.requests.p50);
    assert.ok(Number(/desc="(\d+) quer/.exec(r.headers.get('server-timing'))[1]) <= 6);
    // The jobs drop rows older than a month.
    await require('../../src/jobs').runJobs();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM request_stats WHERE hour = '2020-01-01 00'").get().n, 0);
  } finally {
    delete process.env.MANAGE_TOKEN;
  }
});
