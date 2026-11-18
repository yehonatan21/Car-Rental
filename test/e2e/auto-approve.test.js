'use strict';
// Settings → automatic approval: a request nothing stands in the way of is approved at once; otherwise it waits.
const { db, createUser, inDays, startServer, Client, outbox } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getSettings } = require('../../src/db');

let srv, admin;
before(async () => {
  srv = await startServer();
  createUser({ role: 'admin', email: 'auto-admin@test.org' });
  admin = new Client(srv.base);
  await admin.login('auto-admin@test.org');
});
after(() => srv.close());

const latest = (userId) => db.prepare('SELECT * FROM bookings WHERE user_id = ? ORDER BY id DESC').get(userId);
async function request(email, day, from, to) {
  const c = new Client(srv.base);
  await c.login(email);
  return c.post('/bookings/new', { start: inDays(day, from), end: inDays(day, to), accept_rules: '1' }, '/bookings/new');
}

test('off by default: a request waits for an admin', async () => {
  assert.equal(getSettings().auto_approve, 0);
  const u = createUser({ email: 'auto-off@test.org' });
  const r = await request(u.email, 20, '08:00', '10:00');
  assert.match(r.text, /הבקשה נשלחה/);
  assert.equal(latest(u.id).status, 'pending');
});

test('on: a free slot is approved at once; a slot another request waits for stays with the admin', async () => {
  const page = (await admin.get('/admin/settings?tab=bookings')).text;
  assert.match(page, /name="auto_approve" value="1"/);
  const rules = { buffer_minutes: 0, cancel_hours_before: 24, max_booking_hours: 168, max_open_bookings: 3, pickup_reminder_hours: 24,
    return_reminder_hours: 2, pending_alert_hours: 24, license_warn_days: 30 };
  await admin.post('/admin/settings', { ...rules, auto_approve: '1' }, '/admin/settings?tab=bookings');
  assert.equal(getSettings().auto_approve, 1);

  const a = createUser({ email: 'auto-a@test.org' });
  const r = await request(a.email, 21, '08:00', '10:00');
  assert.match(r.text, /ההזמנה אושרה/);
  const b = latest(a.id);
  assert.equal(b.status, 'approved');
  assert.ok(outbox().some((m) => m.subject === 'ההזמנה אושרה' && m.to.includes(a.email)), 'the user gets the approval mail');
  assert.equal(db.prepare("SELECT note FROM booking_history WHERE booking_id = ? AND to_status = 'approved'").get(b.id).note, 'אושרה אוטומטית');

  // The earlier request (auto-off@) still waits for 20/08:00–10:00: a second one for that time is not approved on its own.
  const c = createUser({ email: 'auto-c@test.org' });
  await request(c.email, 20, '09:00', '11:00');
  assert.equal(latest(c.id).status, 'pending', 'an admin chooses between two requests for the same time');

  // Unticked again: off.
  await admin.post('/admin/settings', rules, '/admin/settings?tab=bookings');
  assert.equal(getSettings().auto_approve, 0);
});
