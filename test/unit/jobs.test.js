'use strict';
const { createUser, getUser, getBooking, inDays, db, outbox, clearOutbox } = require('../helpers');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { runJobs } = require('../../src/jobs');
const time = require('../../src/time');

createUser({ role: 'admin', email: 'admin@jobs.test' }); // receives admin alerts

beforeEach(() => {
  db.exec("DELETE FROM booking_history; DELETE FROM bookings; DELETE FROM users WHERE role = 'user'");
  clearOutbox();
});

const insertBooking = (userId, start, end, status = 'approved', extra = '') => Number(db.prepare(
  `INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status${extra ? ', created_at' : ''}) VALUES (1, ?, ?, ?, ?${extra ? ', ?' : ''})`,
).run(...[userId, start, end, status, ...(extra ? [extra] : [])]).lastInsertRowid);

const subjects = () => outbox().map((m) => m.subject);

test('pickup and return reminders are sent once', async () => {
  const u = createUser({ email: 'driver@jobs.test' });
  const pickup = insertBooking(u.id, time.addMinutes(time.now(), 120), time.addMinutes(time.now(), 300));
  const ret = insertBooking(u.id, time.addMinutes(time.now(), -60), time.addMinutes(time.now(), 60));
  const far = insertBooking(u.id, inDays(5), inDays(6));
  await runJobs();
  await runJobs();
  const s = subjects();
  assert.equal(s.filter((x) => x.includes('איסוף')).length, 1);
  assert.equal(s.filter((x) => x.includes('החזרת')).length, 1);
  assert.equal(getBooking(pickup).pickup_reminded, 1);
  assert.equal(getBooking(ret).return_reminded, 1);
  assert.equal(getBooking(far).pickup_reminded, 0);
  assert.ok(outbox().every((m) => m.to.includes('driver@jobs.test')));
});

test('admins are alerted about requests pending too long, once', async () => {
  const u = createUser();
  const old = time.addMinutes(time.now(), -26 * 60).replace('T', ' ') + ':00';
  const stale = insertBooking(u.id, inDays(3), inDays(4), 'pending', old);
  const fresh = insertBooking(u.id, inDays(5), inDays(6), 'pending');
  await runJobs();
  await runJobs();
  const alerts = outbox().filter((m) => m.subject.includes('ממתינות זמן רב'));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].to, /admin@jobs.test/);
  assert.equal(getBooking(stale).pending_alerted, 1);
  assert.equal(getBooking(fresh).pending_alerted, 0);
});

test('expired licenses move users to "license_update" and notify admins', async () => {
  const expired = createUser({ license_expiry: time.addDays(time.today(), -1) });
  const valid = createUser({ license_expiry: time.today() });
  await runJobs();
  assert.equal(getUser(expired.id).status, 'license_update');
  assert.equal(getUser(valid.id).status, 'active', 'valid through its last day');
  assert.ok(subjects().some((s) => s.includes('רישיונות נהיגה שפג תוקפם')));
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'user.license_expired' AND target_id = ?").get(expired.id));
});

test('users are warned once before their license expires, and again after renewing', async () => {
  const u = createUser({ license_expiry: time.addDays(time.today(), 10), email: 'soon@jobs.test' });
  createUser({ license_expiry: time.addDays(time.today(), 90) });
  await runJobs();
  await runJobs();
  assert.equal(subjects().filter((s) => s.includes('עומד לפוג')).length, 1);
  db.prepare('UPDATE users SET license_expiry = ? WHERE id = ?').run(time.addDays(time.today(), 20), u.id);
  await runJobs();
  assert.equal(subjects().filter((s) => s.includes('עומד לפוג')).length, 2);
});

test('jobs close finished bookings and purge expired sessions', async () => {
  const u = createUser();
  const done = insertBooking(u.id, inDays(-3), inDays(-2));
  db.prepare("INSERT INTO sessions (token_hash, user_id, csrf, expires_at) VALUES ('old', ?, 'x', ?)").run(u.id, Date.now() - 1000);
  await runJobs();
  assert.equal(getBooking(done).status, 'completed');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = 'old'").get().n, 0);
});
