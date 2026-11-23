'use strict';
// Phone notifications (src/push.js): turning them on and off, sending them next to the e-mails, encrypted for the
// device, and forgetting a device that is gone or was signed out.
const { db, createUser, inDays, startServer, Client } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const ece = require('http_ece');
const bookings = require('../../src/bookings');
const mail = require('../../src/mail');
const push = require('../../src/push');

let srv; let pushServer; let pushBase;
const received = [];
let answer = 201;
before(async () => {
  srv = await startServer();
  // A stand-in for the browser's push service (FCM, Apple, Mozilla).
  pushServer = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => { received.push({ path: req.url, headers: req.headers, body: Buffer.concat(parts) }); res.writeHead(answer); res.end(); });
  });
  await new Promise((r) => pushServer.listen(0, '127.0.0.1', r));
  pushBase = `http://127.0.0.1:${pushServer.address().port}`;
});
after(() => { pushServer.close(); return srv.close(); });

/** A device as a browser would make it: its own key pair and auth secret. */
function device(name) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const b64 = (b) => b.toString('base64url');
  return {
    ecdh, auth,
    fields: { endpoint: `${pushBase}/push/${name}`, p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) },
    read: (body) => JSON.parse(ece.decrypt(body, { version: 'aes128gcm', privateKey: ecdh, authSecret: auth }).toString('utf8')),
  };
}

test('a member turns notifications on for a phone; an approval reaches it, encrypted, next to the e-mail', async () => {
  const u = createUser({ email: 'push-member@push.test' });
  const admin = createUser({ role: 'admin', email: 'push-admin@push.test' });
  const c = new Client(srv.base);
  await c.login('push-member@push.test');
  const page = (await c.get('/me')).text;
  const key = /data-push data-key="([\w-]{80,})"/.exec(page);
  assert.ok(key, 'the card carries the site\'s public key');
  assert.equal(key[1], push.publicKey());

  const phone = device('phone');
  const csrf = await c.csrf('/me');
  const r = await c.req('POST', '/me/push', { ...phone.fields, _csrf: csrf }, { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0' });
  assert.equal(r.status, 200);
  assert.deepEqual(push.devices(u.id).map((d) => d.device), ['Android · Chrome']);
  assert.match((await c.get('/me')).text, /פעיל ב־מכשיר אחד/);

  received.length = 0;
  const b = bookings.createRequest(u, { vehicleId: 1, start: inDays(3, '09:00'), end: inDays(3, '13:00') });
  await mail.bookingApproved(bookings.approve(b.id, admin.id), { approvedBy: 'מנהלת' });
  assert.equal(received.length, 1, 'one notification, to the member\'s phone');
  const n = received[0];
  assert.equal(n.path, '/push/phone');
  assert.equal(n.headers['content-encoding'], 'aes128gcm');
  assert.match(n.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.ok(Number(n.headers.ttl) > 0);
  assert.doesNotMatch(n.body.toString('latin1'), /ההזמנה|me\/bookings/, 'the push service sees only ciphertext');
  const msg = phone.read(n.body);
  assert.equal(msg.title, 'ההזמנה אושרה ✓');
  assert.equal(msg.url, '/me/bookings');
  assert.equal(msg.tag, `booking-${b.id}`);
  assert.ok(push.devices(u.id)[0].last_sent_at);
});

test('managers get new requests on their phones; a pickup reminder is urgent', async () => {
  const admin = createUser({ role: 'admin', email: 'push-boss@push.test' });
  const member = createUser({ email: 'push-driver@push.test' });
  const boss = device('boss');
  assert.ok(push.subscribe(admin.id, { endpoint: boss.fields.endpoint, keys: { p256dh: boss.fields.p256dh, auth: boss.fields.auth } }));
  const driver = device('driver');
  push.subscribe(member.id, { endpoint: driver.fields.endpoint, keys: { p256dh: driver.fields.p256dh, auth: driver.fields.auth } });

  received.length = 0;
  const b = bookings.createRequest(member, { vehicleId: 1, start: inDays(5, '09:00'), end: inDays(5, '12:00') });
  const row = db.prepare('SELECT b.*, u.first_name, u.last_name, u.email, u.phone FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.id = ?').get(b.id);
  await mail.bookingRequested(row);
  const toBoss = received.find((x) => x.path === '/push/boss');
  assert.ok(toBoss, 'the manager\'s phone');
  assert.equal(boss.read(toBoss.body).url, `/admin/bookings/${b.id}`);
  assert.ok(!received.some((x) => x.path === '/push/driver'), 'the member gets the e-mail receipt only');

  received.length = 0;
  await mail.pickupReminder(row);
  const reminder = received.find((x) => x.path === '/push/driver');
  assert.equal(reminder.headers.urgency, 'high');
  assert.equal(driver.read(reminder.body).title, 'תזכורת: איסוף הרכב מתקרב');
});

test('a phone the push service no longer knows is forgotten; turning off and signing out everywhere remove phones', async () => {
  const u = createUser({ email: 'push-gone@push.test' });
  const old = device('old');
  push.subscribe(u.id, { endpoint: old.fields.endpoint, keys: { p256dh: old.fields.p256dh, auth: old.fields.auth } });
  answer = 410;
  try {
    assert.equal(await push.notify(u.id, { title: 'x' }), 0);
  } finally {
    answer = 201;
  }
  assert.equal(push.devices(u.id).length, 0, 'gone (410): removed');

  const c = new Client(srv.base);
  await c.login('push-gone@push.test');
  const a = device('a'); const b = device('b');
  for (const d of [a, b]) await c.req('POST', '/me/push', { ...d.fields, _csrf: await c.csrf('/me') }, { accept: 'application/json' });
  assert.equal(push.devices(u.id).length, 2);
  await c.req('POST', '/me/push/remove', { endpoint: a.fields.endpoint, _csrf: await c.csrf('/me') }, { accept: 'application/json' });
  assert.equal(push.devices(u.id).length, 1, 'only this phone');
  require('../../src/auth').destroyAllSessions(u.id);
  assert.equal(push.devices(u.id).length, 0, 'signed out everywhere: no phone keeps getting notifications');

  // Nonsense is refused.
  const c2 = new Client(srv.base);
  await c2.login(createUser({ email: 'push-bad@push.test' }).email);
  const bad = await c2.req('POST', '/me/push', { endpoint: 'javascript:alert(1)', p256dh: 'x', auth: 'y', _csrf: await c2.csrf('/me') }, { accept: 'application/json' });
  assert.equal(bad.status, 400);
});

test('the service worker shows notifications and opens their page', async () => {
  const sw = await fetch(`${srv.base}/sw.js`).then((r) => r.text());
  assert.match(sw, /addEventListener\('push'/);
  assert.match(sw, /showNotification\(/);
  assert.match(sw, /addEventListener\('notificationclick'/);
});
