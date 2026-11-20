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
    const send = (status, out) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); };
    const p = url.pathname;
    let m;
    // The dashboard's monitoring reads the accounts (usage, plan, balance): answered here, not counted in `calls`.
    if (req.method === 'GET' && monitoringAnswers[p]) return send(200, monitoringAnswers[p]());
    if (req.method === 'GET' && /^\/turso\/v1\/organizations\/myorg\/databases\/[\w-]+\/usage$/.test(p)) {
      return send(200, { database: { usage: { rows_read: 1234, rows_written: 56, storage_bytes: 1081344 } } });
    }
    calls.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization, body: data });
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
      if (/\/auth\/rotate$/.test(p)) { keyChecks = 0; return send(200, {}); }
    }
    // The database itself (TURSO_DB_BASE): refuses the first new key after a rotation, as Turso can for a few minutes.
    if (/^\/db\/[\w.-]+\/v2\/pipeline$/.test(p)) {
      keyChecks++;
      return keyChecks === 1 ? send(401, { error: 'not yet' }) : send(200, { results: [] });
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
let keyChecks = 0;
const monitoringAnswers = {
  '/turso/v1/organizations/myorg': () => ({ organization: { plan_id: 'starter', blocked_reads: false, blocked_writes: false, payment_failing_since: { Valid: false } } }),
  '/turso/v1/organizations/myorg/subscription': () => ({ subscription: { plan: 'starter', overages: false, current_billing_period_start: '2026-11-01T04:00:00+00:00', current_billing_period_end: '2026-12-01T05:00:00+00:00' } }),
  '/turso/v1/organizations/myorg/plans': () => ({ plans: [{ name: 'starter', quotas: { rowsRead: 500000000, rowsWritten: 10000000, databases: 100, storage: 5000000000 } }] }),
  '/turso/v1/organizations/myorg/invoices': () => ({ credit_balance: '12.50', invoices: [] }),
  '/turso/v1/organizations/myorg/usage': () => ({ organization: { usage: { rows_read: 9600000, rows_written: 2500, storage_bytes: 6021120, databases: 3 },
    databases: [{ uuid: 'db-uuid-2', usage: { rows_read: 1234, rows_written: 56, storage_bytes: 1081344 } }] } }),
  '/vercel/v2/user': () => ({ user: { billing: { plan: 'hobby', status: 'active' }, softBlock: null } }),
  '/vercel/v2/usage': () => ({ data: [{ request_hit_count: 100, request_miss_count: 900, bandwidth_outgoing_bytes: 5e6, function_invocation_successful_count: 880,
    function_invocation_error_count: 20, function_execution_successful_gb_hours: 0.5, breakdown: { requests: [{ name: 'car-rental-second', percent: 40 }] } }] }),
};
const callsTo = (method, re) => calls.filter((c) => c.method === method && re.test(c.path));

let srv, boss, fakeBase;
const instances = [];

before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeBase = `http://127.0.0.1:${fake.address().port}`;
  Object.assign(process.env, {
    TURSO_DB_BASE: `${fakeBase}/db`, TURSO_KEY_WAIT_MS: "1", TURSO_API_URL: `${fakeBase}/turso/v1`, VERCEL_API_URL: `${fakeBase}/vercel`, TURSO_API_TOKEN: 'turso-key', TURSO_ORG: 'myorg',
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
  const statement = await anon.get('/accessibility');
  assert.equal(statement.status, 200, 'the accessibility statement is open in the console too');
  assert.match(statement.text, /הצהרת נגישות/);
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
  assert.match(callsTo('POST', /\/auth\/tokens$/).at(-1).query, /expiration=53w/, 'the database key expires (S-01)');
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
  assert.equal((await dana.post('/password/reset', { token, password: 'Blue-Sky-Garden-5', confirm: 'Blue-Sky-Garden-5' })).status, 303);
  await dana.login('dana@bne-adam.org', 'Blue-Sky-Garden-5');
  const admin = await dana.get('/admin');
  assert.equal(admin.status, 200);
  assert.match(admin.text, /גמח בני אדם/);
});

test('signing in to a client site as a manager, from the console', async () => {
  const c = master.get('bne-adam');
  const r = await boss.post('/master/clients/bne-adam/login', {}, '/master/clients/bne-adam');
  assert.equal(r.status, 303);
  assert.ok(r.location.startsWith(`${c.url}/manage/sso?token=`));
  const browser = new Client(c.url);
  const sso = await browser.get(r.location.slice(c.url.length));
  assert.equal(sso.status, 303);
  const admin = await browser.get('/admin');
  assert.equal(admin.status, 200);
  assert.match(admin.text, /יהונתן ראשי/);
  assert.equal((await new Client(c.url).get(r.location.slice(c.url.length))).status, 400, 'the link works once');

  // Straight to a page of the admin area (the waiting requests); anything outside /admin is ignored.
  const toList = await boss.post('/master/clients/bne-adam/login', { next: '/admin/bookings?status=pending' }, '/master');
  assert.match(toList.location, /&next=%2Fadmin%2Fbookings%3Fstatus%3Dpending$/);
  const b2 = new Client(c.url);
  assert.equal((await b2.get(toList.location.slice(c.url.length))).location, '/admin/bookings?status=pending');
  const evil = await boss.post('/master/clients/bne-adam/login', { next: '//evil.example/admin' }, '/master');
  assert.doesNotMatch(evil.location, /next=/, 'not passed on');
  const b3 = new Client(c.url);
  const token = /token=([^&]+)/.exec(evil.location)[1];
  assert.equal((await b3.get(`/manage/sso?token=${token}&next=${encodeURIComponent('https://evil.example')}`)).location, '/admin', 'the site ignores it too');

  // The list: requests and registrations in separate boxes, each naming the sites with any, linked to that list.
  const list = (await boss.get('/master')).text;
  assert.match(list, /בקשות הזמנה ממתינות לאישור/);
  assert.match(list, /הרשמות ורישיונות ממתינים לבדיקה/);

  // A link (from anywhere, or a browser prefetching it) never signs in: it only shows the button, a form post with the
  // session's token. Without the token, or from another site, the post is refused.
  const callsBefore = calls.length;
  const link = await boss.get('/master/clients/bne-adam/login?next=' + encodeURIComponent('/admin/users'));
  assert.equal(link.status, 200);
  assert.match(link.text, /כניסה לאתר של גמח בני אדם[\s\S]*<form method="post" action="\/master\/clients\/bne-adam\/login"[\s\S]*name="next" value="\/admin\/users"/);
  assert.equal(calls.length, callsBefore, 'nothing was asked of the site');
  assert.equal((await boss.req('POST', '/master/clients/bne-adam/login', {})).status, 303);
  assert.doesNotMatch((await boss.req('POST', '/master/clients/bne-adam/login', {})).location || '', /sso/, 'no token: refused');
  assert.equal((await boss.req('POST', '/master/clients/bne-adam/login', {}, { origin: 'https://evil.example' })).status, 403);
  assert.match(list, /<form method="post" action="\/master\/clients\/bne-adam\/login"/, 'the list signs in with a form, not a link');
  // Browsers apply form-action to where the form's redirect leads: the console's pages allow its clients' sites.
  const csp = (await boss.req('GET', '/master')).headers.get('content-security-policy');
  assert.ok(csp.includes(`form-action 'self' ${new URL(c.url).origin}`), csp);
  assert.match((await boss.req('GET', '/me')).headers.get('content-security-policy'), /form-action 'self';/, 'other pages unchanged');

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
  await boss.post('/master/clients/first/install-token', {}, '/master/clients/first');
  assert.match(boss.flash().text, /מפתח הניהול הוגדר/);
  const [envCall] = callsTo('POST', /\/projects\/prj_first\/env$/);
  assert.deepEqual(envCall.body.map((e) => [e.key, e.value, e.type]), [['MANAGE_TOKEN', master.manageToken('first'), 'sensitive']]);
  assert.equal(calls.slice(before).filter((x) => x.path === '/vercel/v13/deployments').length, 1, 'rebuilt so the key takes effect');

  // The console's mail settings, copied to the site (the password stays a sensitive variable) and rebuilt.
  const cfg = require('../../src/config');
  const saved = { smtp: cfg.smtp, env: { ...process.env } };
  try {
    cfg.smtp = { host: 'smtp.example.org', port: 465 };
    Object.assign(process.env, { SMTP_HOST: 'smtp.example.org', SMTP_PORT: '465', SMTP_USER: 'console@example.org', SMTP_PASS: 'app-pass-123' });
    const mark = calls.length;
    await boss.post('/master/clients/first/share-mail', {}, '/master/clients/first');
    assert.match(boss.flash().text, /הגדרות הדואר של מרכז הניהול הועתקו/);
    const mailEnv = calls.slice(mark).find((x) => x.method === 'POST' && /\/projects\/prj_first\/env$/.test(x.path));
    const byKey = Object.fromEntries(mailEnv.body.map((e) => [e.key, e]));
    assert.equal(byKey.SMTP_HOST.value, 'smtp.example.org');
    assert.equal(byKey.SMTP_USER.value, 'console@example.org');
    assert.equal(byKey.SMTP_PASS.value, 'app-pass-123');
    assert.equal(byKey.SMTP_PASS.type, 'sensitive');
    assert.equal(calls.slice(mark).filter((x) => x.path === '/vercel/v13/deployments').length, 1, 'rebuilt so it takes effect');
    // The same for every site at once.
    await boss.post('/master/share-mail', {}, '/master/settings?tab=mail');
    assert.match(boss.flash().text, /הגדרות הדואר הועתקו ל־\d+ אתרים/);
  } finally {
    cfg.smtp = saved.smtp;
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS']) if (k in saved.env) process.env[k] = saved.env[k]; else delete process.env[k];
  }
  await boss.post('/master/clients/first/share-mail', {}, '/master/clients/first');
  assert.match(boss.flash().text, /לא הוגדר שרת דואר/, 'nothing to copy without SMTP here');

  let keyed;
  // A site that sends no mail gets the console's mailbox on its own when the console sees it, once an hour at most.
  try {
    cfg.smtp = { host: 'smtp.example.org', port: 465 };
    Object.assign(process.env, { SMTP_HOST: 'smtp.example.org', SMTP_PORT: '465', SMTP_USER: 'console@example.org', SMTP_PASS: 'app-pass-123' });
    keyed = await launch({ MANAGE_TOKEN: master.manageToken('first') }); // a site with the right key and no mail
    master.update('first', { mail_shared_at: null, url: keyed.base });
    const mark = calls.length;
    const page = await boss.get('/master/clients/first');
    assert.match(page.text, /הגדרות הדואר של מרכז הניהול נשלחו לאתר/);
    const sent = calls.slice(mark).find((x) => x.method === 'POST' && /\/projects\/prj_first\/env$/.test(x.path));
    assert.ok(sent && sent.body.some((e) => e.key === 'SMTP_PASS' && e.type === 'sensitive'), 'mail settings sent');
    const again = calls.length;
    await boss.get('/master/clients/first');
    assert.equal(calls.slice(again).filter((x) => /\/env$/.test(x.path)).length, 0, 'not again on the next visit');
  } finally {
    await keyed?.stop();
    cfg.smtp = saved.smtp;
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS']) if (k in saved.env) process.env[k] = saved.env[k]; else delete process.env[k];
  }

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

test('the scheduled run: the console runs every site\'s jobs, and names a site that did not answer', async () => {
  process.env.CRON_SECRET = 's'.repeat(32);
  try {
    const r = await fetch(srv.base + '/internal/cron', { headers: { authorization: `Bearer ${'s'.repeat(32)}` } });
    assert.equal(r.status, 200);
    const { sites } = await r.json();
    const ok = sites.find((x) => x.slug === 'bne-adam');
    assert.equal(ok.ok, true, 'a site with the right key ran its jobs');
    assert.equal(typeof ok.reminders, 'number');
    const gone = sites.find((x) => x.slug === 'gone');
    assert.equal(gone.ok, false, 'a site that does not answer is reported, and does not stop the others');
    assert.ok(gone.error);
  } finally {
    delete process.env.CRON_SECRET;
  }
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

  // Only what is really missing is named.
  const savedToken = process.env.TURSO_API_TOKEN;
  delete process.env.TURSO_API_TOKEN;
  try {
    const page = (await boss.get('/master/settings')).text;
    assert.match(page, /חסר: <code dir="ltr">TURSO_API_TOKEN<\/code>/);
    assert.doesNotMatch(page, /TURSO_API_TOKEN, TURSO_ORG/);
  } finally {
    process.env.TURSO_API_TOKEN = savedToken;
  }
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
  assert.match(page, /id="mail" role="tabpanel" hidden>[\s\S]*SMTP_HOST[\s\S]*action="\/master\/settings\/test-email"/);
  assert.match(page, /id="signin" role="tabpanel" hidden>[\s\S]*owner@master\.test[\s\S]*מנהל\/ת פעיל\/ה/);
  assert.match((await boss.get('/master/settings?tab=mail')).text, /id="connections" role="tabpanel" hidden>[\s\S]*id="mail" role="tabpanel" >/);
  assert.match(page, /href="\/master\/settings" aria-current="page"><svg[^>]*>[\s\S]*?<span>הגדרות<\/span>/);

  const r = await boss.post('/master/settings/test-email', {}, '/master/settings');
  assert.equal(r.location, '/master/settings?tab=mail');
  assert.match(boss.flash().text, /לא הוגדר שרת דואר/);

  page = (await boss.get('/master/admins')).text;
  assert.match(page, /owner@master\.test[\s\S]*?מנהל\/ת ראשי\/ת \(ADMIN_EMAIL\)/);
  await boss.post(`/master/admins/${owner.id}/remove`, {}, '/master/admins');
  assert.match(boss.flash().text, /נקבע\/ת ב־ADMIN_EMAIL/);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(owner.id).role, 'admin');
});

test('the main admin sets a new password for any user: on a client site, and for console admins', async () => {
  // Only the main admin (ADMIN_EMAIL, set in the test above) may do this.
  const site = await launch({ MANAGE_TOKEN: master.manageToken('pw-site'), APP_NAME: 'אתר סיסמאות' });
  master.add({ slug: 'pw-site', name: 'אתר סיסמאות', url: site.base });
  await master.call(master.get('pw-site'), 'POST', '/api/manage/admins', { email: 'manager@pw-site.org', first_name: 'מיכל', send_email: false });
  assert.equal((await boss.get('/master/clients/pw-site/users')).status, 403, 'another console admin cannot');
  assert.doesNotMatch((await boss.get('/master/clients/pw-site')).text, /id="users"/);

  const ownerRow = db.prepare("SELECT * FROM users WHERE email = 'owner@master.test'").get();
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(require('../../src/auth').hashPassword('OwnerPass1'), ownerRow.id);
  const owner = new Client(srv.base);
  await owner.login('owner@master.test', 'OwnerPass1');
  assert.match((await owner.get('/master/clients/pw-site')).text, /id="users"[\s\S]*משתמשי האתר/);

  const list = await owner.get('/master/clients/pw-site/users?q=manager%40pw-site');
  assert.equal(list.status, 200);
  const href = /href="(\/master\/clients\/pw-site\/users\/\d+\/password)"/.exec(list.text)[1];
  assert.match(list.text, /manager@pw-site\.org[\s\S]*ללא סיסמה/);
  const form = await owner.get(href);
  assert.match(form.text, /סיסמה חדשה[\s\S]*manager@pw-site\.org[\s\S]*data-generate-password/);

  let r = await owner.post(href, { password: 'short' }, href);
  assert.equal(r.status, 400);
  assert.match(r.text, /לפחות 8 תווים/);
  r = await owner.post(href, { password: 'Michal-Lake-26!' }, href);
  assert.equal(r.status, 303);
  assert.match(owner.flash().text, /נקבעה סיסמה חדשה ל־מיכל[\s\S]*manager@pw-site\.org/);
  const michal = new Client(site.base);
  await michal.login('manager@pw-site.org', 'Michal-Lake-26!');
  assert.equal((await michal.get('/admin')).status, 200, 'the manager signs in to their site with it');

  // Console admins: another admin is signed out; the main admin's own change keeps them signed in.
  const bossId = db.prepare("SELECT id FROM users WHERE email = 'boss@master.test'").get().id;
  assert.match((await owner.get('/master/admins')).text, new RegExp(`href="/master/admins/${bossId}/password"`));
  r = await owner.post(`/master/admins/${bossId}/password`, { password: 'Night-Owl-777' }, `/master/admins/${bossId}/password`);
  assert.equal(r.location, '/master/admins');
  assert.equal((await boss.get('/master')).status, 401, 'signed out');
  await new Client(srv.base).login('boss@master.test', 'Night-Owl-777');
  await owner.post(`/master/admins/${ownerRow.id}/password`, { password: 'Red-Kite-Hill-3' }, `/master/admins/${ownerRow.id}/password`);
  assert.equal((await owner.get('/master')).status, 200, 'still signed in after changing their own');
  await new Client(srv.base).login('owner@master.test', 'Red-Kite-Hill-3');
});

test('S-01: the console replaces a site\'s database key: old keys revoked, new one saved at Vercel, site rebuilt', async () => {
  const c = master.get('second');
  assert.ok(c?.turso_db, 'a site the console created');
  assert.equal(master.databaseName({ slug: 'x' }, 'car-rental-lapidot-myorg.aws-eu-central-1.turso.io'), 'car-rental-lapidot', 'name from the address');
  const before = calls.length;
  await master.rotateDatabaseKey(c);
  const mine = calls.slice(before);
  const order = mine.map((x) => `${x.method} ${x.path.replace(/^\/(turso|vercel)/, '$1')}`);
  const i = (re) => order.findIndex((o) => re.test(o));
  assert.ok(i(/auth\/rotate$/) >= 0 && i(/auth\/rotate$/) < i(/auth\/tokens$/), 'revoke first, then a new key');
  assert.ok(i(/auth\/tokens$/) < i(/\/env$/) && i(/\/env$/) < i(/v13\/deployments$/), 'saved, then rebuilt');
  assert.equal(order.filter((o) => /auth\/tokens$/.test(o)).length, 2, 'the first key was refused by the database, so a second one was made');
  assert.equal(keyChecks, 2, 'each key tried against the database before it was saved');
  const env = mine.find((x) => /\/env$/.test(x.path)).body;
  assert.deepEqual(env.map((e) => [e.key, e.type]), [['LIBSQL_AUTH_TOKEN', 'sensitive']]);
  assert.match(mine.find((x) => /auth\/tokens$/.test(x.path)).query, /expiration=53w/);
});

test('console: a passkey is required (CONSOLE_PASSKEY); deleting a client and replacing its key are the main admin\'s alone', async () => {
  const saved = { ADMIN_EMAIL: process.env.ADMIN_EMAIL, CONSOLE_PASSKEY: process.env.CONSOLE_PASSKEY, PASSKEYS: process.env.PASSKEYS };
  process.env.ADMIN_EMAIL = 'owner@master.test';
  process.env.PASSKEYS = 'on';
  try {
    createUser({ role: 'admin', email: 'helper@master.test' });
    const helper = new Client(srv.base);
    await helper.login('helper@master.test');
    process.env.CONSOLE_PASSKEY = 'required';
    const blocked = await helper.get('/master');
    assert.equal(blocked.location, '/me/security#passkeys', 'no passkey: sent to add one');
    assert.match((await helper.get('/me/security')).text, /נדרש מפתח גישה/);
    process.env.CONSOLE_PASSKEY = 'optional';
    assert.equal((await helper.get('/master')).status, 200);
    const c = master.list()[0];
    assert.equal((await helper.get(`/master/clients/${c.slug}/delete`)).status, 403);
    const r = await helper.post(`/master/clients/${c.slug}/delete`, { mode: 'all', confirm: c.slug }, '/master');
    assert.equal(r.status, 403);
    assert.ok(master.get(c.slug), 'not deleted');
    assert.doesNotMatch((await helper.get(`/master/clients/${c.slug}`)).text, /מחיקת הלקוח…|החלפת מפתח מסד הנתונים/);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v == null) delete process.env[k]; else process.env[k] = v;
  }
});

test('monitoring (/master/metrics): Turso and Vercel plan, balance and usage against limits; each site\'s numbers', async () => {
  createUser({ role: 'admin', email: 'watcher@master.test' });
  const watcher = new Client(srv.base);
  await watcher.login('watcher@master.test');
  const r = await watcher.get('/master/metrics?fresh=1');
  assert.doesNotMatch((await watcher.get('/master')).text, /id="monitoring"/, 'no longer on the client list');
  assert.match((await watcher.get('/master')).text, /href="\/master\/metrics"/, 'linked from the menu and the client list');
  const page = r.text;
  assert.match(page, /<section class="monitoring" id="monitoring">/, `status ${r.status} ${r.location || ''} ${page.slice(page.indexOf('<main'), page.indexOf('<main') + 300)}`);
  assert.match(page, /מסדי נתונים \(Turso\)[\s\S]*starter[\s\S]*\$12\.50[\s\S]*שורות שנקראו החודש[\s\S]*9,600,000 \/ 500,000,000/);
  assert.match(page, /אירוח \(Vercel\)[\s\S]*hobby[\s\S]*20 \(2\.2%\)[\s\S]*1,000 \/ 1,000,000/);
  assert.match(page, /נמענים היום, בכל האתרים/);
  assert.match(page, /<table class="table mon-table">[\s\S]*זמן תגובה[\s\S]*\d+ ms/);
  // A site's own report carries its metrics (counts only).
  const c = master.list().find((x) => x.url);
  const st = await master.statusOf(c);
  if (st.online) {
    assert.ok(st.data.metrics.db.rows.users >= 0);
    assert.ok('recipients' in st.data.metrics.mail.today);
    assert.ok(Number.isFinite(st.ms));
  }
});

test('monitoring verdicts: from 80% "warn", from 95% "bad"', () => {
  const monitoring = require('../../src/monitoring');
  assert.equal(monitoring.meter(79, 100).level, 'ok');
  assert.equal(monitoring.meter(80, 100).level, 'warn');
  assert.equal(monitoring.meter(95, 100).level, 'bad');
  const site = monitoring.siteChecks({ online: true, data: { storage: { kind: 'hosted', keyExpiresAt: new Date(Date.now() + 10 * 86400000).toISOString() },
    metrics: { jobs: { lastRun: null }, mail: { failed: 0, today: { recipients: 3, failed: 0 } } } } }, 200);
  assert.deepEqual(site.map((k) => [k.key, k.level]), [['response', 'ok'], ['jobs', 'bad'], ['mail', 'ok'], ['key', 'warn']]);
});

test('alerts: e-mailed when a problem appears, gets worse or is fixed; once a day while open; never twice for nothing', async () => {
  const alerts = require('../../src/alerts');
  const mon = require('../../src/monitoring');
  db.prepare('DELETE FROM alerts').run();
  db.prepare("DELETE FROM job_state WHERE key = 'alerts_at'").run();
  const sent = [];
  const send = async (to, subject, parts) => { sent.push({ to, subject, body: parts.join('\n') }); return true; };
  const turso = (rowsRead) => ({ ok: true, data: { plan: 'starter', blocked: { reads: false, writes: false }, paymentFailing: false, unpaidInvoices: 0,
    meters: { rowsRead: mon.meter(rowsRead, 100), rowsWritten: mon.meter(0, 100), storage: mon.meter(0, 100), databases: mon.meter(1, 100) } } });
  const site = { online: true, ms: 200, data: { metrics: { jobs: { lastRun: require('../../src/time').stamp() }, mail: { failed: 0, today: { recipients: 2, failed: 0 } } } } };
  const snap = (rowsRead, down) => ({
    clients: [{ slug: 'a', name: 'אתר א' }, { slug: 'b', name: 'אתר ב' }],
    statuses: [site, down ? { online: false, error: 'timeout' } : site],
    acc: { turso: turso(rowsRead), vercel: { ok: false, error: 'not_configured' } }, own: null,
  });
  const again = () => db.prepare("UPDATE job_state SET value = '0' WHERE key = 'alerts_at'").run(); // past the 5-minute spacing
  process.env.ALERT_EMAIL = 'ops@master.test';
  try {
    // Nothing wrong: nothing sent.
    assert.equal((await alerts.run({ snap: snap(10), send })).sent, false);
    assert.equal(sent.length, 0);
    // Two problems: one e-mail with both.
    again();
    await alerts.run({ snap: snap(85, true), send });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ['ops@master.test']);
    assert.match(sent[0].subject, /2 בעיות \(אחת דחופה\)/);
    assert.match(sent[0].body, /אתר ב: האתר לא עונה/);
    assert.match(sent[0].body, /Turso: שורות שנקראו החודש ב־85%/);
    // Run again at once: skipped; a while later with the same problems: nothing new, nothing sent.
    assert.equal((await alerts.run({ snap: snap(85, true), send })).skipped, 'recent');
    again();
    await alerts.run({ snap: snap(86, true), send });
    assert.equal(sent.length, 1, 'the same problems are not sent again');
    assert.match(alerts.open().find((a) => a.key === 'turso:rowsRead').text, /86%/, 'the page shows the latest numbers');
    // Worse (warn → bad): sent.
    again();
    await alerts.run({ snap: snap(97, true), send });
    assert.equal(sent.length, 2);
    assert.match(sent[1].body, /החמירו[\s\S]*97%/);
    // A day later, still open: a reminder.
    db.prepare('UPDATE alerts SET sent_at = sent_at - ?').run(25 * 3600000);
    again();
    await alerts.run({ snap: snap(97, true), send });
    assert.equal(sent.length, 3);
    assert.match(sent[2].body, /עדיין פתוח/);
    // Fixed: said once, and forgotten.
    again();
    await alerts.run({ snap: snap(10), send });
    assert.equal(sent.length, 4);
    assert.match(sent[3].subject, /כל הבעיות נפתרו/);
    assert.match(sent[3].body, /נפתר:[\s\S]*אתר ב/);
    assert.equal(alerts.open().length, 0);
    // A failed e-mail is not remembered, so the next run tries again.
    again();
    await alerts.run({ snap: snap(10, true), send: async () => false });
    assert.equal(alerts.open().length, 0);
    again();
    await alerts.run({ snap: snap(10, true), send });
    assert.equal(sent.length, 5);
    // ALERT_EMAIL=off: nobody is told.
    process.env.ALERT_EMAIL = 'off';
    assert.deepEqual(alerts.recipients(), []);
  } finally {
    delete process.env.ALERT_EMAIL;
    db.prepare('DELETE FROM alerts').run();
  }
});

test('alerts on the monitoring page, and from the scheduled run', async () => {
  db.prepare("INSERT OR REPLACE INTO alerts (key, level, text, since, sent_at) VALUES ('site:x:online', 'bad', 'אתר בדיקה: האתר לא עונה.', '2026-11-20 10:00:00', ?)").run(Date.now());
  const c = new Client(srv.base);
  createUser({ role: 'admin', email: 'alerts-page@master.test' });
  await c.login('alerts-page@master.test');
  const page = (await c.get('/master/metrics')).text;
  assert.match(page, /התראות במייל[\s\S]*אתר בדיקה: האתר לא עונה[\s\S]*מאז/);
  assert.match(page, /נשלחות אל [^<]*alerts-page@master\.test/);
  db.prepare('DELETE FROM alerts').run();
  db.prepare("DELETE FROM job_state WHERE key = 'alerts_at'").run();
  process.env.CRON_SECRET = 's'.repeat(32);
  try {
    const r = await fetch(srv.base + '/internal/cron', { headers: { authorization: `Bearer ${'s'.repeat(32)}` } });
    const out = await r.json();
    assert.ok(out.monitoring && typeof out.monitoring.open === 'number', JSON.stringify(out.monitoring));
  } finally {
    delete process.env.CRON_SECRET;
  }
});

test('errors: a new kind is e-mailed once (no daily reminder, no "fixed"), and listed on the monitoring page', async () => {
  const alerts = require('../../src/alerts');
  const errors = require('../../src/errors');
  db.prepare('DELETE FROM alerts').run();
  db.prepare('DELETE FROM error_log').run();
  const sent = [];
  const send = async (to, subject, parts) => { sent.push({ subject, body: parts.join('\n') }); return true; };
  const again = () => db.prepare("UPDATE job_state SET value = '0' WHERE key = 'alerts_at'").run();
  errors.record(new RangeError('Invalid time value'), { req: { method: 'GET', baseUrl: '', path: '/calendar' } });
  const snap = () => ({ clients: [], statuses: [], acc: { turso: { ok: false, error: 'not_configured' }, vercel: { ok: false, error: 'not_configured' } },
    own: require('../../src/routes/manage').metrics() });
  process.env.ALERT_EMAIL = 'ops@master.test';
  try {
    again();
    await alerts.run({ snap: snap(), send });
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /מרכז הניהול: שגיאת שרת חדשה: \u2066RangeError: Invalid time value · GET \/calendar/);
    // A day later: not repeated.
    db.prepare('UPDATE alerts SET sent_at = sent_at - ?').run(25 * 3600000);
    again();
    await alerts.run({ snap: snap(), send });
    assert.equal(sent.length, 1, 'no daily reminder for an error');
    // Out of the 24 hours: forgotten without a "fixed" e-mail.
    db.prepare("UPDATE error_log SET first_at = '2020-01-01 00:00:00'").run();
    again();
    await alerts.run({ snap: snap(), send });
    assert.equal(sent.length, 1);
    assert.equal(alerts.open().length, 0);

    const c = new Client(srv.base);
    createUser({ role: 'admin', email: 'errors-page@master.test' });
    await c.login('errors-page@master.test');
    const page = (await c.get('/master/metrics')).text;
    assert.match(page, /שגיאות שרת \(24 שעות\)[\s\S]*מרכז הניהול[\s\S]*RangeError: Invalid time value[\s\S]*GET \/calendar/);
  } finally {
    delete process.env.ALERT_EMAIL;
    db.prepare('DELETE FROM alerts').run();
    db.prepare('DELETE FROM error_log').run();
  }
});
