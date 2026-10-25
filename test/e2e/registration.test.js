'use strict';
// A failed registration keeps the uploaded license and the password, so they needn't be entered again.
const { db, startServer, Client, registrationForm, storedFile, PNG } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let srv;
const client = () => new Client(srv.base);
before(async () => { srv = await startServer(); });
after(() => srv.close());

const draftToken = (page) => /name="draft" value="([^"]+)"/.exec(page)?.[1];

test('after an error the license and password are kept; resubmitting without them succeeds', async () => {
  const c = client();
  const first = await c.post('/register', registrationForm({
    email: 'keep@test.org', id_number: '123456789', password: 'MySecret123', licenseName: 'רישיון.png',
  }));
  assert.equal(first.status, 400);
  assert.match(first.text, /תעודת הזהות אינו תקין/);
  const token = draftToken(first.text);
  assert.ok(token, 'draft token in the form');
  assert.match(first.text, /✓ הקובץ <b dir="auto">רישיון.png<\/b> נשמר/, 'Hebrew file name shown correctly');
  assert.match(first.text, /✓ הסיסמה שהזנת נשמרה/);
  assert.doesNotMatch(first.text, /MySecret123/, 'the password is never written into the page');
  assert.match(first.text, /name="license" accept="image\/\*,application\/pdf">/, 'file no longer required');
  assert.match(first.text, /name="accept_policy" value="1" required checked/, 'consent checkboxes stay ticked');
  assert.match(first.text, /value="keep@test.org"/);

  const second = await c.post('/register', registrationForm({
    email: 'keep@test.org', id_number: '123456782', password: null, license: null, draft: token,
  }));
  assert.equal(second.status, 302, 'no need to upload or type the password again');
  const u = db.prepare("SELECT * FROM users WHERE email = 'keep@test.org'").get();
  assert.equal(String(storedFile(u.license_file)), String(PNG), 'the license uploaded in the first attempt');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM registration_drafts').get().n, 0, 'draft removed');
  await new Client(srv.base).login('keep@test.org', 'MySecret123'); // the password from the first attempt works
});

test('a new file or password in a later attempt replaces the kept one', async () => {
  const c = client();
  const first = await c.post('/register', registrationForm({ email: 'replace@test.org', phone: '123', password: 'FirstPass1' }));
  const token = draftToken(first.text);
  const oldFile = db.prepare('SELECT license_file FROM registration_drafts').all().map((r) => r.license_file).pop();
  const second = await c.post('/register', registrationForm({
    email: 'replace@test.org', draft: token, password: 'SecondPass2',
    licenseBlob: new Blob(['%PDF-1.4 new'], { type: 'application/pdf' }), licenseName: 'new.pdf',
  }));
  assert.equal(second.status, 302);
  const u = db.prepare("SELECT * FROM users WHERE email = 'replace@test.org'").get();
  assert.match(u.license_file, /\.pdf$/);
  assert.equal(storedFile(oldFile), null, 'replaced upload deleted');
  await new Client(srv.base).login('replace@test.org', 'SecondPass2');
});

test('a too-short password is not kept, the earlier one stays', async () => {
  const c = client();
  const first = await c.post('/register', registrationForm({ email: 'pw@test.org', phone: '1', password: 'GoodPass1' }));
  const token = draftToken(first.text);
  const second = await c.post('/register', registrationForm({ email: 'pw@test.org', draft: token, license: null, password: 'short' }));
  assert.equal(second.status, 400);
  assert.match(second.text, /לפחות 8 תווים/);
  assert.match(second.text, /✓ הסיסמה שהזנת נשמרה/);
  const third = await c.post('/register', registrationForm({ email: 'pw@test.org', draft: draftToken(second.text), license: null, password: null }));
  assert.equal(third.status, 302);
  await new Client(srv.base).login('pw@test.org', 'GoodPass1');
});

test('a forged or expired draft token gives nothing', async () => {
  const forged = await client().post('/register', registrationForm({ email: 'forged@test.org', license: null, password: null, draft: 'not-a-real-token' }));
  assert.equal(forged.status, 400);
  assert.match(forged.text, /יש להעלות צילום רישיון/);

  const c = client();
  const first = await c.post('/register', registrationForm({ email: 'old@test.org', phone: '1' }));
  db.prepare('UPDATE registration_drafts SET expires_at = ?').run(Date.now() - 1);
  const late = await c.post('/register', registrationForm({ email: 'old@test.org', license: null, draft: draftToken(first.text) }));
  assert.equal(late.status, 400);
  assert.match(late.text, /יש להעלות צילום רישיון/);
});
