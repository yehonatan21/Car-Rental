'use strict';
// The installable app (PWA): manifest, icons in the site's colour, the service worker, the "no connection" page.
const { db, createUser, startServer, Client } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

/** The colour of a PNG's pixel (x, y) (RGBA, 8 bits, no interlace: what src/icons.js writes). */
function pixel(buf, x, y) {
  const size = buf.readUInt32BE(16);
  let i = 8; const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i); const type = buf.toString('ascii', i + 4, i + 8);
    if (type === 'IDAT') idat.push(buf.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const o = y * (size * 4 + 1) + 1 + x * 4;
  return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]];
}

test('every page links the manifest; the manifest names the site, in Hebrew, right to left, with its icons', async () => {
  const page = await fetch(`${srv.base}/login`).then((r) => r.text());
  const tag = /<link rel="manifest" href="(\/manifest\.webmanifest\?v=[0-9a-f]{6})">/.exec(page);
  assert.ok(tag, 'manifest link');
  assert.match(page, /<link rel="apple-touch-icon" href="\/icons\/maskable-180\.png\?v=[0-9a-f]{6}">/);
  assert.match(page, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  const r = await fetch(srv.base + tag[1]);
  assert.match(r.headers.get('content-type'), /application\/manifest\+json/);
  const m = await r.json();
  assert.equal(m.lang, 'he');
  assert.equal(m.dir, 'rtl');
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.ok(m.short_name.length <= 12);
  assert.deepEqual(m.icons.map((i) => `${i.purpose} ${i.sizes}`), ['any 192x192', 'any 512x512', 'maskable 192x192', 'maskable 512x512']);
  assert.deepEqual(m.shortcuts.map((s) => s.url), ['/bookings/new', '/me']);
});

test('icons are PNGs in the site\'s own colour, and follow a colour change', async () => {
  const { saveBrand } = require('../../src/brand');
  const get = async (p) => Buffer.from(await (await fetch(srv.base + p)).arrayBuffer());
  const first = await get('/icons/maskable-192.png');
  assert.deepEqual([...first.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(first.readUInt32BE(16), 192);
  assert.deepEqual(pixel(first, 4, 4).slice(0, 3), [0x0b, 0x7a, 0x63], 'the default green behind the car');
  saveBrand({ brand_color: '#1d4ed8' });
  try {
    const page = await fetch(`${srv.base}/login`).then((r) => r.text());
    assert.match(page, /manifest\.webmanifest\?v=1d4ed8/, 'a new colour is a new address, so phones fetch it again');
    const m = await fetch(`${srv.base}/manifest.webmanifest`).then((r) => r.json());
    assert.equal(m.theme_color, '#1d4ed8');
    const blue = await get('/icons/any-512.png?v=1d4ed8');
    assert.equal(blue.readUInt32BE(16), 512);
    assert.deepEqual(pixel(blue, 256, 40).slice(0, 3), [0x1d, 0x4e, 0xd8]);
    assert.equal(pixel(blue, 0, 0)[3], 0, 'the "any" icon has rounded, transparent corners');
  } finally {
    saveBrand({ brand_color: '' });
  }
  assert.equal((await fetch(`${srv.base}/icons/any-64.png`)).status, 404);
  assert.equal((await fetch(`${srv.base}/icons/huge-192.png`)).status, 404);
});

test('the service worker keeps only shared files, never pages; the "no connection" page has nothing personal', async () => {
  const r = await fetch(`${srv.base}/sw.js`);
  assert.match(r.headers.get('content-type'), /javascript/);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  const sw = await r.text();
  const files = JSON.parse(/const FILES = (\[.*\]);/.exec(sw)[1]);
  assert.ok(files.includes('/offline'));
  assert.ok(files.every((f) => f === '/offline' || /^\/(static|icons)\//.test(f)), files.join(', '));
  assert.match(sw, /req\.mode === 'navigate'[\s\S]*fetch\(req\)\.catch\(\(\) => caches\.match\('\/offline'\)\)/, 'pages from the network');

  // Signed in or not, the same page (the service worker stores it once for everyone).
  createUser({ email: 'pwa-user@pwa.test' });
  const c = new Client(srv.base);
  await c.login('pwa-user@pwa.test');
  const off = await c.get('/offline');
  assert.equal(off.status, 200);
  assert.match(off.text, /אין חיבור לאינטרנט/);
  assert.doesNotMatch(off.text, /pwa-user|signed-in|יציאה/);
});

test('the personal page offers to install the app (hidden until the phone can)', async () => {
  createUser({ email: 'pwa-me@pwa.test' });
  const c = new Client(srv.base);
  await c.login('pwa-me@pwa.test');
  const page = (await c.get('/me')).text;
  assert.match(page, /<section class="card install-card" data-install hidden/);
  assert.match(page, /הוספה למסך הבית/);
  db.prepare("DELETE FROM users WHERE email LIKE '%@pwa.test'").run();
});
