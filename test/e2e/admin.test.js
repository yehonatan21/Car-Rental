'use strict';
// Admin workflows: licenses, user lifecycle, manual bookings, vehicle, settings, policies, 2FA, OTP login.
const { db, createUser, getUser, getBooking, inDays, startServer, Client, outbox, dataDir, PNG } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('../../src/auth');
const { getSettings } = require('../../src/db');
const time = require('../../src/time');

let srv, admin;
const client = () => new Client(srv.base);
const year = () => time.addDays(time.today(), 365);
const totpNow = (secret) => auth.totpAt(secret, Math.floor(Date.now() / 30000));
const wrongTotp = (secret) => (totpNow(secret) === '000000' ? '111111' : '000000');

before(async () => {
  srv = await startServer();
  createUser({ role: 'admin', email: 'admin@adm.test' });
  admin = client();
  await admin.login('admin@adm.test');
});
after(() => srv.close());

function licenseForm(expiry) {
  const fd = new FormData();
  fd.set('license_expiry', expiry);
  fd.set('license', new Blob([PNG], { type: 'image/png' }), 'new.png');
  return fd;
}

test('license renewal: upload → pending review → admin approves → old file removed', async () => {
  fs.writeFileSync(path.join(dataDir, 'licenses', 'old.png'), 'old');
  const u = createUser({ email: 'renew@adm.test', status: 'license_update', license_file: 'old.png', license_expiry: time.addDays(time.today(), -2) });
  const c = client();
  await c.login('renew@adm.test');
  await c.post('/me/license', licenseForm(time.addDays(time.today(), 700)), '/me/license');
  let row = getUser(u.id);
  assert.ok(row.pending_license_file);
  assert.equal(row.license_file, 'old.png', 'old license kept until approved');
  assert.ok(outbox().some((m) => m.subject === 'רישיון נהיגה חדש ממתין לבדיקה'));
  assert.match((await admin.get(`/admin/users/${u.id}`)).text, /רישיון חדש שהועלה/);
  assert.equal((await admin.get(`/admin/users/${u.id}/license?pending=1`)).status, 200);

  await admin.post(`/admin/users/${u.id}/license/approve`, { license_expiry: time.addDays(time.today(), 690) }, `/admin/users/${u.id}`);
  row = getUser(u.id);
  assert.equal(row.status, 'active', 'reactivated');
  assert.equal(row.license_expiry, time.addDays(time.today(), 690), 'admin-verified date wins');
  assert.equal(row.pending_license_file, null);
  assert.ok(!fs.existsSync(path.join(dataDir, 'licenses', 'old.png')));
  assert.ok(fs.existsSync(path.join(dataDir, 'licenses', row.license_file)));
});

test('license upload validation', async () => {
  const u = createUser({ email: 'upl@adm.test' });
  const c = client();
  await c.login('upl@adm.test');
  await c.post('/me/license', licenseForm(time.addDays(time.today(), -1)), '/me/license');
  assert.match(c.flash().text, /תאריך תוקף עתידי/);
  assert.equal(getUser(u.id).pending_license_file, null, 'rejected upload is discarded');
});

test('admin can reject a newly uploaded license', async () => {
  const u = createUser({ email: 'rej-lic@adm.test' });
  const c = client();
  await c.login('rej-lic@adm.test');
  await c.post('/me/license', licenseForm(year()), '/me/license');
  const pending = getUser(u.id).pending_license_file;
  await admin.post(`/admin/users/${u.id}/license/reject`, { note: 'התמונה מטושטשת' }, `/admin/users/${u.id}`);
  assert.equal(getUser(u.id).pending_license_file, null);
  assert.ok(!fs.existsSync(path.join(dataDir, 'licenses', pending)));
  assert.ok(outbox().some((m) => m.subject === 'נדרש עדכון רישיון נהיגה' && m.body.includes('התמונה מטושטשת')));
});

test('user lifecycle: reject, request license, block, reactivate', async () => {
  const pending = createUser({ status: 'pending', email: 'p@adm.test' });
  await admin.post(`/admin/users/${pending.id}/reject`, { note: 'לא מוכר' }, `/admin/users/${pending.id}`);
  assert.equal(getUser(pending.id).status, 'rejected');
  assert.ok(outbox().some((m) => m.subject === 'עדכון לגבי בקשת ההרשמה'));

  const u = createUser({ email: 'life@adm.test' });
  await admin.post(`/admin/users/${u.id}/request-license`, {}, `/admin/users/${u.id}`);
  assert.equal(getUser(u.id).status, 'license_update');
  await admin.post(`/admin/users/${u.id}/approve`, { license_expiry: year() }, `/admin/users/${u.id}`);
  assert.equal(getUser(u.id).status, 'active');
  await admin.post(`/admin/users/${u.id}/block`, {}, `/admin/users/${u.id}`);
  assert.equal(getUser(u.id).status, 'blocked');
  assert.ok(outbox().some((m) => m.subject === 'החשבון שלך הושהה'));
  await admin.post(`/admin/users/${u.id}/approve`, { license_expiry: year() }, `/admin/users/${u.id}`);
  assert.equal(getUser(u.id).status, 'active');
});

test('approval requires a future license date', async () => {
  const u = createUser({ status: 'pending' });
  await admin.post(`/admin/users/${u.id}/approve`, { license_expiry: time.addDays(time.today(), -1) }, `/admin/users/${u.id}`);
  assert.equal(getUser(u.id).status, 'pending');
  assert.match(admin.flash().text, /אינו עתידי/);
});

test('admin note and role changes are saved and audited', async () => {
  const u = createUser();
  await admin.post(`/admin/users/${u.id}/note`, { admin_note: 'נהג/ת זהיר/ה' }, `/admin/users/${u.id}`);
  assert.equal(getUser(u.id).admin_note, 'נהג/ת זהיר/ה');
  await admin.post(`/admin/users/${u.id}/role`, {}, `/admin/users/${u.id}`);
  assert.equal(getUser(u.id).role, 'admin');
  await admin.post(`/admin/users/${u.id}/role`, {}, `/admin/users/${u.id}`);
  assert.equal(getUser(u.id).role, 'user');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.role' AND target_id = ?").get(u.id).n, 2);
  assert.match((await admin.get('/admin/audit')).text, /user\.role/);
});

test('user search and status filter', async () => {
  createUser({ first_name: 'זאב', last_name: 'חיפושי', email: 'search@adm.test', status: 'pending' });
  let r = await admin.get('/admin/users?q=חיפושי');
  assert.match(r.text, /search@adm.test/);
  r = await admin.get('/admin/users?status=blocked&q=חיפושי');
  assert.doesNotMatch(r.text, /search@adm.test/);
  r = await admin.get('/admin/users?q=search@adm');
  assert.match(r.text, /זאב חיפושי/);
});

test('manual booking is approved and optionally e-mails the user', async () => {
  const u = createUser({ email: 'manual@adm.test' });
  const r = await admin.post('/admin/bookings/new', { user_id: u.id, start: inDays(20, '09:00'), end: inDays(20, '12:00'), notify: '1' }, '/admin/bookings/new');
  assert.equal(r.status, 302);
  const b = db.prepare('SELECT * FROM bookings WHERE user_id = ?').get(u.id);
  assert.equal(b.status, 'approved');
  assert.ok(outbox().some((m) => m.subject === 'ההזמנה אושרה' && m.to.includes('manual@adm.test')));
  await admin.post('/admin/bookings/new', { user_id: u.id, start: inDays(20, '10:00'), end: inDays(20, '11:00') }, '/admin/bookings/new');
  assert.match(admin.flash().text, /תפוס/);
});

test('booking search filters', async () => {
  const u = createUser({ first_name: 'מסנן', last_name: 'בדיקה' });
  db.prepare(`INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status, purpose) VALUES (1, ?, ?, ?, 'pending', 'יעד-ייחודי')`)
    .run(u.id, inDays(30), inDays(30, '12:00'));
  assert.match((await admin.get('/admin/bookings?q=מסנן')).text, /יעד-ייחודי/);
  assert.match((await admin.get('/admin/bookings?q=יעד-ייחודי&status=pending')).text, /מסנן בדיקה/);
  assert.doesNotMatch((await admin.get('/admin/bookings?q=יעד-ייחודי&status=approved')).text, /מסנן בדיקה/);
  assert.doesNotMatch((await admin.get(`/admin/bookings?q=מסנן&to=${time.today()}`)).text, /יעד-ייחודי/);
  assert.match((await admin.get(`/admin/bookings?q=מסנן&from=${time.addDays(time.today(), 29)}`)).text, /יעד-ייחודי/);
});

test('removing a maintenance block frees the slot', async () => {
  await admin.post('/admin/blocks/new', { start: inDays(40, '08:00'), end: inDays(40, '12:00'), reason: 'טסט' }, '/admin/blocks/new');
  const block = db.prepare("SELECT * FROM bookings WHERE kind = 'block' AND block_reason = 'טסט'").get();
  await admin.post(`/admin/bookings/${block.id}/cancel`, {}, `/admin/bookings/${block.id}`);
  assert.equal(getBooking(block.id).status, 'cancelled');
});

test('vehicle details and disabled status', async () => {
  await admin.post('/admin/vehicle', {
    plate: '98-765-43', make: 'קיה', model: 'נירו', status: 'disabled', insurance_renewal: time.addDays(time.today(), 3),
    registration_renewal: 'not-a-date', next_service: '', instructions: 'קוד שער 1234', notes: 'שריטה בדלת',
  }, '/admin/vehicle');
  const v = db.prepare('SELECT * FROM vehicles WHERE id = 1').get();
  assert.equal(v.plate, '98-765-43');
  assert.equal(v.status, 'disabled');
  assert.equal(v.registration_renewal, null, 'invalid dates ignored');
  assert.match((await admin.get('/admin')).text, /חידוש ביטוח/, 'dashboard alert');
  createUser({ email: 'veh@adm.test' });
  const c = client();
  await c.login('veh@adm.test');
  const r = await c.post('/bookings/new', { start: inDays(50), end: inDays(50, '12:00'), accept_rules: '1' }, '/bookings/new');
  assert.match(r.text, /מושבת/);
  await admin.post('/admin/vehicle', { plate: '98-765-43', status: 'available' }, '/admin/vehicle');
});

test('settings: valid numbers saved, invalid ignored', async () => {
  await admin.post('/admin/settings', { buffer_minutes: '15', cancel_hours_before: '-5', max_booking_hours: 'abc', max_open_bookings: '2',
    pickup_reminder_hours: '24', return_reminder_hours: '2', pending_alert_hours: '24', license_warn_days: '30' }, '/admin/settings');
  const s = getSettings();
  assert.equal(s.buffer_minutes, 15);
  assert.equal(s.cancel_hours_before, 24, 'negative ignored');
  assert.equal(s.max_booking_hours, 168, 'non-numeric ignored');
  assert.equal(s.max_open_bookings, 2);
});

test('policy versions are listed with acceptance counts', async () => {
  await admin.post('/admin/policies', { content: '' }, '/admin/policies');
  assert.match(admin.flash().text, /ריק/);
  await admin.post('/admin/policies', { content: '# גרסה חדשה\n\n- כלל' }, '/admin/policies');
  const page = (await admin.get('/admin/policies')).text;
  assert.match(page, /גרסה חדשה/);
  assert.match((await client().get('/policy')).text, /גרסה 2/);
});

test('two-factor authentication for admins', async () => {
  const a2 = createUser({ role: 'admin', email: 'twofa@adm.test' });
  const c = client();
  await c.login('twofa@adm.test');
  await c.post('/me/2fa/start', {}, '/me/security');
  const secret = getUser(a2.id).totp_secret;
  assert.ok(secret);
  assert.match((await c.get('/me/security')).text, /data:image\/png;base64/, 'QR code shown');
  await c.post('/me/2fa/enable', { code: wrongTotp(secret) }, '/me/security');
  assert.equal(getUser(a2.id).totp_enabled, 0, 'wrong code does not enable');
  await c.post('/me/2fa/enable', { code: totpNow(secret) }, '/me/security');
  assert.equal(getUser(a2.id).totp_enabled, 1);

  const fresh = client();
  const r = await fresh.post('/login', { email: 'twofa@adm.test', password: 'Password1' });
  assert.equal(r.location, '/login/2fa');
  assert.equal((await fresh.get('/admin')).location, '/login/2fa', 'not logged in before the second factor');
  await fresh.post('/login/2fa', { code: wrongTotp(secret) }, '/login/2fa');
  assert.equal((await fresh.get('/admin')).status, 302);
  const ok = await fresh.post('/login/2fa', { code: totpNow(secret) }, '/login/2fa');
  assert.equal(ok.location, '/admin');
  assert.equal((await fresh.get('/admin')).status, 200);

  await c.post('/me/2fa/disable', { code: totpNow(secret) }, '/me/security');
  assert.equal(getUser(a2.id).totp_enabled, 0);
});

test('one-time code login via e-mail', async () => {
  createUser({ email: 'otp@adm.test' });
  const c = client();
  await c.post('/login/code', { email: 'otp@adm.test' });
  const mail = outbox().filter((m) => m.subject === 'קוד התחברות' && m.to.includes('otp@adm.test')).pop();
  const code = /(\d{6})/.exec(mail.body)[1];
  const bad = await c.post('/login/code/verify', { email: 'otp@adm.test', code: code === '000000' ? '111111' : '000000' });
  assert.equal(bad.status, 401);
  const r = await c.post('/login/code/verify', { email: 'otp@adm.test', code });
  assert.equal(r.location, '/calendar');
});

test('password change requires the current password and logs out other sessions', async () => {
  createUser({ email: 'pw@adm.test' });
  const a = client();
  const b = client();
  await a.login('pw@adm.test');
  await b.login('pw@adm.test');
  await a.post('/me/password', { current: 'wrong', password: 'NewPassword1' }, '/me/security');
  assert.match(a.flash().text, /שגויה/);
  await a.post('/me/password', { current: 'Password1', password: 'NewPassword1' }, '/me/security');
  assert.equal((await a.get('/me')).status, 200, 'current session kept');
  assert.equal((await b.get('/me')).status, 302, 'other session logged out');
  await client().login('pw@adm.test', 'NewPassword1');
});

test('profile: phone can be updated, invalid phone rejected', async () => {
  const u = createUser({ email: 'phone@adm.test' });
  const c = client();
  await c.login('phone@adm.test');
  await c.post('/me/profile', { phone: '052-999 8877' });
  assert.equal(getUser(u.id).phone, '0529998877');
  await c.post('/me/profile', { phone: '123' });
  assert.match(c.flash().text, /אינו תקין/);
  assert.equal(getUser(u.id).phone, '0529998877');
});
