'use strict';
// The master console (APP_MODE=master) managing client instances: a real console server, real client instances in
// processes of their own (each with its own database), and fake Turso and Vercel APIs that record every call.
process.env.APP_MODE = 'master';
const http = require('node:http');
const { db, createUser, startServer, startInstanceProcess, Client, PNG } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const master = require('../../src/master');

// ---------- Fake Turso + Vercel ----------
const calls = [];
const projects = new Map(); // name → { id, name, link, domains: [] }
const databases = new Set();
let failVercel = false;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const data = body ? JSON.parse(body) : null;
    calls.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization, body: data });
    const send = (status, out) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); };
    const p = url.pathname;
    let m;
    if (p.startsWith('/turso/')) {
      if (req.headers.authorization !== 'Bearer turso-key') return send(401, { error: 'invalid token' });
      if (p === '/turso/v1/organizations/myorg/databases' && req.method === 'GET') return send(200, { databases: [...databases].map((Name) => ({ Name })) });
      if (p === '/turso/v1/organizations/myorg/databases' && req.method === 'POST') {
        if (databases.has(data.name)) return send(409, { error: 'exists' });
        databases.add(data.name);
        return send(200, { database: { Name: data.name, Hostname: `${data.name}-myorg.turso.io` } });
      }
      if ((m = /^\/turso\/v1\/organizations\/myorg\/databases\/([\w-]+)$/.exec(p))) {
        if (req.method === 'DELETE') return databases.delete(m[1]) ? send(200, { database: m[1] }) : send(404, { error: 'not found' });
        return send(200, { database: { Name: m[1], Hostname: `${m[1]}-myorg.turso.io` } });
      }
      if (/\/auth\/tokens$/.test(p)) return send(200, { jwt: 'db-jwt-secret' });
    }
    if (p.startsWith('/vercel/')) {
      if (req.headers.authorization !== 'Bearer vercel-key') return send(403, { error: { message: 'Not authorized' } });
      if (failVercel) return send(500, { error: { message: 'Vercel is down' } });
      if (p === '/vercel/v11/projects') {
        if (projects.has(data.name)) return send(409, { error: { message: 'exists' } });
        const project = { id: `prj_${data.name}`, name: data.name, link: { type: 'github', repoId: 777 }, domains: [] };
        projects.set(data.name, project);
        return send(200, project);
      }
      if (p === '/vercel/v9/projects' && req.method === 'GET') return send(200, { projects: [...projects.values()] });
      const byRef = (ref) => [...projects.values()].find((x) => x.id === ref || x.name === ref);
      if ((m = /^\/vercel\/v9\/projects\/([\w-]+)\/domains$/.exec(p))) {
        const project = byRef(m[1]);
        return project ? send(200, { domains: project.domains.map((name) => ({ name })) }) : send(404, { error: { message: 'no' } });
      }
      if ((m = /^\/vercel\/v9\/projects\/([\w-]+)$/.exec(p))) {
        const project = byRef(m[1]);
        if (!project) return send(404, { error: { message: 'Project not found' } });
        if (req.method === 'DELETE') { projects.delete(project.name); return send(204, {}); }
        return send(200, project);
      }
      if (/^\/vercel\/v10\/projects\/[\w-]+\/env$/.test(p)) return send(201, { created: data });
      if (p === '/vercel/v13/deployments') return send(200, { id: 'dpl_1', url: `${data.name}-abc.vercel.app` });
    }
    send(404, { error: `unexpected ${req.method} ${p}` });
  });
});
const callsTo = (method, re) => calls.filter((c) => c.method === method && re.test(c.path));

let srv, boss, fakeBase;
const instances = [];

before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeBase = `http://127.0.0.1:${fake.address().port}`;
  Object.assign(process.env, {
    TURSO_API_URL: `${fakeBase}/turso/v1`, VERCEL_API_URL: `${fakeBase}/vercel`, TURSO_API_TOKEN: 'turso-key', TURSO_ORG: 'myorg',
    VERCEL_TOKEN: 'vercel-key', VERCEL_TEAM_ID: 'team_x', CLIENT_REPO: 'yehonatan21/Car-Rental',
  });
  srv = await startServer();
  createUser({ role: 'admin', email: 'boss@master.test', first_name: 'יהונתן', last_name: 'ראשי' });
  boss = new Client(srv.base);
  await boss.login('boss@master.test');
});
after(async () => {
  await Promise.all(instances.map((i) => i.stop()));
  fake.close();
  srv.close();
});

/** A client site in its own process, like a deployment created with the given variables. */
async function launch(env) {
  const i = await startInstanceProcess(env);
  instances.push(i);
  return i;
}

test('the console is only the console: everything leads to /master, no sign-up, admins only', async () => {
  const anon = new Client(srv.base);
  assert.equal((await anon.get('/')).location, '/master');
  for (const path of ['/register', '/admin', '/calendar', '/me', '/api/manage/status']) assert.equal((await anon.get(path)).location, '/master', path);
  const login = await anon.get('/master');
  assert.equal(login.status, 401);
  assert.match(login.text, /כניסה למרכז הניהול/);
  assert.doesNotMatch(login.text, /href="\/register"/);
  assert.equal((await anon.req('POST', '/bookings/new', {})).location, '/master');

  const user = createUser({ email: 'someone@master.test' });
  const c = new Client(srv.base);
  await c.login(user.email);
  assert.equal((await c.get('/master')).status, 403);

  const page = await boss.get('/master');
  assert.equal(page.status, 200);
  assert.match(page.text, /עדיין אין לקוחות/);
  assert.match(page.text, /href="\/master\/clients\/new"/);
  assert.match(page.text, /<small>מרכז הניהול<\/small>/);
});

test('a new client: its own database and Vercel project, with its own management key; then its manager is invited', async () => {
  // Bad input: nothing is created.
  let r = await boss.post('/master/clients/new', { name: '', slug: 'Bad Slug', manager_email: 'x' }, '/master/clients/new');
  assert.equal(r.status, 400);
  assert.match(r.text, /המזהה הקצר/);
  assert.match(r.text, /המנהל\/ת אינה תקינה/);
  assert.equal(calls.length, 0);

  r = await boss.post('/master/clients/new', {
    name: 'גמח בני אדם', slug: 'bne-adam', manager_email: 'Dana@Bne-Adam.org', manager_first_name: 'דנה', color: '#1d4ed8', contact_phone: '050-1112222',
  }, '/master/clients/new');
  assert.equal(r.status, 303);
  assert.equal(r.location, '/master/clients/bne-adam');
  assert.match(boss.flash().text, /נוצר ונבנה עכשיו/);

  const [createDb] = callsTo('POST', /\/databases$/);
  assert.deepEqual(createDb.body, { name: 'car-rental-bne-adam', group: 'default' });
  const [project] = callsTo('POST', /\/v11\/projects$/);
  assert.deepEqual(project.body.gitRepository, { type: 'github', repo: 'yehonatan21/Car-Rental' });
  const [envCall] = callsTo('POST', /\/env$/);
  const vars = Object.fromEntries(envCall.body.map((e) => [e.key, e]));
  assert.equal(vars.MANAGE_TOKEN.value, master.manageToken('bne-adam'));
  assert.equal(vars.MANAGE_TOKEN.type, 'sensitive');
  assert.equal(vars.LIBSQL_URL.value, 'libsql://car-rental-bne-adam-myorg.turso.io');
  assert.equal(vars.APP_NAME.value, 'גמח בני אדם');
  assert.equal(vars.BRAND_COLOR.value, '#1d4ed8');
  assert.equal(vars.ADMIN_PASSWORD, undefined, 'no password in the deployment: the manager is invited');
  const [deployment] = callsTo('POST', /\/v13\/deployments$/);
  assert.deepEqual(deployment.body.gitSource, { type: 'github', repoId: 777, ref: 'main' });
  assert.equal(master.get('bne-adam').manager_email, 'dana@bne-adam.org');
  assert.notEqual(master.manageToken('bne-adam'), master.manageToken('other'), 'every client has its own key');

  // While it is being built it has no address yet.
  let page = await boss.get('/master/clients/bne-adam');
  assert.match(page.text, /האתר נבנה עכשיו/);
  assert.match((await boss.get('/master')).text, /בבנייה/);

  // The deployment is ready: the site runs with the variables the console gave it, and Vercel lists its address.
  const site = await launch(Object.fromEntries(['MANAGE_TOKEN', 'APP_NAME', 'BRAND_COLOR', 'CONTACT_PHONE'].map((k) => [k, vars[k].value])));
  projects.get('car-rental-bne-adam').domains.push(`127.0.0.1:${site.port}`);
  const list = await boss.get('/master');
  assert.equal(master.get('bne-adam').url, site.base, 'address found');
  assert.match(list.text, /badge-active">פעיל/);
  assert.match(list.text, /background:#1d4ed8/);

  page = await boss.get('/master/clients/bne-adam');
  assert.match(page.text, /האתר מוכן: שלחו הזמנה למנהל\/ת/);
  r = await boss.post('/master/clients/bne-adam/managers', { email: 'dana@bne-adam.org' }, '/master/clients/bne-adam');
  assert.equal(r.status, 303);
  const flash = boss.flash();
  assert.equal(flash.type, 'warning', 'no mail server in the tests: the link is shown');
  const link = /(http:\/\/127\.0\.0\.1:\d+\/password\/reset\?token=\S+)/.exec(flash.text)[1];
  assert.ok(master.get('bne-adam').manager_invited_at);
  assert.doesNotMatch((await boss.get('/master/clients/bne-adam')).text, /האתר מוכן: שלחו הזמנה/);

  // The manager chooses a password on the client's own site and manages it.
  const dana = new Client(site.base);
  const token = decodeURIComponent(link.split('token=')[1]);
  assert.equal((await dana.post('/password/reset', { token, password: 'Dana12345', confirm: 'Dana12345' })).status, 303);
  await dana.login('dana@bne-adam.org', 'Dana12345');
  const admin = await dana.get('/admin');
  assert.equal(admin.status, 200);
  assert.match(admin.text, /גמח בני אדם/);
});

test('signing in to a client site as a manager, from the console', async () => {
  const c = master.get('bne-adam');
  const r = await boss.get('/master/clients/bne-adam/login');
  assert.equal(r.status, 302);
  assert.ok(r.location.startsWith(`${c.url}/manage/sso?token=`));
  const browser = new Client(c.url);
  const sso = await browser.get(r.location.slice(c.url.length));
  assert.equal(sso.status, 303);
  const admin = await browser.get('/admin');
  assert.equal(admin.status, 200);
  assert.match(admin.text, /יהונתן ראשי/);
  assert.equal((await new Client(c.url).get(r.location.slice(c.url.length))).status, 400, 'the link works once');

  // A link from another site does not sign in by itself: it asks first.
  const cross = await boss.req('GET', '/master/clients/bne-adam/login', null, { 'sec-fetch-site': 'cross-site' });
  assert.equal(cross.status, 200);
  assert.match(cross.text, /כניסה לאתר של גמח בני אדם/);

  const page = await boss.get('/master/clients/bne-adam');
  assert.match(page.text, /dana@bne-adam\.org/);
  assert.match(page.text, /boss@master\.test/, 'the console admin is now one of its managers');
});

test('changing the client\'s name, colour and logo from the console; suspending and resuming the site', async () => {
  const c = master.get('bne-adam');
  const fd = new FormData();
  for (const [k, v] of Object.entries({ org_name: 'גמח בני אדם – ירושלים', brand_color: '#7c3aed', contact_email: 'office@bne-adam.org' })) fd.set(k, v);
  fd.set('logo', new Blob([PNG], { type: 'image/png' }), 'logo.png');
  let r = await boss.post('/master/clients/bne-adam/branding', fd, '/master/clients/bne-adam');
  assert.equal(r.status, 303);
  assert.equal(boss.flash().text, 'הפרטים נשמרו באתר של הלקוח');
  const home = await (await fetch(c.url + '/')).text();
  assert.match(home, /<title>ברוכים הבאים · גמח בני אדם – ירושלים<\/title>/);
  assert.match(home, /--primary:#7c3aed/);
  assert.equal((await fetch(c.url + '/brand/logo')).status, 200);
  assert.equal(master.get('bne-adam').name, 'גמח בני אדם – ירושלים', 'the list follows the new name');

  const bad = new FormData();
  bad.set('contact_email', 'not-an-email');
  await boss.post('/master/clients/bne-adam/branding', bad, '/master/clients/bne-adam');
  assert.match(boss.flash().text, /המייל ליצירת קשר אינה תקינה/);

  r = await boss.post('/master/clients/bne-adam/suspend', { message: 'השירות הסתיים' }, '/master/clients/bne-adam');
  assert.equal(r.status, 303);
  const closed = await fetch(c.url + '/login');
  assert.equal(closed.status, 503);
  assert.match(await closed.text(), /השירות הסתיים/);
  assert.match((await boss.get('/master')).text, /מושהה/);
  await boss.post('/master/clients/bne-adam/resume', {}, '/master/clients/bne-adam');
  assert.equal((await fetch(c.url + '/login')).status, 200);
});

test('a site that already exists: added to the list, given its management key through Vercel, rebuilt', async () => {
  const old = await launch({ APP_NAME: 'האתר הראשון' }); // runs without MANAGE_TOKEN, like the first production site
  projects.set('car-rental', { id: 'prj_first', name: 'car-rental', link: { repoId: 777 }, domains: [] });
  let r = await boss.post('/master/clients/import', { name: 'האתר הראשון', slug: 'first', url: 'not a url' }, '/master/clients/import');
  assert.equal(r.status, 400);
  r = await boss.post('/master/clients/import', { name: 'האתר הראשון', slug: 'first', url: old.base, vercel_project: 'car-rental' }, '/master/clients/import');
  assert.equal(r.status, 303);
  const page = await boss.get('/master/clients/first');
  assert.match(page.text, /באתר לא מוגדר מפתח ניהול/);
  assert.match(page.text, new RegExp(master.manageToken('first')), 'the key to set by hand is shown');
  assert.doesNotMatch((await boss.get('/master')).text, /האתר הראשון[\s\S]*?בבנייה/, 'an added site is never "being built"');

  const before = calls.length;
  r = await boss.post('/master/clients/first/install-token', {}, '/master/clients/first');
  assert.match(boss.flash().text, /מפתח הניהול הוגדר/);
  const [envCall] = callsTo('POST', /\/projects\/prj_first\/env$/);
  assert.deepEqual(envCall.body.map((e) => [e.key, e.value, e.type]), [['MANAGE_TOKEN', master.manageToken('first'), 'sensitive']]);
  assert.equal(calls.slice(before).filter((x) => x.path === '/vercel/v13/deployments').length, 1, 'rebuilt so the key takes effect');

  // A site with a different key is refused, and says so.
  const other = await launch({ MANAGE_TOKEN: 'x'.repeat(40) });
  master.update('first', { url: other.base });
  assert.match((await boss.get('/master/clients/first')).text, /האתר דחה את מפתח הניהול/);
  await other.stop();
  await boss.post('/master/clients/first/redeploy', {}, '/master/clients/first');
  assert.match(boss.flash().text, /הבנייה מחדש התחילה/);
});

test('a site that does not answer does not break the list', async () => {
  master.add({ slug: 'gone', name: 'אתר שנעלם', url: 'http://127.0.0.1:9' });
  db.prepare("UPDATE master_clients SET created_at = '2020-01-01 00:00:00' WHERE slug IN ('gone', 'first')").run();
  const t = Date.now();
  const page = await boss.get('/master');
  assert.equal(page.status, 200);
  assert.ok(Date.now() - t < 10000);
  assert.match(page.text, /אתר שנעלם[\s\S]*?badge-blocked">לא זמין/);
  assert.match((await boss.get('/master/clients/gone')).text, /לא ניתן להתחבר לאתר/);
});

test('removing a client: only after typing its id; fully (Vercel project + database) or just from the list', async () => {
  await boss.post('/master/clients/bne-adam/delete', { mode: 'all', confirm: 'wrong' }, '/master/clients/bne-adam/delete');
  assert.match(boss.flash().text, /דבר לא נמחק/);
  assert.ok(master.get('bne-adam'));

  const before = calls.length;
  await boss.post('/master/clients/gone/delete', { mode: 'list', confirm: 'gone' }, '/master/clients/gone/delete');
  assert.equal(master.get('gone'), undefined);
  assert.equal(calls.length, before, 'nothing deleted at Vercel or Turso');

  const r = await boss.post('/master/clients/bne-adam/delete', { mode: 'all', confirm: 'bne-adam' }, '/master/clients/bne-adam/delete');
  assert.equal(r.location, '/master');
  assert.equal(callsTo('DELETE', /\/v9\/projects\/prj_car-rental-bne-adam$/).length, 1);
  assert.equal(callsTo('DELETE', /\/databases\/car-rental-bne-adam$/).length, 1);
  assert.equal(master.get('bne-adam'), undefined);
});

test('creating a client when Vercel fails: a clear message, and trying again reuses what was made', async () => {
  failVercel = true;
  let r = await boss.post('/master/clients/new', { name: 'לקוח שני', slug: 'second', manager_email: 'a@second.org' }, '/master/clients/new');
  assert.equal(r.status, 502);
  assert.match(r.text, /יצירת האתר נכשלה/);
  assert.match(r.text, /Vercel is down/);
  assert.equal(master.get('second'), undefined);
  failVercel = false;
  r = await boss.post('/master/clients/new', { name: 'לקוח שני', slug: 'second', manager_email: 'a@second.org' }, '/master/clients/new');
  assert.equal(r.status, 303);
  assert.ok(callsTo('GET', /\/databases\/car-rental-second$/).length, 'the database from the first try is reused');
  r = await boss.post('/master/clients/new', { name: 'שוב', slug: 'second', manager_email: 'a@second.org' }, '/master/clients/new');
  assert.match(r.text, /כבר יש לקוח עם המזהה הזה/);
});

test('the console\'s own admins, and checking the connections', async () => {
  let r = await boss.post('/master/admins', { email: 'partner@master.test', first_name: 'שותף' }, '/master/admins');
  assert.equal(r.status, 303);
  assert.match(boss.flash().text, /password\/reset\?token=/);
  const partner = db.prepare('SELECT * FROM users WHERE email = ?').get('partner@master.test');
  assert.equal(partner.role, 'admin');
  await boss.post(`/master/admins/${db.prepare("SELECT id FROM users WHERE email = 'boss@master.test'").get().id}/remove`, {}, '/master/admins');
  assert.match(boss.flash().text, /אי אפשר להסיר את עצמך/);
  await boss.post(`/master/admins/${partner.id}/remove`, {}, '/master/admins');
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(partner.id).role, 'user');

  r = await boss.post('/master/settings/check', {}, '/master/settings');
  assert.match(r.text, /מחובר · \d+ מסדי נתונים/);
  assert.match(r.text, /מחובר · \d+ פרויקטים/);
  process.env.VERCEL_TOKEN = 'wrong';
  try {
    r = await boss.post('/master/settings/check', {}, '/master/settings');
    assert.match(r.text, /badge-blocked">נכשל[\s\S]*Not authorized/);
  } finally {
    process.env.VERCEL_TOKEN = 'vercel-key';
  }
});

test('console settings in tabs: connections, mail from the project variables (with a test e-mail), and the main admin from ADMIN_EMAIL', async () => {
  process.env.ADMIN_EMAIL = 'Owner@Master.test';
  const owner = require('../../src/bootstrap').ensureAdminFromEnv();
  assert.deepEqual([owner.role, owner.password_hash], ['admin', null], 'ADMIN_EMAIL alone makes the main admin');

  let page = (await boss.get('/master/settings')).text;
  const tabs = [...page.matchAll(/role="tab" data-tab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['connections', 'mail', 'signin']);
  assert.match(page, /id="mail" role="tabpanel">[\s\S]*SMTP_HOST[\s\S]*action="\/master\/settings\/test-email"/);
  assert.match(page, /id="signin" role="tabpanel">[\s\S]*owner@master\.test[\s\S]*מנהל\/ת פעיל\/ה/);
  assert.match(page, /href="\/master\/settings" aria-current="page"><svg[^>]*>[\s\S]*?<span>הגדרות<\/span>/);

  const r = await boss.post('/master/settings/test-email', {}, '/master/settings');
  assert.equal(r.location, '/master/settings#mail');
  assert.match(boss.flash().text, /לא הוגדר שרת דואר/);

  page = (await boss.get('/master/admins')).text;
  assert.match(page, /owner@master\.test[\s\S]*?מנהל\/ת ראשי\/ת \(ADMIN_EMAIL\)/);
  await boss.post(`/master/admins/${owner.id}/remove`, {}, '/master/admins');
  assert.match(boss.flash().text, /נקבע\/ת ב־ADMIN_EMAIL/);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(owner.id).role, 'admin');
});
