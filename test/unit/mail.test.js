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
  await mail.bookingApproved(bookings.approve(b.id, admin.id), { approvedBy: 'מנהלת ראשית' });
  const m = outbox().find((x) => x.to.includes('driver@mail.test'));
  assert.equal(m.subject, 'ההזמנה אושרה');
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

test('approval confirmation goes to the user AND all active admins, both with a calendar invite', async () => {
  const admin = createUser({ role: 'admin', email: 'boss@mail.test' });
  const u = createUser({ email: 'confirm@mail.test', first_name: 'רונית', last_name: 'כהן', phone: '0527654321' });
  const b = bookings.createRequest(u, { vehicleId: 1, start: inDays(4, '09:00'), end: inDays(4, '13:30'), purpose: 'פגישה' });
  clearOutbox();
  await mail.bookingApproved(bookings.approve(b.id, admin.id), { approvedBy: 'בוס גדול' });
  const msgs = outbox();
  const toUser = msgs.find((m) => m.to.includes('confirm@mail.test'));
  const toAdmin = msgs.find((m) => m.to.includes('boss@mail.test'));
  assert.ok(toUser && toAdmin);
  assert.equal(toAdmin.subject, 'אישור הזמנה: רונית כהן');
  assert.match(toAdmin.body, /אושרה על ידי בוס גדול/);
  assert.match(toAdmin.body, /0527654321/);
  assert.match(toAdmin.body, /פגישה/);
  for (const m of [toUser, toAdmin]) {
    assert.match(m.raw, /Content-Type: text\/calendar; charset=utf-8; method=PUBLISH/);
    assert.match(m.raw, new RegExp(`filename=booking-${b.id}\\.ics`));
    assert.match(m.body, /BEGIN:VEVENT/);
    assert.match(m.body, /STATUS:CONFIRMED/);
  }
});

test('manual booking without notifying the user still confirms to admins', async () => {
  const admin = createUser({ role: 'admin', email: 'boss2@mail.test' });
  const u = createUser({ email: 'quiet@mail.test' });
  const b = bookings.createManual(admin.id, { vehicleId: 1, userId: u.id, start: inDays(6), end: inDays(6, '12:00') });
  clearOutbox();
  await mail.bookingApproved(b, { notifyUser: false });
  assert.ok(!outbox().some((m) => m.to.includes('quiet@mail.test')));
  const toAdmin = outbox().find((m) => m.to.includes('boss2@mail.test'));
  assert.match(toAdmin.body, /לא נשלח מייל למשתמש/);
});

test('calendar invite: UTC times (incl. DST), escaping and line folding', () => {
  const { content, filename } = mail.bookingIcs({
    id: 9, make: 'טויוטה', model: 'קורולה', plate: '12-345-67', start_at: '2026-10-25T09:00', end_at: '2026-10-25T13:30',
    purpose: 'נסיעה, לים; ועוד', instructions: 'שורה\nשנייה',
  });
  assert.equal(filename, 'booking-9.ics');
  assert.match(content, /DTSTART:20261025T070000Z\r\n/, 'Israel winter time: UTC+2');
  assert.match(content, /DTEND:20261025T113000Z/);
  assert.match(content.replace(/\r\n /g, ''), /נסיעה\\, לים\\; ועוד\\nהנחיות: שורה\\nשנייה/);
  for (const line of content.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  const summer = mail.bookingIcs({ id: 1, plate: 'x', start_at: '2026-07-01T09:00', end_at: '2026-07-01T10:00' }).content;
  assert.match(summer, /DTSTART:20260701T060000Z/, 'Israel summer time: UTC+3');
});
