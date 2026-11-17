'use strict';
// Per-client configuration: each client's instance shows its own name, colour, logo and contact details, set by its
// admin in Settings → Organization, with the instance's environment variables as the starting point.
const { db, createUser, startServer, Client, PNG, outbox, storedFile } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { brand, paletteCss, contrast, rgb } = require('../../src/brand');
const mail = require('../../src/mail');

let srv, admin;

before(async () => {
  srv = await startServer();
  createUser({ role: 'admin', email: 'admin@brand.test' });
  admin = new Client(srv.base);
  await admin.login('admin@brand.test');
});
after(() => srv.close());

function brandingForm(fields = {}, logo) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (logo) fd.set('logo', new Blob([logo.data], { type: logo.type }), logo.name);
  return fd;
}
const save = async (fields, logo) => {
  const r = await admin.post('/admin/settings/branding', brandingForm(fields, logo), '/admin/settings');
  return { r, flash: admin.flash() };
};

test('defaults: the instance name, the standard colour, no logo', async () => {
  const b = brand();
  assert.equal(b.name, 'הזמנת רכב');
  assert.equal(b.customColor, false);
  const page = (await new Client(srv.base).get('/')).text;
  assert.match(page, /<title>ברוכים הבאים · הזמנת רכב<\/title>/);
  assert.doesNotMatch(page, /<style>:root/, 'no colour override');
});

test('the admin sets the client name, colour, contact details and welcome text: every page and e-mail follows', async () => {
  const { r, flash } = await save({ org_name: 'גמח רכב בני אדם', mail_from_name: 'גמח בני אדם', brand_color: '#1d4ed8',
    contact_phone: '050-1234567', contact_email: 'office@bne-adam.org', welcome_text: 'הרכב של הקהילה, בשבילכם.' });
  assert.equal(r.status, 303);
  assert.equal(flash.text, 'פרטי הארגון נשמרו');

  const home = (await new Client(srv.base).get('/')).text;
  assert.match(home, /<title>ברוכים הבאים · גמח רכב בני אדם<\/title>/);
  assert.match(home, /<span>גמח רכב בני אדם<\/span>/, 'name in the header');
  assert.match(home, /הרכב של הקהילה, בשבילכם\./);
  assert.match(home, /<meta name="theme-color" content="#1d4ed8">/);
  assert.match(home, /<style>:root\{--primary:#1d4ed8;/);
  assert.match(home, /href="tel:0501234567"/);
  assert.match((await new Client(srv.base).get('/privacy')).text, /office@bne-adam\.org/);

  await mail.send('reader@brand.test', 'בדיקת מיתוג', ['שורה'], { href: '/me', label: 'כניסה' });
  const m = outbox().find((x) => x.subject === 'בדיקת מיתוג');
  assert.match(m.body, /גמח רכב בני אדם – הודעה אוטומטית/);
  assert.match(m.body, /background:#1d4ed8/i, 'button in the client colour');
  assert.equal(brand().mailFromName, 'גמח בני אדם');
  assert.match((await admin.get('/admin/settings')).text, /שולח: <b>גמח בני אדם<\/b>|value="גמח בני אדם"/);
});

test('a colour too light for white text is darkened until it is readable, also in dark mode', () => {
  const css = paletteCss('#ffe066');
  const primary = /--primary:(#[0-9a-f]{6})/.exec(css)[1];
  assert.ok(contrast(rgb(primary), [255, 255, 255]) >= 4.5, `${primary} keeps white text readable`);
  const darkPrimary = /prefers-color-scheme: dark\)\{:root\{--primary:(#[0-9a-f]{6})/.exec(css)[1];
  assert.ok(contrast(rgb(darkPrimary), [21, 32, 29]) >= 4.5, `${darkPrimary} readable on the dark background`);
});

test('logo: uploaded, shown in the header and the tab, served publicly; replaced and removed with its file', async () => {
  const { flash } = await save({ org_name: 'גמח רכב בני אדם' }, { data: PNG, type: 'image/png', name: 'logo.png' });
  assert.equal(flash.text, 'פרטי הארגון נשמרו');
  const file = brand().logoFile;
  assert.ok(file);
  const home = (await new Client(srv.base).get('/login')).text;
  assert.match(home, new RegExp(`<img class="brand-logo" src="/brand/logo\\?v=${file}"`));
  assert.match(home, new RegExp(`<link rel="icon" href="/brand/logo\\?v=${file}">`));
  const logo = await fetch(`${srv.base}/brand/logo?v=${file}`);
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await logo.arrayBuffer()), PNG);

  await save({ org_name: 'גמח רכב בני אדם' }, { data: PNG, type: 'image/png', name: 'logo2.png' });
  assert.notEqual(brand().logoFile, file);
  assert.equal(storedFile(file), null, 'the old logo file is removed');

  const newer = brand().logoFile;
  await save({ org_name: 'גמח רכב בני אדם', remove_logo: '1' });
  assert.equal(brand().logoFile, null);
  assert.equal(storedFile(newer), null);
  assert.equal((await fetch(`${srv.base}/brand/logo`)).status, 404);
});

test('bad input is refused: a logo that is not an image, a broken contact e-mail', async () => {
  let { flash } = await save({ org_name: 'x' }, { data: Buffer.from('%PDF-1.4'), type: 'application/pdf', name: 'logo.pdf' });
  assert.match(flash.text, /הלוגו צריך להיות תמונה/);
  ({ flash } = await save({ contact_email: 'not-an-email' }));
  assert.match(flash.text, /כתובת המייל ליצירת קשר אינה תקינה/);
});

test('an empty field goes back to the instance default (environment variable, then built-in)', async () => {
  process.env.BRAND_COLOR = '#7c3aed';
  process.env.CONTACT_EMAIL = 'env@bne-adam.org';
  try {
    await save({ org_name: '', mail_from_name: '', brand_color: '#0b7a63', contact_email: '', contact_phone: '', welcome_text: '' });
    const b = brand();
    assert.equal(b.name, 'הזמנת רכב');
    assert.equal(b.color, '#7c3aed', 'BRAND_COLOR from the instance environment');
    assert.equal(b.contactEmail, 'env@bne-adam.org');
    assert.equal(b.mailFromName, 'הזמנת רכב', 'mail shows the client name, never just the address');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM branding WHERE key IN ('org_name','brand_color','contact_email')").get().n, 0);
  } finally {
    delete process.env.BRAND_COLOR;
    delete process.env.CONTACT_EMAIL;
  }
});

test('only admins change the client settings', async () => {
  createUser({ email: 'user@brand.test' });
  const user = new Client(srv.base);
  await user.login('user@brand.test');
  const r = await user.post('/admin/settings/branding', brandingForm({ org_name: 'פרוץ' }), '/me');
  assert.equal(r.status, 403);
  assert.notEqual(brand().name, 'פרוץ');
});
