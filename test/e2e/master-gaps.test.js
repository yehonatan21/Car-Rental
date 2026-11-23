'use strict';
// The master console's less travelled paths: a client that isn't there or doesn't answer, a refused logo, the
// database key's expiry warnings, copying the mailbox to every site, finding a site's address, editing a client's
// details, adding console admins, removing an admin's passkeys, and a health check-in that can't be reached.
// One real client site runs in its own process; its status is adjusted on the way back where a test needs it.
process.env.APP_MODE = 'master';
process.env.ADMIN_EMAIL = 'boss@gaps.test';
const { db, createUser, startServer, startInstanceProcess, Client } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../src/config');
const master = require('../../src/master');
const auth = require('../../src/auth');

let srv, boss, site;
const realFetch = globalThis.fetch;
let patchStatus = null; // (status) => void, applied to the client site's /api/manage/status answers

before(async () => {
  globalThis.fetch = async (url, opts) => {
    const res = await realFetch(url, opts);
    if (!patchStatus || !String(url).endsWith('/api/manage/status')) return res;
    const data = await res.json();
    patchStatus(data);
    return new Response(JSON.stringify(data), { status: res.status, headers: { 'content-type': 'application/json' } });
  };
  srv = await startServer();
  // ADMIN_EMAIL made the main admin at startup (without a password): give it one to sign in with.
  db.prepare("UPDATE users SET password_hash = ? WHERE email = 'boss@gaps.test'").run(auth.hashPassword('Password1'));
  boss = new Client(srv.base);
  await boss.login('boss@gaps.test');
  site = await startInstanceProcess({ MANAGE_TOKEN: master.manageToken('up'), APP_NAME: 'Up' });
  master.add({ slug: 'up', name: 'Up', url: site.base });
  master.add({ slug: 'down', name: 'Down', url: 'http://127.0.0.1:9' });
});
after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.ADMIN_EMAIL;
  await site?.stop();
  await srv?.close();
});

const flash = () => boss.flash()?.text || '';

test('a client that is not in the list: back to the list', async () => {
  const r = await boss.get('/master/clients/nope/users');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/master');
  assert.equal(flash(), 'הלקוח לא נמצא');
});

test('the database key\'s expiry on the client page: none, expired, soon, and fine', async () => {
  const day = 86400000;
  const cases = [
    [null, /ללא תפוגה/],
    [new Date(Date.now() - 2 * day).toISOString(), /פג תוקף/],
    [new Date(Date.now() + 10.5 * day).toISOString(), /פג בעוד 10 ימים/],
    [new Date(Date.now() + 200 * day).toISOString(), /תקף עד/],
  ];
  try {
    for (const [at, re] of cases) {
      patchStatus = (s) => { s.storage = { ...s.storage, kind: 'hosted', keyExpiresAt: at }; };
      const page = await boss.get('/master/clients/up');
      assert.equal(page.status, 200);
      assert.match(page.text, re, String(at));
    }
  } finally {
    patchStatus = null;
  }
});

test('a client site that does not answer: signing in, its users and a user\'s password page say so', async () => {
  const login = await boss.post('/master/clients/down/login', {}, '/master');
  assert.equal(login.location, '/master/clients/down');
  assert.match(flash(), /^הכניסה לאתר נכשלה: /);
  const users = await boss.get('/master/clients/down/users');
  assert.equal(users.status, 302);
  assert.equal(users.location, '/master/clients/down');
  assert.match(flash(), /לא ניתן להתחבר לאתר/);
  const pw = await boss.get('/master/clients/down/users/1/password');
  assert.equal(pw.location, '/master/clients/down/users');
  assert.match(flash(), /לא ניתן להתחבר לאתר/);
});

test('managers of a client: an invalid address is refused; removing one works, and a failure is shown', async () => {
  const bad = await boss.post('/master/clients/up/managers', { email: 'not-an-address' }, '/master/clients/up');
  assert.equal(bad.location, '/master/clients/up#managers');
  assert.equal(flash(), 'כתובת הדואר האלקטרוני אינה תקינה');

  const { admins } = await master.call(master.get('up'), 'POST', '/api/manage/admins', { email: 'm@up.test', first_name: 'מ', by: 'test' })
    .then(() => master.call(master.get('up'), 'GET', '/api/manage/admins'));
  const m = admins.find((a) => a.email === 'm@up.test');
  const ok = await boss.post(`/master/clients/up/managers/${m.id}/remove`, {}, '/master/clients/up');
  assert.equal(ok.location, '/master/clients/up#managers');
  assert.equal(flash(), 'הרשאת הניהול הוסרה');

  await boss.post('/master/clients/down/managers/1/remove', {}, '/master/clients/down');
  assert.match(flash(), /לא ניתן להתחבר לאתר/);
});

test('a logo that is not a picture (a PDF) is refused before anything is sent to the site', async () => {
  const fd = new FormData();
  fd.set('org_name', 'Up');
  fd.set('logo', new Blob([Buffer.from('%PDF-1.4\n%%EOF\n')], { type: 'application/pdf' }), 'logo.pdf');
  const r = await boss.post('/master/clients/up/branding', fd, '/master/clients/up');
  assert.equal(r.location, '/master/clients/up#branding');
  assert.match(flash(), /הלוגו צריך להיות תמונה/);
});

test('replacing a client\'s database key: the site is told it is rebuilding', async (t) => {
  const rotate = t.mock.method(master, 'rotateDatabaseKey', async () => {});
  const r = await boss.post('/master/clients/up/rotate-db-key', {}, '/master/clients/up');
  assert.equal(r.location, '/master/clients/up');
  assert.match(flash(), /נוצר מפתח חדש למסד הנתונים/);
  assert.equal(rotate.mock.calls[0].arguments[0].slug, 'up');
});

test('copying the console\'s mailbox to every site: without one; then a mix of success and failure', async (t) => {
  const none = await boss.post('/master/share-mail', {}, '/master/settings');
  assert.equal(none.location, '/master/settings?tab=mail');
  assert.match(flash(), /לא הוגדר שרת דואר/);

  const saved = config.smtp;
  config.smtp = { host: 'smtp.example.org', port: 587 };
  t.after(() => { config.smtp = saved; });
  // The new-client form offers the console's mailbox now.
  assert.match((await boss.get('/master/clients/new')).text, /name="shared_mail"/);

  master.update('up', { vercel_project: 'car-rental-up' });
  master.update('down', { vercel_project: 'car-rental-down' });
  t.mock.method(console, 'warn', () => {});
  const share = t.mock.method(master, 'shareMail', async (c) => { if (c.slug === 'down') throw new Error('Vercel is down'); return true; });
  await boss.post('/master/share-mail', {}, '/master/settings');
  assert.match(flash(), /^ההעתקה נכשלה עבור: Down \(Vercel is down\)\. הצליחה עבור: Up$/);
  share.mock.mockImplementation(async () => true);
  await boss.post('/master/share-mail', {}, '/master/settings');
  assert.match(flash(), /הועתקו ל־2 אתרים/);
  master.update('up', { vercel_project: '' });
  master.update('down', { vercel_project: '' });
  await boss.post('/master/share-mail', {}, '/master/settings');
  assert.equal(flash(), 'אין אתרים עם פרויקט ב־Vercel.');
});

test('finding a client\'s address: found, or not yet', async (t) => {
  const find = t.mock.method(master, 'discoverUrl', async () => 'https://found.example.com');
  await boss.post('/master/clients/down/find-url', {}, '/master/clients/down');
  assert.match(flash(), /נמצאה כתובת האתר: https:\/\/found\.example\.com/);
  find.mock.mockImplementation(async () => null);
  await boss.post('/master/clients/down/find-url', {}, '/master/clients/down');
  assert.match(flash(), /הכתובת עדיין לא נמצאה/);
});

test('a client\'s details: checked, then saved (a changed project or manager clears what belonged to the old one)', async () => {
  master.update('down', { vercel_project_id: 'prj_old', manager_invited_at: '2026-01-01 10:00' });
  const bad = await boss.post('/master/clients/down/details', { name: 'Down', url: 'ftp://x', manager_email: 'nope', vercel_project: 'bad name!' }, '/master/clients/down');
  assert.equal(bad.location, '/master/clients/down#details');
  assert.equal(flash(), 'כתובת האתר אינה תקינה. כתובת המייל של המנהל/ת אינה תקינה. שם הפרויקט או מסד הנתונים אינו תקין');

  const ok = await boss.post('/master/clients/down/details', {
    name: '', url: '127.0.0.1:9', manager_email: 'NEW@Down.test', vercel_project: 'car-rental-down2', turso_db: 'db-down', notes: 'note',
  }, '/master/clients/down');
  assert.equal(ok.location, '/master/clients/down#details');
  assert.equal(flash(), 'הפרטים נשמרו');
  const c = master.get('down');
  assert.equal(c.name, 'Down', 'an empty name keeps the old one');
  assert.equal(c.manager_email, 'new@down.test');
  assert.equal(c.vercel_project_id, null);
  assert.equal(c.manager_invited_at, null);
  assert.equal(c.turso_db, 'db-down');
});

test('console admins: checked; an existing account gets the rights; a new one gets a link to choose a password', async () => {
  await boss.post('/master/admins', { email: 'x', first_name: '' }, '/master/admins');
  assert.equal(flash(), 'יש למלא שם פרטי וכתובת דואר אלקטרוני תקינה');

  const existing = createUser({ email: 'existing@gaps.test' });
  auth.markEmailVerified(existing.id); // a password the owner of the address chose: kept
  await boss.post('/master/admins', { email: 'existing@gaps.test', first_name: 'קיים' }, '/master/admins');
  assert.match(flash(), /עכשיו מנהל\/ת המרכז/);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(existing.id).role, 'admin');

  await boss.post('/master/admins', { email: 'fresh@gaps.test', first_name: 'חדש', last_name: 'מנהל' }, '/master/admins');
  const text = flash();
  assert.match(text, /לא הוגדר שרת דואר/);
  const token = /token=([^\s&]+)/.exec(text)[1];
  assert.ok(auth.checkPasswordReset(decodeURIComponent(token)), 'the link works');
});

test('the main admin removes another console admin\'s passkeys (after a lost phone)', async () => {
  const other = db.prepare("SELECT id FROM users WHERE email = 'existing@gaps.test'").get();
  db.prepare("INSERT INTO passkeys (id, user_id, public_key, counter, name, created_at) VALUES ('lost', ?, 'AAAA', 0, 'phone', '2026-01-01')").run(other.id);
  const r = await boss.post(`/master/admins/${other.id}/passkeys/remove`, {}, '/master/admins');
  assert.equal(r.location, '/master/admins');
  assert.match(flash(), /הוסרו 1 מפתחות הגישה של existing@gaps\.test/);
  // Not one's own, and not someone who isn't there.
  const me = db.prepare("SELECT id FROM users WHERE email = 'boss@gaps.test'").get();
  await boss.post(`/master/admins/${me.id}/passkeys/remove`, {}, '/master/admins');
  assert.equal(boss.flash(), null);
});

test('the scheduled run checks in at HEALTHCHECK_URL; one that can\'t be reached is only a warning', async (t) => {
  process.env.CRON_SECRET = 'cron-gaps';
  process.env.HEALTHCHECK_URL = 'http://127.0.0.1:9/ping';
  t.after(() => { delete process.env.CRON_SECRET; delete process.env.HEALTHCHECK_URL; });
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const r = await realFetch(`${srv.base}/internal/cron`, { headers: { authorization: 'Bearer cron-gaps' } });
  assert.equal(r.status, 200);
  assert.ok(warn.mock.calls.some((c) => /could not check in at HEALTHCHECK_URL/.test(c.arguments[0])));
});

test('the console requires a passkey: its admin can\'t remove the last one', async (t) => {
  process.env.PASSKEYS = 'on';
  process.env.CONSOLE_PASSKEY = 'required';
  t.after(() => { delete process.env.PASSKEYS; delete process.env.CONSOLE_PASSKEY; });
  const me = db.prepare("SELECT id FROM users WHERE email = 'boss@gaps.test'").get();
  db.prepare("INSERT INTO passkeys (id, user_id, public_key, counter, name, created_at) VALUES ('only', ?, 'AAAA', 0, 'laptop', '2026-01-01')").run(me.id);
  const r = await boss.post('/me/passkeys/only/remove', {}, '/me/security');
  assert.equal(r.location, '/me/security#passkeys');
  assert.match(flash(), /זה מפתח הגישה האחרון/);
  assert.ok(db.prepare("SELECT 1 FROM passkeys WHERE id = 'only'").get());
});
