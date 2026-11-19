'use strict';
// Accessibility (WCAG 2.1 AA / SI 5568): the statement and its coordinator, labels, names that match what is shown,
// brand colours that keep their contrast.
const { createUser, startServer, Client } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { paletteCss, contrast, rgb } = require('../../src/brand');

let srv, admin;
before(async () => {
  srv = await startServer();
  createUser({ role: 'admin', email: 'a11y-admin@test.org' });
  admin = new Client(srv.base);
  await admin.login('a11y-admin@test.org');
});
after(() => srv.close());

test('the accessibility statement: public, linked from every page, with placeholders until the coordinator is set', async () => {
  const visitor = new Client(srv.base);
  const page = await visitor.get('/accessibility');
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1>הצהרת נגישות<\/h1>/);
  assert.match(page.text, /ת"י 5568/);
  assert.match(page.text, /\[יש להשלים: שם רכז\/ת הנגישות\]/);
  for (const path of ['/', '/login', '/register']) assert.match((await visitor.get(path)).text, /<a href="\/accessibility">הצהרת נגישות<\/a>/, path);
  assert.match((await admin.get('/admin')).text, /href="\/accessibility"/);
  assert.match((await admin.get('/accessibility')).text, /חסרים פרטי רכז\/ת הנגישות/, 'the manager is told what is missing');

  const fd = new FormData();
  for (const [k, v] of Object.entries({ a11y_name: 'רינה כהן', a11y_phone: '03-1234567', a11y_email: 'access@test.org' })) fd.set(k, v);
  await admin.post('/admin/settings/branding', fd, '/admin/settings?tab=general');
  const filled = (await visitor.get('/accessibility')).text;
  assert.match(filled, /רינה כהן/);
  assert.match(filled, /mailto:access@test.org/);
  assert.doesNotMatch(filled, /יש להשלים/);
  const bad = new FormData();
  bad.set('a11y_email', 'not-an-email');
  await admin.post('/admin/settings/branding', bad, '/admin/settings?tab=general');
  assert.match(admin.flash().text, /רכז\/ת הנגישות אינה תקינה/);
});

test('filters and searches have names; month days and empty slots have names that start with what is shown', async () => {
  const bookings = (await admin.get('/admin/bookings')).text;
  assert.match(bookings, /<select name="status" aria-label="סינון לפי סטטוס">/);
  assert.match(bookings, /<select name="kind" aria-label="סינון לפי סוג">/);
  assert.match(bookings, /name="q"[^>]*aria-label="חיפוש הזמנות"/);
  assert.match((await admin.get('/admin/users')).text, /<select name="role" aria-label="סינון לפי תפקיד">/);
  const month = (await admin.get('/calendar?view=month')).text;
  assert.match(month, /<a class="m-day" href="[^"]+" aria-label="(\d+) ב[^"]+, יום [^"]+"[^>]*>\1<\/a>/);
  assert.match((await admin.get('/calendar?view=week')).text, /class="tg-slot"[^>]*aria-label="הזמנה מ־/);
});

test('form errors are an alert that takes the focus; required fields are explained', async () => {
  const r = await new Client(srv.base).post('/register', { first_name: '' }, '/register');
  assert.match(r.text, /<div class="flash flash-error" role="alert" tabindex="-1" data-error-summary>/);
  assert.match(r.text, /שדות המסומנים בכוכבית \(\*\) הם שדות חובה/);
});

test('a brand colour keeps 4.5:1 on white and on the page background, as a close shade of itself', () => {
  for (const color of ['#6b7a1a', '#ff9900', '#0b7a63', '#00bcd4']) {
    const primary = /--primary:(#[0-9a-f]{6})/.exec(paletteCss(color))[1];
    assert.ok(contrast(rgb(primary), [255, 255, 255]) >= 4.5, `${color} on white`);
    assert.ok(contrast(rgb(primary), [243, 246, 245]) >= 4.5, `${color} on the page`);
  }
  assert.equal(/--primary:(#[0-9a-f]{6})/.exec(paletteCss('#0b7a63'))[1], '#0b7a63', 'a colour that passes is not changed');
});

test('each form error names its fields, so the page can mark them invalid and link them to the message', async () => {
  const r = await new Client(srv.base).post('/register', { first_name: '', phone: 'x', email: 'bad' }, '/register');
  assert.match(r.text, /<li id="form-error-\d+" data-fields="first_name last_name">יש למלא שם פרטי ושם משפחה<\/li>/);
  assert.match(r.text, /data-fields="phone">מספר הטלפון הנייד אינו תקין/);
  assert.match(r.text, /data-fields="email">כתובת הדואר האלקטרוני אינה תקינה/);
  const login = await new Client(srv.base).post('/login', { email: 'nobody@test.org', password: 'wrong-password' });
  assert.match(login.text, /data-error-summary><ul class="plain"><li id="form-error-0" data-fields="email password">/);
});
