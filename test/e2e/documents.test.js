'use strict';
// Vehicle documents (vehicle license, insurance…): upload, storage with the data, who may open them, expiry.
const { db, createUser, startServer, Client, PNG, storedFile } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const time = require('../../src/time');

let srv, admin, driver;
const PDF = Buffer.from('%PDF-1.4\n% vehicle insurance\n');

before(async () => {
  srv = await startServer();
  createUser({ role: 'admin', email: 'admin@docs.test' });
  createUser({ email: 'driver@docs.test' });
  admin = new Client(srv.base);
  driver = new Client(srv.base);
  await admin.login('admin@docs.test');
  await driver.login('driver@docs.test');
});
after(() => srv.close());

function docForm({ kind = 'registration', expires = '', title = '', visible = true, file = PNG, type = 'image/png', name = 'רישיון רכב.png' } = {}) {
  const fd = new FormData();
  fd.set('kind', kind);
  if (expires) fd.set('expires_at', expires);
  if (title) fd.set('title', title);
  if (visible) fd.set('visible_to_drivers', '1');
  if (file) fd.set('document', new Blob([file], { type }), name);
  return fd;
}
const upload = async (opts) => {
  const r = await admin.post('/admin/vehicle/documents', docForm(opts), '/admin/vehicle');
  return { r, flash: admin.flash(), doc: db.prepare('SELECT * FROM vehicle_documents ORDER BY id DESC LIMIT 1').get() };
};
const vehicle = () => db.prepare('SELECT * FROM vehicles WHERE id = 1').get();

test('admin uploads the vehicle license: stored with the data, listed, and opens as the same file', async () => {
  const expires = time.addDays(time.today(), 300);
  const { r, flash, doc } = await upload({ expires });
  assert.equal(r.status, 303);
  assert.equal(r.location, '/admin/vehicle#documents');
  assert.match(flash.text, /נשמר ומועד החידוש של הרכב עודכן/);
  assert.equal(doc.kind, 'registration');
  assert.equal(doc.original_name, 'רישיון רכב.png', 'Hebrew file name kept');
  assert.deepEqual(storedFile(doc.file), PNG, 'file stored (in the database when it is hosted)');
  assert.equal(vehicle().registration_renewal, expires, 'vehicle license renewal date follows the document');

  const page = (await admin.get('/admin/vehicle')).text;
  assert.match(page, /מסמכי הרכב/);
  assert.match(page, new RegExp(`href="/vehicle/documents/${doc.id}"`));
  assert.match(page, /גלוי לנהגים/);

  const file = await fetch(`${srv.base}/vehicle/documents/${doc.id}`, { headers: { cookie: `sid=${admin.cookies.sid}` } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal(file.headers.get('cache-control'), 'private, no-store');
  assert.match(file.headers.get('content-disposition'), /^inline; filename\*=UTF-8''/);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'vehicle.document_view'").get(), 'viewing is logged');
});

test('insurance: the vehicle insurance date is the earliest of the newest mandatory and comprehensive policies', async () => {
  const later = time.addDays(time.today(), 200);
  const sooner = time.addDays(time.today(), 90);
  await upload({ kind: 'insurance_comprehensive', expires: later, file: PDF, type: 'application/pdf', name: 'policy.pdf' });
  assert.equal(vehicle().insurance_renewal, later);
  await upload({ kind: 'insurance_mandatory', expires: sooner, file: PDF, type: 'application/pdf', name: 'mandatory.pdf' });
  assert.equal(vehicle().insurance_renewal, sooner);
});

test('drivers: active users open documents marked visible, never hidden ones; others cannot', async () => {
  const { doc: shown } = await upload({ kind: 'other', title: 'כרטיס דלק', visible: true });
  const { doc: hidden } = await upload({ kind: 'other', title: 'חשבונית טיפול', visible: false });

  const list = (await driver.get('/vehicle/documents')).text;
  assert.match(list, /כרטיס דלק/);
  assert.doesNotMatch(list, /חשבונית טיפול/);
  assert.match((await driver.get('/me')).text, /href="\/vehicle\/documents"/, 'a "vehicle documents" tile in the personal area');
  assert.equal((await driver.get(`/vehicle/documents/${shown.id}`)).status, 200);
  const blocked = await driver.get(`/vehicle/documents/${hidden.id}`);
  assert.equal(blocked.status, 302, 'a hidden document is not served');
  assert.equal(blocked.location, '/vehicle/documents');

  const pending = new Client(srv.base);
  createUser({ email: 'pending@docs.test', status: 'pending' });
  await pending.login('pending@docs.test');
  assert.equal((await pending.get(`/vehicle/documents/${shown.id}`)).status, 302, 'not for accounts that are not active');
  assert.match((await pending.get('/vehicle/documents')).text, /למשתמשים פעילים בלבד/);
  assert.equal((await new Client(srv.base).get(`/vehicle/documents/${shown.id}`)).status, 401, 'not without logging in');
});

test('admin hides, shows and deletes a document; the file is removed too', async () => {
  const { doc } = await upload({ kind: 'other', title: 'למחיקה' });
  await admin.post(`/admin/vehicle/documents/${doc.id}/visibility`, {}, '/admin/vehicle');
  assert.equal(db.prepare('SELECT visible_to_drivers FROM vehicle_documents WHERE id = ?').get(doc.id).visible_to_drivers, 0);
  assert.match(admin.flash().text, /מוסתר עכשיו מנהגים/);
  await admin.post(`/admin/vehicle/documents/${doc.id}/visibility`, {}, '/admin/vehicle');
  assert.equal(db.prepare('SELECT visible_to_drivers FROM vehicle_documents WHERE id = ?').get(doc.id).visible_to_drivers, 1);

  await admin.post(`/admin/vehicle/documents/${doc.id}/delete`, {}, '/admin/vehicle');
  assert.equal(db.prepare('SELECT 1 FROM vehicle_documents WHERE id = ?').get(doc.id), undefined);
  assert.equal(storedFile(doc.file), null, 'file deleted');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'vehicle.document_delete'").get());
});

test('bad uploads are refused with a message and store nothing', async () => {
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM vehicle_documents').get().n;
  const before = count();
  assert.match((await upload({ file: null })).flash.text, /יש לבחור קובץ/);
  assert.match((await upload({ file: Buffer.from('hello'), type: 'text/plain', name: 'a.txt' })).flash.text, /יש לבחור קובץ/, 'only images and PDF');
  assert.match((await upload({ kind: 'passport' })).flash.text, /סוג המסמך/);
  assert.match((await upload({ expires: '2027-02-31' })).flash.text, /תאריך התוקף אינו תקין/);
  assert.equal(count(), before);
});

test('only admins upload, hide or delete', async () => {
  const doc = db.prepare('SELECT * FROM vehicle_documents LIMIT 1').get();
  const r = await driver.post('/admin/vehicle/documents', docForm(), '/me');
  assert.equal(r.status, 403);
  for (const action of ['visibility', 'delete']) {
    assert.equal((await driver.post(`/admin/vehicle/documents/${doc.id}/${action}`, {}, '/me')).status, 403);
  }
  assert.ok(db.prepare('SELECT 1 FROM vehicle_documents WHERE id = ?').get(doc.id), 'still there');
});

test('an "other" document about to expire shows up in the dashboard alerts', async () => {
  await upload({ kind: 'other', title: 'אישור טסט', expires: time.addDays(time.today(), 10) });
  assert.match((await admin.get('/admin')).text, /מסמך (&quot;|")אישור טסט(&quot;|"): בתוקף עד/);
});
