'use strict';
// The console's connection to client sites (src/master.js), with fetch and DNS replaced: the checks before a
// management token goes out in production, the address guessed for a site whose project is unknown, and the mailbox
// shared on its own when that fails.
process.env.APP_MODE = 'master';
const { db } = require('../helpers');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns');
const config = require('../../src/config');
const master = require('../../src/master');

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const STATUS = { app: 'car-rental', mail: { configured: true } };

afterEach(() => {
  config.production = false;
  config.smtp = null;
  delete process.env.VERCEL_TOKEN;
  for (const c of master.list()) master.remove(c.slug);
});

test('production: a site whose name resolves to an internal address never gets the token', async (t) => {
  config.production = true;
  const fetch = t.mock.method(globalThis, 'fetch', async () => json(200, STATUS));
  const client = { slug: 'a', url: 'https://site.example.com' };
  for (const internal of ['10.1.2.3', '127.0.0.1', '0.0.0.0', '169.254.1.1', '172.20.0.1', '192.168.1.1', '100.64.0.1', '224.0.0.1',
    '::ffff:10.0.0.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1']) {
    t.mock.method(dns.promises, 'lookup', async () => [{ address: '93.184.216.34' }, { address: internal }]);
    await assert.rejects(master.call(client, 'GET', '/api/manage/status'), (e) => e.kind === 'unsafe_url', internal);
    dns.promises.lookup.mock.restore();
  }
  t.mock.method(dns.promises, 'lookup', async () => []);
  await assert.rejects(master.call(client, 'GET', '/api/manage/status'), (e) => e.kind === 'unsafe_url', 'no address at all');
  dns.promises.lookup.mock.restore();
  t.mock.method(dns.promises, 'lookup', async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); });
  await assert.rejects(master.call(client, 'GET', '/api/manage/status'), (e) => e.kind === 'unreachable', 'unknown name');
  dns.promises.lookup.mock.restore();
  assert.equal(fetch.mock.callCount(), 0, 'nothing was sent');

  // Public addresses only (v4 and v6): the call goes out.
  t.mock.method(dns.promises, 'lookup', async () => [{ address: '93.184.216.34' }, { address: '2606:2800:220:1::1' }, { address: '172.32.0.1' }]);
  assert.deepEqual(await master.call(client, 'GET', '/api/manage/status'), STATUS);
  assert.equal(fetch.mock.callCount(), 1);
});

test('a site with no known project is looked for at its usual *.vercel.app address', async (t) => {
  master.add({ slug: 'guess', name: 'Guess' });
  const fetch = t.mock.method(globalThis, 'fetch', async () => json(200, STATUS));
  assert.equal(await master.discoverUrl(master.get('guess')), 'https://car-rental-guess.vercel.app');
  assert.equal(fetch.mock.calls[0].arguments[0], 'https://car-rental-guess.vercel.app/api/manage/status');
  assert.equal(master.get('guess').url, 'https://car-rental-guess.vercel.app');
  // A named project without Vercel access: its own name.
  master.add({ slug: 'named', name: 'Named', vercel_project: 'my-project' });
  fetch.mock.mockImplementation(async () => { throw new TypeError('fetch failed'); });
  assert.equal(await master.discoverUrl(master.get('named')), null, 'nothing answered');
  assert.equal(fetch.mock.calls.at(-1).arguments[0], 'https://my-project.vercel.app/api/manage/status');
});

test('a site that sends no mail gets the console\'s mailbox; when that fails it is only logged, and tried again an hour later', async (t) => {
  config.smtp = { host: 'smtp.example.org', port: 587 };
  process.env.VERCEL_TOKEN = 'v-token';
  master.add({ slug: 'nomail', name: 'No mail', url: 'http://127.0.0.1:9', vercel_project: 'car-rental-nomail' });
  const fetch = t.mock.method(globalThis, 'fetch', async (url) => (String(url).startsWith('http://127.0.0.1:9')
    ? json(200, { app: 'car-rental', mail: { configured: false } })
    : json(500, { error: { message: 'Vercel is down' } })));
  const warn = t.mock.method(console, 'warn', () => {});
  const r = await master.statusOf(master.get('nomail'));
  assert.equal(r.online, true);
  assert.equal(r.mailShared, false);
  assert.ok(warn.mock.calls.some((c) => /mail settings for nomail failed/.test(c.arguments[0])));
  assert.ok(master.get('nomail').mail_shared_at, 'the attempt is remembered');
  const before = fetch.mock.callCount();
  await master.statusOf(master.get('nomail'));
  assert.equal(fetch.mock.callCount(), before + 1, 'within the hour only the status is asked, nothing is shared');
});

test('the client list reuses a status seen in the last 30 seconds; a change, a new address or "fresh" asks again', async (t) => {
  const asked = []; // the sites' addresses, one per request they got
  t.mock.method(globalThis, 'fetch', async (url) => {
    asked.push(new URL(url).host);
    if (String(url).startsWith('https://down.example.com')) throw new TypeError('fetch failed');
    return json(200, STATUS);
  });
  master.add({ slug: 'one', name: 'One', url: 'https://one.example.com' });
  master.add({ slug: 'two', name: 'Two', url: 'https://two.example.com' });
  master.add({ slug: 'down', name: 'Down', url: 'https://down.example.com' });
  const list = () => master.statusAll(master.list());
  const count = (host) => asked.filter((h) => h === host).length;

  const first = await list();
  assert.deepEqual(first.map((s) => s.online), [false, true, true], 'Down, One, Two (by name)');
  await list();
  assert.equal(asked.length, 3, 'the second list asked nobody, the site that did not answer included');

  // A change sent to a site: only that site is asked again.
  await master.call(master.get('one'), 'POST', '/api/manage/suspend', { suspended: true });
  await list();
  assert.equal(count('one.example.com'), 3, 'its first status, the change, and a fresh status');
  assert.equal(count('two.example.com'), 1);

  // A client's own page always asks, and the list then uses that answer.
  await master.statusOf(master.get('two'));
  await list();
  assert.equal(count('two.example.com'), 2);

  // A new address: what the old one answered is not this site's.
  master.update('two', { url: 'https://two-new.example.com' });
  await list();
  assert.equal(count('two-new.example.com'), 1);

  // "Refresh" (and the alerts): every site.
  const before = asked.length;
  await master.statusAll(master.list(), { maxAgeMs: 0 });
  assert.equal(asked.length, before + 3);

  // After 30 seconds the list asks again.
  const now = Date.now;
  t.mock.method(Date, 'now', () => now.call(Date) + master.STATUS_CACHE_MS + 1);
  await list();
  assert.equal(asked.length, before + 6);
});

test('the alerts never use a status the client list cached', async (t) => {
  config.smtp = null;
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url) => { asked.push(String(url)); return json(200, STATUS); });
  master.add({ slug: 'watched', name: 'Watched', url: 'https://watched.example.com' });
  await master.statusAll(master.list()); // the list page, a moment ago
  const alerts = require('../../src/alerts');
  t.mock.method(console, 'log', () => {});
  db.prepare("DELETE FROM job_state WHERE key = 'alerts_at'").run();
  await alerts.run();
  assert.equal(asked.filter((u) => u.startsWith('https://watched.example.com/api/manage/status')).length, 2, 'asked again for the alerts');
});
