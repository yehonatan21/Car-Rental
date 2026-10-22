'use strict';
const { createUser, inDays, outbox, clearOutbox } = require('../helpers');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mail = require('../../src/mail');
const bookings = require('../../src/bookings');
const { db } = require('../../src/db');

beforeEach(() => clearOutbox());

test('without SMTP, mail is written to the outbox as .eml', async () => {
  await mail.send('a@test.org', 'נושא בדיקה', ['שורה']);
  const [m] = outbox();
  assert.ok(m.file.endsWith('.eml'));
  assert.equal(m.subject, 'נושא בדיקה');
  assert.match(m.to, /a@test.org/);
});

test('no recipients means no mail', async () => {
  await mail.send([], 'x', ['y']);
  await mail.send([null], 'x', ['y']);
  assert.equal(outbox().length, 0);
});

test('user-supplied text is escaped in e-mail HTML', async () => {
  const u = createUser({ first_name: '<img src=x onerror=alert(1)>' });
  await mail.userApproved(u);
  const { body } = outbox()[0];
  assert.doesNotMatch(body, /<img src=x/);
  assert.match(body, /&lt;img src=x/);
});

test('approval mail includes vehicle, times and driver instructions', async () => {
  db.prepare("UPDATE vehicles SET plate = '11-222-33', instructions = 'המפתח בתיבה' WHERE id = 1").run();
  const admin = createUser({ role: 'admin' });
  const u = createUser({ email: 'driver@mail.test' });
  const b = bookings.createRequest(u, { vehicleId: 1, start: inDays(2, '09:00'), end: inDays(2, '17:00') });
  clearOutbox();
  await mail.bookingApproved(bookings.approve(b.id, admin.id));
  const m = outbox()[0];
  assert.equal(m.subject, 'ההזמנה אושרה');
  assert.match(m.to, /driver@mail.test/);
  assert.match(m.body, /11-222-33/);
  assert.match(m.body, /המפתח בתיבה/);
  assert.match(m.body, /אושרה סופית/);
  assert.match(m.body, /09:00/);
});

test('booking request notifies both the user and all active admins', async () => {
  createUser({ role: 'admin', email: 'admin1@mail.test' });
  createUser({ role: 'admin', email: 'admin2@mail.test' });
  createUser({ role: 'admin', email: 'blocked-admin@mail.test', status: 'blocked' });
  const u = createUser({ email: 'requester@mail.test' });
  const b = bookings.createRequest(u, { vehicleId: 1, start: inDays(3, '09:00'), end: inDays(3, '10:00') });
  await mail.bookingRequested(b);
  const msgs = outbox();
  assert.equal(msgs.length, 2);
  const toUser = msgs.find((m) => m.to.includes('requester@mail.test'));
  const toAdmins = msgs.find((m) => m.to.includes('admin1@mail.test'));
  assert.equal(toUser.subject, 'בקשת ההזמנה התקבלה');
  assert.match(toAdmins.to, /admin2@mail.test/);
  assert.doesNotMatch(toAdmins.to, /blocked-admin/);
});
