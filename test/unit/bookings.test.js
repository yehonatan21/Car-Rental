'use strict';
const { createUser, getBooking, inDays, db } = require('../helpers');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bookings = require('../../src/bookings');
const { setSetting, DEFAULT_SETTINGS, defaultVehicle } = require('../../src/db');
const time = require('../../src/time');

const V = defaultVehicle().id;
const admin = createUser({ role: 'admin' });

beforeEach(() => {
  db.exec("DELETE FROM booking_history; DELETE FROM bookings; UPDATE vehicles SET status = 'available'");
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setSetting(k, v);
});

const request = (user, start, end, extra = {}) => bookings.createRequest(user, { vehicleId: V, start, end, ...extra });
const approved = (user, start, end) => bookings.approve(request(user, start, end).id, admin.id);
const rejects = (fn, re) => assert.throws(fn, (e) => e instanceof bookings.BookingError && re.test(e.message));

// ---------- findConflicts ----------

test('back-to-back bookings do not conflict; any overlap does', () => {
  const u = createUser();
  approved(u, inDays(2, '10:00'), inDays(2, '12:00'));
  assert.equal(bookings.findConflicts(V, inDays(2, '12:00'), inDays(2, '14:00')).length, 0, 'starts exactly at return');
  assert.equal(bookings.findConflicts(V, inDays(2, '08:00'), inDays(2, '10:00')).length, 0, 'ends exactly at pickup');
  assert.equal(bookings.findConflicts(V, inDays(2, '11:59'), inDays(2, '14:00')).length, 1);
  assert.equal(bookings.findConflicts(V, inDays(2, '09:00'), inDays(2, '13:00')).length, 1, 'fully contains');
  assert.equal(bookings.findConflicts(V, inDays(2, '10:30'), inDays(2, '11:00')).length, 1, 'fully inside');
});

test('turnaround buffer applies on both sides', () => {
  const u = createUser();
  approved(u, inDays(2, '10:00'), inDays(2, '12:00'));
  setSetting('buffer_minutes', 30);
  assert.equal(bookings.findConflicts(V, inDays(2, '12:15'), inDays(2, '14:00')).length, 1);
  assert.equal(bookings.findConflicts(V, inDays(2, '12:30'), inDays(2, '14:00')).length, 0);
  assert.equal(bookings.findConflicts(V, inDays(2, '08:00'), inDays(2, '09:45')).length, 1);
  assert.equal(bookings.findConflicts(V, inDays(2, '08:00'), inDays(2, '09:30')).length, 0);
});

test('only approved bookings and blocks occupy the calendar', () => {
  const u = createUser();
  const p = request(u, inDays(2, '10:00'), inDays(2, '12:00'));
  assert.equal(bookings.findConflicts(V, inDays(2, '10:00'), inDays(2, '12:00')).length, 0, 'pending');
  bookings.reject(p.id, admin.id);
  const c = request(u, inDays(3, '10:00'), inDays(3, '12:00'));
  bookings.approve(c.id, admin.id);
  bookings.cancel(c.id, u);
  assert.equal(bookings.findConflicts(V, inDays(3, '10:00'), inDays(3, '12:00')).length, 0, 'cancelled');
  bookings.createBlock(admin.id, { vehicleId: V, start: inDays(4, '08:00'), end: inDays(4, '18:00'), reason: 'טיפול' });
  assert.equal(bookings.findConflicts(V, inDays(4, '12:00'), inDays(4, '13:00')).length, 1, 'block');
});

test('multi-day bookings are detected', () => {
  const u = createUser();
  approved(u, inDays(2, '18:00'), inDays(5, '09:00'));
  assert.equal(bookings.findConflicts(V, inDays(3, '10:00'), inDays(3, '11:00')).length, 1);
});

// ---------- createRequest ----------

test('a valid request is created as pending with history', () => {
  const u = createUser();
  const b = request(u, inDays(2, '10:00'), inDays(2, '12:00'), { purpose: 'קניות', notes: 'הערה' });
  assert.equal(b.status, 'pending');
  assert.equal(b.purpose, 'קניות');
  assert.equal(b.user_id, u.id);
  const h = db.prepare('SELECT * FROM booking_history WHERE booking_id = ?').all(b.id);
  assert.equal(h.length, 1);
  assert.equal(h[0].to_status, 'pending');
  assert.equal(h[0].actor_id, u.id);
});

test('request validation', () => {
  const u = createUser();
  rejects(() => request(u, 'bad', inDays(2)), /תקינים/);
  rejects(() => request(u, inDays(2, '12:00'), inDays(2, '12:00')), /אחרי מועד האיסוף/);
  rejects(() => request(u, inDays(2, '12:00'), inDays(2, '10:00')), /אחרי מועד האיסוף/);
  rejects(() => request(u, inDays(-1, '10:00'), inDays(1, '10:00')), /כבר עבר/);
  rejects(() => request(u, inDays(1, '10:00'), inDays(9, '10:00')), /משך הזמנה מקסימלי הוא 7 ימים \(168 שעות\)/);
  setSetting('max_booking_hours', 0);
  assert.ok(request(u, inDays(1, '10:00'), inDays(9, '10:00')), '0 means unlimited');
});

test('pending requests overlapping each other are allowed (admin chooses)', () => {
  const a = createUser();
  const b = createUser();
  request(a, inDays(2, '10:00'), inDays(2, '12:00'));
  assert.ok(request(b, inDays(2, '11:00'), inDays(2, '13:00')));
});

test('a request for an approved slot is refused', () => {
  const a = createUser();
  approved(a, inDays(2, '10:00'), inDays(2, '12:00'));
  rejects(() => request(createUser(), inDays(2, '11:00'), inDays(2, '13:00')), /הרכב תפוס/);
});

test('eligibility: status, verified license, license validity, policy', () => {
  rejects(() => request(createUser({ status: 'pending' }), inDays(2), inDays(3)), /אינו פעיל/);
  rejects(() => request(createUser({ status: 'blocked' }), inDays(2), inDays(3)), /אינו פעיל/);
  rejects(() => request(createUser({ status: 'license_update' }), inDays(2), inDays(3)), /אינו פעיל/);
  rejects(() => request(createUser({ license_verified: 0 }), inDays(2), inDays(3)), /טרם אושר/);
  const shortLicense = createUser({ license_expiry: time.addDays(time.today(), 2) });
  assert.ok(request(shortLicense, inDays(2, '08:00'), inDays(2, '20:00')), 'valid through the last day');
  rejects(() => request(shortLicense, inDays(2, '20:00'), inDays(3, '08:00')), /לכל תקופת ההזמנה/);
  rejects(() => request(createUser({ acceptPolicy: false }), inDays(2), inDays(3)), /נהלי השאלת הרכב/);
});

test('max open bookings per user', () => {
  const u = createUser();
  request(u, inDays(1), inDays(1, '11:00'));
  request(u, inDays(2), inDays(2, '11:00'));
  request(u, inDays(3), inDays(3, '11:00'));
  rejects(() => request(u, inDays(4), inDays(4, '11:00')), /עד 3 הזמנות/);
  setSetting('max_open_bookings', 0);
  assert.ok(request(u, inDays(4), inDays(4, '11:00')));
});

test('vehicle status: disabled blocks requests, in-service does not', () => {
  const u = createUser();
  db.prepare("UPDATE vehicles SET status = 'service'").run();
  assert.ok(request(u, inDays(2), inDays(2, '12:00')));
  db.prepare("UPDATE vehicles SET status = 'disabled'").run();
  rejects(() => request(u, inDays(3), inDays(3, '12:00')), /מושבת/);
});

// ---------- approve / reject ----------

test('approval re-checks availability: the second of two overlapping requests fails', () => {
  const a = request(createUser(), inDays(2, '10:00'), inDays(2, '12:00'));
  const b = request(createUser(), inDays(2, '11:00'), inDays(2, '13:00'));
  bookings.approve(a.id, admin.id);
  rejects(() => bookings.approve(b.id, admin.id), /הרכב תפוס/);
  assert.equal(getBooking(b.id).status, 'pending', 'still pending so the admin can reject it');
  assert.deepEqual(bookings.findPendingOverlaps(V, a.start_at, a.end_at, a.id).map((x) => x.id), [b.id]);
});

test('approval re-checks the user and license at approval time', () => {
  const u = createUser();
  const b = request(u, inDays(5), inDays(6));
  db.prepare('UPDATE users SET license_expiry = ? WHERE id = ?').run(time.addDays(time.today(), 4), u.id);
  rejects(() => bookings.approve(b.id, admin.id), /לא ניתן לאשר/);
  db.prepare("UPDATE users SET license_expiry = ?, status = 'blocked' WHERE id = ?").run(time.addDays(time.today(), 365), u.id);
  rejects(() => bookings.approve(b.id, admin.id), /אינו פעיל/);
});

test('cannot approve a request whose time has passed or that is not pending', () => {
  const u = createUser();
  const b = request(u, inDays(2), inDays(3));
  db.prepare('UPDATE bookings SET start_at = ?, end_at = ? WHERE id = ?').run(inDays(-3), inDays(-2), b.id);
  rejects(() => bookings.approve(b.id, admin.id), /כבר חלף/);
  const c = request(u, inDays(4), inDays(4, '12:00'));
  bookings.reject(c.id, admin.id, 'לא זמין');
  rejects(() => bookings.approve(c.id, admin.id), /רק בקשה שממתינה/);
  rejects(() => bookings.reject(c.id, admin.id), /רק בקשה שממתינה/);
  rejects(() => bookings.approve(999999, admin.id), /לא נמצאה/);
});

test('approve and reject record who did it', () => {
  const u = createUser();
  const a = bookings.approve(request(u, inDays(2), inDays(2, '12:00')).id, admin.id);
  const r = bookings.reject(request(u, inDays(3), inDays(3, '12:00')).id, admin.id, 'סיבה');
  const last = (id) => db.prepare('SELECT * FROM booking_history WHERE booking_id = ? ORDER BY id DESC LIMIT 1').get(id);
  assert.deepEqual([last(a.id).to_status, last(a.id).actor_id], ['approved', admin.id]);
  assert.deepEqual([last(r.id).to_status, last(r.id).actor_id, last(r.id).note], ['rejected', admin.id, 'סיבה']);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'booking.approve' AND target_id = ?").get(a.id));
});

// ---------- cancel ----------

test('user cancellation rules', () => {
  const u = createUser();
  const other = createUser();
  const pending = request(u, inDays(2), inDays(2, '12:00'));
  rejects(() => bookings.cancel(pending.id, other), /לא נמצאה/);
  assert.equal(bookings.cancel(pending.id, u).status, 'cancelled', 'pending: any time');
  rejects(() => bookings.cancel(pending.id, u), /בסטטוס זה/);

  const far = approved(u, inDays(3), inDays(3, '12:00'));
  assert.equal(bookings.cancel(far.id, u).status, 'cancelled', 'approved, more than 24h ahead');

  const soon = approved(u, time.addMinutes(time.now(), 600), time.addMinutes(time.now(), 700));
  rejects(() => bookings.cancel(soon.id, u), /עד 24 שעות/);
  setSetting('cancel_hours_before', 6);
  assert.equal(bookings.cancel(soon.id, u).status, 'cancelled');
});

test('admins can always cancel, with a note', () => {
  const u = createUser();
  const soon = approved(u, time.addMinutes(time.now(), 60), time.addMinutes(time.now(), 120));
  const c = bookings.cancel(soon.id, admin, 'תקלה ברכב');
  assert.equal(c.status, 'cancelled');
  assert.equal(db.prepare('SELECT note FROM booking_history WHERE booking_id = ? ORDER BY id DESC').get(soon.id).note, 'תקלה ברכב');
});

// ---------- manual bookings and blocks ----------

test('manual booking is approved immediately but still respects the rules', () => {
  const u = createUser();
  const b = bookings.createManual(admin.id, { vehicleId: V, userId: u.id, start: inDays(2), end: inDays(2, '12:00') });
  assert.equal(b.status, 'approved');
  assert.equal(b.created_by, admin.id);
  rejects(() => bookings.createManual(admin.id, { vehicleId: V, userId: u.id, start: inDays(2, '11:00'), end: inDays(2, '13:00') }), /תפוס/);
  rejects(() => bookings.createManual(admin.id, { vehicleId: V, userId: createUser({ status: 'pending' }).id, start: inDays(5), end: inDays(5, '12:00') }), /לא ניתן להזמין/);
  rejects(() => bookings.createManual(admin.id, { vehicleId: V, userId: 0, start: inDays(5), end: inDays(5, '12:00') }), /יש לבחור משתמש/);
});

test('maintenance blocks', () => {
  const u = createUser();
  approved(u, inDays(2, '10:00'), inDays(2, '12:00'));
  rejects(() => bookings.createBlock(admin.id, { vehicleId: V, start: inDays(2, '08:00'), end: inDays(2, '18:00'), reason: 'טיפול' }), /יש לבטל/);
  rejects(() => bookings.createBlock(admin.id, { vehicleId: V, start: inDays(3), end: inDays(3, '12:00'), reason: '' }), /סיבת חסימה/);
  setSetting('buffer_minutes', 60);
  const b = bookings.createBlock(admin.id, { vehicleId: V, start: inDays(2, '12:00'), end: inDays(2, '18:00'), reason: 'טיפול' });
  assert.equal(b.kind, 'block', 'the turnaround buffer is not applied to blocks');
  assert.equal(b.user_id, null);
  assert.equal(b.status, 'approved');
});

// ---------- completion and calendar ----------

test('completeFinished closes only approved bookings that ended', () => {
  const u = createUser();
  const insert = (start, end, status) => Number(db.prepare(`INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status)
    VALUES (?, ?, ?, ?, ?)`).run(V, u.id, start, end, status).lastInsertRowid);
  const ended = insert(inDays(-2), inDays(-1), 'approved');
  const running = insert(inDays(-1), inDays(1), 'approved');
  const pendingPast = insert(inDays(-2), inDays(-1), 'pending');
  assert.equal(bookings.completeFinished(), 1);
  assert.equal(getBooking(ended).status, 'completed');
  assert.equal(getBooking(running).status, 'approved');
  assert.equal(getBooking(pendingPast).status, 'pending');
});

test('inRange returns entries intersecting the window, filtered by status', () => {
  const u = createUser();
  approved(u, inDays(2, '22:00'), inDays(3, '02:00'));
  request(u, inDays(3, '10:00'), inDays(3, '11:00'));
  const day3 = [inDays(3, '00:00'), inDays(4, '00:00')];
  assert.equal(bookings.inRange(V, ...day3).length, 1, 'approved only by default');
  assert.equal(bookings.inRange(V, ...day3, ['approved', 'pending']).length, 2);
  assert.equal(bookings.inRange(V, inDays(5, '00:00'), inDays(6, '00:00')).length, 0);
});

test('durationLabel shows whole days when possible', () => {
  assert.equal(bookings.durationLabel(168), '7 ימים (168 שעות)');
  assert.equal(bookings.durationLabel(24), 'יום אחד (24 שעות)');
  assert.equal(bookings.durationLabel(36), '36 שעות');
  assert.equal(bookings.durationLabel(5), '5 שעות');
});
