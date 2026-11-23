'use strict';
// The car itself (decision D2 of the release plan): a car "in service" refuses new requests, approvals and automatic
// approvals, keeps the approved bookings and lists them for the manager, and goes back to service with one button.
// Also a new site's empty car: booking stays closed until a plate is entered.
const { db, createUser, startServer, Client, inDays, getBooking } = require('../helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bookings = require('../../src/bookings');
const { setSetting, defaultVehicle } = require('../../src/db');

let srv, admin, adminUser;

before(async () => {
  srv = await startServer();
  adminUser = createUser({ role: 'admin', email: 'admin@vehicle.test' });
  admin = new Client(srv.base);
  await admin.login('admin@vehicle.test');
});
after(() => srv.close());

beforeEach(() => {
  db.exec('DELETE FROM booking_history; DELETE FROM bookings');
  db.prepare("UPDATE vehicles SET status = 'available', plate = '12-345-67'").run();
  setSetting('auto_approve', '0');
});

const vehicleForm = (fields) => ({ plate: '12-345-67', make: 'טויוטה', model: 'קורולה', status: 'available', ...fields });

test('the plate is required: an empty one (or the old placeholder) is refused and nothing changes', async () => {
  for (const plate of ['', '00-000-00']) {
    const r = await admin.post('/admin/vehicle', vehicleForm({ plate }), '/admin/vehicle');
    assert.equal(r.status, 303);
    assert.equal(r.location, '/admin/vehicle');
    assert.match(admin.flash().text, /מספר הרישוי/);
  }
  assert.equal(defaultVehicle().plate, '12-345-67');
});

test('a car put in service: requests, approvals and automatic approvals are refused; approved bookings stay and are listed', async () => {
  const driver = createUser({ email: 'driver@vehicle.test' });
  const kept = Number(db.prepare(`INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status) VALUES (?, ?, ?, ?, 'approved')`)
    .run(defaultVehicle().id, driver.id, inDays(2), inDays(3)).lastInsertRowid);
  const waiting = Number(db.prepare(`INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status) VALUES (?, ?, ?, ?, 'pending')`)
    .run(defaultVehicle().id, driver.id, inDays(5), inDays(6)).lastInsertRowid);

  const r = await admin.post('/admin/vehicle', vehicleForm({ status: 'service', insurance_renewal: 'not a date' }), '/admin/vehicle');
  assert.equal(r.status, 303);
  assert.match(admin.flash().text, /הרכב בטיפול/);
  assert.equal(defaultVehicle().status, 'service');
  assert.equal(defaultVehicle().insurance_renewal, null, 'an invalid date is not stored');

  // The vehicle page lists the approved booking, with a way to reach its owner.
  const page = await admin.get('/admin/vehicle');
  assert.match(page.text, /id="service"/);
  assert.match(page.text, new RegExp(`/admin/bookings/${kept}`));
  assert.match(page.text, /driver@vehicle\.test/);

  // A user's new request is refused.
  const user = new Client(srv.base);
  await user.login('driver@vehicle.test');
  const req = await user.post('/bookings/new', { start: inDays(10), end: inDays(11), accept_rules: '1' }, '/me');
  assert.equal(req.status, 303);
  assert.equal(req.location, '/calendar');
  assert.match(user.flash().text, /בטיפול/);
  // And the booking rules refuse it too (whatever the page does).
  assert.throws(() => bookings.createRequest(driver, { vehicleId: defaultVehicle().id, start: inDays(10), end: inDays(11) }), /הרכב בטיפול/);

  // The manager can't approve the waiting request either.
  assert.throws(() => bookings.approve(waiting, adminUser.id), /הרכב בטיפול/);
  // And an automatic approval quietly leaves it waiting.
  setSetting('auto_approve', '1');
  assert.equal(bookings.autoApprove(getBooking(waiting)), null);
  assert.equal(getBooking(waiting).status, 'pending');
  assert.equal(getBooking(kept).status, 'approved', 'the approved booking stays');

  // Saving again while still in service: the plain "saved" message.
  await admin.post('/admin/vehicle', vehicleForm({ status: 'service' }), '/admin/vehicle');
  assert.equal(admin.flash().text, 'פרטי הרכב נשמרו');

  // One button brings it back.
  const back = await admin.post('/admin/vehicle/available', {}, '/admin/vehicle');
  assert.equal(back.status, 303);
  assert.equal(back.location, '/admin/vehicle');
  assert.equal(defaultVehicle().status, 'available');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'vehicle.update' AND details = 'available'").get().n, 1);
  const ok = await user.post('/bookings/new', { start: inDays(10), end: inDays(11), accept_rules: '1' }, '/bookings/new');
  assert.equal(ok.status, 200);
});

test('in service with no approved bookings ahead: says so', async () => {
  db.prepare("UPDATE vehicles SET status = 'service'").run();
  const page = await admin.get('/admin/vehicle');
  assert.match(page.text, /אין הזמנות מאושרות קרובות/);
});

test('an empty car (new site): the page says booking is closed and requests are refused', async () => {
  db.prepare("UPDATE vehicles SET plate = ''").run();
  const page = await admin.get('/admin/vehicle');
  assert.match(page.text, /הזמנות סגורות עד שיוזנו פרטי הרכב/);
  const driver = createUser();
  assert.throws(() => bookings.createRequest(driver, { vehicleId: defaultVehicle().id, start: inDays(3), end: inDays(4) }), /פרטי הרכב עדיין לא הוזנו/);
});
