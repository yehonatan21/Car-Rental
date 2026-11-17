'use strict';
// MASTER_CONSOLE=true: the console runs inside a regular booking site, for that site's main admin (ADMIN_EMAIL) only,
// without a separate deployment. The site itself keeps working as before for everyone.
process.env.MASTER_CONSOLE = 'true';
process.env.ADMIN_EMAIL = 'Main@Site.test';
process.env.ADMIN_PASSWORD = 'MainAdmin1';
const { db, createUser, startServer, startInstanceProcess, Client } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const master = require('../../src/master');

let srv, main, site;
before(async () => {
  srv = await startServer(); // creates the main admin from ADMIN_EMAIL / ADMIN_PASSWORD
  main = new Client(srv.base);
  await main.login('main@site.test', 'MainAdmin1');
});
after(async () => {
  if (site) await site.stop();
  srv.close();
});

test('the main admin has "מרכז ניהול" in the menu, and the site works as before', async () => {
  const dash = await main.get('/admin');
  assert.equal(dash.status, 200, 'still the booking site: no redirect to the console');
  assert.match(dash.text, /href="\/master"[^>]*>[\s\S]*?<span>מרכז ניהול<\/span>/);
  const page = await main.get('/master');
  assert.equal(page.status, 200);
  assert.match(page.text, /עדיין אין לקוחות נוספים/);
  assert.match(page.text, /href="\/master\/settings"/);
  assert.match(page.text, /href="\/master" aria-current="page"/);
  assert.equal((await main.get('/calendar')).status, 200);
  assert.equal((await main.get('/admin/settings')).status, 200);
  assert.equal((await main.get('/master/admins')).location, '/admin/users?role=admin', 'site managers are managed as usual');
});

test('other managers and users of the site do not get the console', async () => {
  createUser({ role: 'admin', email: 'other-manager@site.test' });
  const other = new Client(srv.base);
  await other.login('other-manager@site.test');
  assert.doesNotMatch((await other.get('/admin')).text, /href="\/master"/);
  for (const path of ['/master', '/master/clients/new', '/master/settings']) assert.equal((await other.get(path)).status, 403, path);
  assert.equal((await other.post('/master/clients/import', { name: 'x', slug: 'x', url: 'https://x.example' }, '/admin')).status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM master_clients WHERE slug = 'x'").get().n, 0);
  createUser({ email: 'driver@site.test' });
  const driver = new Client(srv.base);
  await driver.login('driver@site.test');
  assert.equal((await driver.get('/master')).status, 403);
});

test('from inside the site: add a client site, see it, sign in to it, set a user\'s password', async () => {
  site = await startInstanceProcess({ MANAGE_TOKEN: master.manageToken('ramot'), APP_NAME: 'רכב קהילתי רמות' });
  const r = await main.post('/master/clients/import', { name: 'רכב קהילתי רמות', slug: 'ramot', url: site.base }, '/master/clients/import');
  assert.equal(r.status, 303);
  const list = await main.get('/master');
  assert.match(list.text, /רכב קהילתי רמות[\s\S]*?badge-active">פעיל/);

  const go = await main.get('/master/clients/ramot/login');
  assert.ok(go.location.startsWith(`${site.base}/manage/sso?token=`));
  const there = new Client(site.base);
  assert.equal((await there.get(go.location.slice(site.base.length))).status, 303);
  assert.equal((await there.get('/admin')).status, 200, 'signed in to the client site as a manager');

  const users = await main.get('/master/clients/ramot/users?q=main%40site.test');
  const href = /href="(\/master\/clients\/ramot\/users\/\d+\/password)"/.exec(users.text)[1];
  assert.equal((await main.post(href, { password: 'Ramot-Pass-1' }, href)).status, 303);
  await new Client(site.base).login('main@site.test', 'Ramot-Pass-1');
  assert.ok(db.prepare("SELECT 1 FROM master_clients WHERE slug = 'ramot'").get(), 'the list is kept in this site\'s own database');
});

test('the main admin from ADMIN_EMAIL always stays an admin of the site that hosts the console', () => {
  const id = db.prepare("SELECT id FROM users WHERE email = 'main@site.test'").get().id;
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(id);
  require('../../src/bootstrap').ensureAdminFromEnv();
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(id).role, 'admin');
});
