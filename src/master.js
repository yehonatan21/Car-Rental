'use strict';
// The master console (APP_MODE=master): the list of client instances and the connection to each of them.
// Every client has its own deployment and database; the console keeps only what is needed to reach and manage them
// (name, address, the hosting resources' names). It talks to an instance through the instance's management API
// (routes/manage.js) with a per-client MANAGE_TOKEN derived from the console's secret, so no client token is stored.
const crypto = require('node:crypto');
const config = require('./config');
const { db } = require('./db');
const time = require('./time');
const provision = require('./provision');

if (config.master || config.masterConsole) {
  db.exec(`
CREATE TABLE IF NOT EXISTS master_clients (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  url TEXT,
  manager_email TEXT,
  vercel_project TEXT,
  vercel_project_id TEXT,
  turso_db TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  created_by INTEGER,
  last_status TEXT,
  last_seen_at TEXT,
  manager_invited_at TEXT,
  provisioned INTEGER NOT NULL DEFAULT 0
);`);
  // When the console last gave this client its mail settings on its own (statusOf), so it does not retry every visit.
  if (!db.prepare('PRAGMA table_info(master_clients)').all().some((c) => c.name === 'mail_shared_at')) {
    try { db.exec('ALTER TABLE master_clients ADD COLUMN mail_shared_at TEXT'); } catch (err) { if (!/duplicate column/i.test(err.message)) throw err; }
  }
}

const clean = provision.clean;

// ---------- The console's secret and the per-client tokens ----------
let secretCache = null;
/** MASTER_SECRET, or one generated once and kept in the console's database. */
function masterSecret() {
  if (secretCache) return secretCache;
  const fromEnv = clean(process.env.MASTER_SECRET);
  if (fromEnv) return (secretCache = fromEnv);
  db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('master_secret', ?)").run(provision.randomSecret(32));
  return (secretCache = db.prepare("SELECT value FROM app_meta WHERE key = 'master_secret'").get().value);
}

/** The MANAGE_TOKEN of a client instance (the same every time, so it never has to be stored). */
const manageToken = (slug) => crypto.createHmac('sha256', masterSecret()).update(`manage:${slug}`).digest('base64url');

// ---------- Hosting services ----------
const env = () => process.env;
const fetchImpl = (...a) => globalThis.fetch(...a);
const providers = () => provision.providers(env());

/** The GitHub repository the client sites are built from: CLIENT_REPO, else the console's own repository. */
function clientRepo() {
  const e = env();
  if (clean(e.CLIENT_REPO)) return clean(e.CLIENT_REPO);
  return clean(e.VERCEL_GIT_REPO_OWNER) && clean(e.VERCEL_GIT_REPO_SLUG) ? `${clean(e.VERCEL_GIT_REPO_OWNER)}/${clean(e.VERCEL_GIT_REPO_SLUG)}` : null;
}
const clientBranch = () => clean(env().CLIENT_BRANCH) || 'main';

// ---------- The list of clients ----------
const COLUMNS = ['name', 'url', 'manager_email', 'vercel_project', 'vercel_project_id', 'turso_db', 'notes', 'last_status', 'last_seen_at',
  'manager_invited_at', 'mail_shared_at'];

const list = () => db.prepare('SELECT * FROM master_clients ORDER BY name COLLATE NOCASE, slug').all();
const get = (slug) => db.prepare('SELECT * FROM master_clients WHERE slug = ?').get(String(slug || ''));

function add(c) {
  db.prepare(`INSERT INTO master_clients (slug, name, url, manager_email, vercel_project, vercel_project_id, turso_db, notes, created_at, created_by,
    provisioned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.slug, c.name, c.url || null, c.manager_email || null, c.vercel_project || null,
    c.vercel_project_id || null, c.turso_db || null, c.notes || null, time.stamp(), c.created_by ?? null, c.provisioned ? 1 : 0);
  return get(c.slug);
}

function update(slug, fields) {
  const keys = Object.keys(fields).filter((k) => COLUMNS.includes(k));
  if (!keys.length) return get(slug);
  db.prepare(`UPDATE master_clients SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE slug = ?`)
    .run(...keys.map((k) => (fields[k] === '' ? null : fields[k] ?? null)), slug);
  return get(slug);
}

const remove = (slug) => db.prepare('DELETE FROM master_clients WHERE slug = ?').run(slug);

/**
 * A site address as typed: scheme added when missing, only the origin kept. https only, except a local test address.
 * Returns null when it is not a usable address.
 */
function normalizeUrl(input) {
  let v = clean(input);
  if (!v) return null;
  if (!/^[a-z]+:\/\//i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    // The console sends each client's management token to this address, so it must be a public site (SEC-007):
    // https, a real domain name, no IP address and no internal name. Local test addresses only outside production.
    if (local) return !config.production && ['http:', 'https:'].includes(u.protocol) ? u.origin : null;
    if (u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.') || isIpHost(u.hostname) || /\.(local|internal|localhost|lan|home|corp|intranet)$/i.test(u.hostname)) return null;
    if (u.port && u.port !== '443') return null;
    return u.origin;
  } catch {
    return null;
  }
}

const isIpHost = (host) => require('node:net').isIP(host.replace(/^\[|\]$/g, '')) !== 0;

/** A private, loopback, link-local or otherwise non-public address (v4, or v6 incl. v4-mapped). */
function isPrivateAddress(ip) {
  const v4 = ip.replace(/^::ffff:/i, '');
  if (require('node:net').isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/**
 * Before a token goes out: the client's host must resolve only to public addresses (a public name pointing at an
 * internal address would otherwise still reach inside). Skipped outside production for local test sites.
 */
async function assertPublicDestination(url) {
  if (!config.production) return;
  const { hostname } = new URL(url);
  let addresses;
  try {
    addresses = await require('node:dns').promises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new InstanceError('unreachable', 'לא ניתן למצוא את כתובת האתר (DNS).');
  }
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new InstanceError('unsafe_url', 'כתובת האתר מפנה לרשת פנימית, ולכן מפתח הניהול לא נשלח אליה.');
  }
}

// ---------- Talking to an instance ----------
class InstanceError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

const INSTANCE_ERRORS = {
  no_url: 'כתובת האתר עדיין לא ידועה.',
  unreachable: 'לא ניתן להתחבר לאתר (הוא עדיין נבנה, נמחק, או שהכתובת שגויה).',
  timeout: 'האתר לא ענה בזמן.',
  unauthorized: 'האתר דחה את מפתח הניהול: MANAGE_TOKEN חסר או שגוי בהגדרות האתר ב־Vercel.',
  not_enabled: 'באתר לא מוגדר מפתח ניהול (MANAGE_TOKEN), ולכן אי אפשר לנהל אותו מכאן.',
  not_app: 'בכתובת הזו אין אתר הזמנת רכב בגרסה שתומכת בניהול מרכזי (גרסה ישנה או כתובת אחרת).',
  down: 'האתר לא עלה (שגיאת שרת). בדקו את ה־Logs שלו ב־Vercel.',
};

/** Calls the client's management API; resolves with its JSON, or throws InstanceError with a Hebrew message. */
async function call(client, method, path, body, { timeoutMs = 8000 } = {}) {
  if (!client.url) throw new InstanceError('no_url', INSTANCE_ERRORS.no_url);
  if (normalizeUrl(client.url) !== client.url) throw new InstanceError('unsafe_url', 'כתובת האתר אינה כתובת ציבורית תקינה (https), ולכן מפתח הניהול לא נשלח אליה.');
  await assertPublicDestination(client.url);
  let res;
  try {
    res = await fetchImpl(client.url + path, {
      method,
      headers: { authorization: `Bearer ${manageToken(client.slug)}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw new InstanceError(timeout ? 'timeout' : 'unreachable', INSTANCE_ERRORS[timeout ? 'timeout' : 'unreachable']);
  }
  let data = null;
  try { data = JSON.parse(await res.text()); } catch { /* not JSON */ }
  if (res.status === 401 || res.status === 429) throw new InstanceError('unauthorized', INSTANCE_ERRORS.unauthorized);
  if (res.status === 404 && data?.error === 'not_enabled') throw new InstanceError('not_enabled', INSTANCE_ERRORS.not_enabled);
  if (res.status >= 500 && !data) throw new InstanceError('down', INSTANCE_ERRORS.down);
  if (!data || (res.status >= 300 && res.status < 400)) throw new InstanceError('not_app', INSTANCE_ERRORS.not_app);
  if (!res.ok) throw new InstanceError('invalid', data.message || `האתר החזיר שגיאה ${res.status}`);
  return data;
}

/** Live status of one client: { online, data } or { online: false, error, kind, last } (the last status seen). */
async function statusOf(client, opts) {
  const t0 = Date.now();
  try {
    const data = await call(client, 'GET', '/api/manage/status', null, opts);
    const ms = Date.now() - t0; // how long the site took to answer (the console's monitoring)
    if (data.app !== 'car-rental') throw new InstanceError('not_app', INSTANCE_ERRORS.not_app);
    update(client.slug, { last_status: JSON.stringify(data), last_seen_at: time.stamp() });
    const mailShared = data.mail && !data.mail.configured ? await autoShareMail(client) : false;
    return { online: true, data, mailShared, ms };
  } catch (err) {
    if (!(err instanceof InstanceError)) throw err;
    let last = null;
    try { last = client.last_status ? JSON.parse(client.last_status) : null; } catch { /* ignore */ }
    return { online: false, kind: err.kind, error: err.message, last };
  }
}

/**
 * A client site that sends no e-mail gets the console's mailbox on its own: every client sends from it unless it has
 * mail settings of its own (a site that has them reports mail as configured and is never touched). Tried again only
 * after an hour, since the site is rebuilt meanwhile. Returns true when the settings were sent.
 */
async function autoShareMail(client) {
  const last = client.mail_shared_at ? Date.parse(client.mail_shared_at.replace(' ', 'T')) : 0;
  if (!config.smtp || !providers().vercel || !(client.vercel_project || client.vercel_project_id) || Date.now() - last < 3600000) return false;
  update(client.slug, { mail_shared_at: time.stamp() });
  try {
    return await shareMail(client);
  } catch (err) {
    console.warn(`[master] mail settings for ${client.slug} failed:`, err.message);
    return false;
  }
}

/** Statuses of all clients at once (each with its own short timeout). */
const statusAll = (clients) => Promise.all(clients.map((c) => statusOf(c, { timeoutMs: 6000 })));

/**
 * Finds the address of a client whose address is not known yet (a new deployment gets its *.vercel.app address only
 * once it is ready): the project's domains at Vercel, then the usual project address. An address counts only when the
 * site there accepts this client's token, so it is really this client.
 */
async function discoverUrl(client) {
  const candidates = [];
  const project = client.vercel_project_id || client.vercel_project;
  if (project && providers().vercel) {
    // Vercel lists the project's addresses (its *.vercel.app one included) once the first deployment is ready.
    for (const d of await provision.projectDomains(project, env(), fetchImpl).catch(() => [])) {
      candidates.push(`${/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(d) ? 'http' : 'https'}://${d}`);
    }
  } else {
    candidates.push(`https://${client.vercel_project || provision.resourceName(client.slug)}.vercel.app`);
  }
  for (const url of [...new Set(candidates)]) {
    try {
      const data = await call({ ...client, url }, 'GET', '/api/manage/status', null, { timeoutMs: 5000 });
      if (data.app === 'car-rental') return update(client.slug, { url }).url;
    } catch { /* try the next one */ }
  }
  return null;
}

// ---------- Creating, changing and removing ----------
/** Mail settings of the console, to give a new client the same sending mailbox (sender name: the client's). */
function sharedMailVars() {
  if (!config.smtp) return null;
  const e = env();
  const vars = { SMTP_HOST: clean(e.SMTP_HOST), SMTP_PORT: clean(e.SMTP_PORT) || '587', SMTP_USER: clean(e.SMTP_USER), SMTP_PASS: e.SMTP_PASS || '',
    MAIL_FROM: config.mailFrom };
  if (clean(e.SMTP_SECURE)) vars.SMTP_SECURE = clean(e.SMTP_SECURE);
  return vars;
}

/** The console's "Sign in with Google" app, to share with a client (its address must be added in Google Cloud). */
function sharedGoogleVars() {
  // GOOGLE_RELAY_URL: the client signs in through this site's callback address, which is already registered with
  // Google, so nothing has to be added in Google Cloud Console for a new client.
  return config.google.clientId && config.google.clientSecret
    ? { GOOGLE_CLIENT_ID: config.google.clientId, GOOGLE_CLIENT_SECRET: config.google.clientSecret, GOOGLE_RELAY_URL: new URL(config.baseUrl).origin }
    : null;
}

/**
 * Creates a client instance: its database, its Vercel project with all variables (including its MANAGE_TOKEN) and
 * the first deployment, then adds it to the list. o: { slug, name, managerEmail, color, contactPhone, contactEmail,
 * sharedMail, sharedGoogle }.
 */
async function createClient(o, actorId) {
  const p = providers();
  if (!p.turso || !p.vercel) throw new Error('חסרים מפתחות API ל־Turso או ל־Vercel (ראו "חיבורים").');
  const repo = clientRepo();
  if (!repo) throw new Error('לא ידוע מאיזה מאגר GitHub לבנות את האתרים: הגדירו CLIENT_REPO (למשל yehonatan21/Car-Rental).');
  const extraVars = { ...(o.sharedMail ? sharedMailVars() : {}), ...(o.sharedGoogle ? sharedGoogleVars() : {}) };
  const vars = provision.instanceVars({ ...o, extraVars }, env(), { cronSecret: provision.randomSecret(), manageToken: manageToken(o.slug) });
  const database = await provision.createDatabase({ slug: o.slug }, env(), fetchImpl);
  Object.assign(vars, { LIBSQL_URL: database.url, LIBSQL_AUTH_TOKEN: database.token });
  const deployment = await provision.createDeployment({ slug: o.slug, repo, branch: clientBranch() }, env(), vars, fetchImpl);
  const client = add({
    slug: o.slug, name: o.name, manager_email: o.managerEmail, vercel_project: deployment.project, vercel_project_id: deployment.projectId,
    turso_db: database.name, created_by: actorId, provisioned: true,
  });
  return { client, database, deployment, vars: Object.keys(vars) };
}

/** The client's Vercel project (by id or name). */
async function projectOf(client) {
  const ref = client.vercel_project_id || client.vercel_project;
  if (!ref) throw new Error('לא הוגדר פרויקט Vercel ללקוח הזה (אפשר להוסיף אותו ב"פרטי הלקוח").');
  if (!providers().vercel) throw new Error('חסר מפתח API של Vercel (ראו "חיבורים").');
  const project = await provision.getProject(ref, env(), fetchImpl);
  if (!project) throw new Error(`הפרויקט ${ref} לא נמצא ב־Vercel.`);
  if (project.id !== client.vercel_project_id || project.name !== client.vercel_project) {
    update(client.slug, { vercel_project_id: project.id, vercel_project: project.name });
  }
  return project;
}

/** Builds the client's site again from the latest code (and with its current variables). */
async function redeploy(client) {
  const project = await projectOf(client);
  return provision.deploy(project, { repo: clientRepo(), branch: clientBranch() }, env(), fetchImpl);
}

/**
 * The client's Turso database name: saved when the console created it, else read from the address the site reports
 * (<name>-<organisation>.<region>.turso.io).
 */
function databaseName(client, host) {
  if (client.turso_db) return client.turso_db;
  const org = String(env().TURSO_ORG || '').trim();
  const m = org && new RegExp(`^(.+)-${org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`).exec(String(host || ''));
  return m ? m[1] : null;
}

/**
 * A new database key for the client (S-01): the old one, and any copy of it, stops working at once; the new one
 * (valid about a year) is saved in the site's Vercel project and the site is rebuilt. Down for about a minute.
 */
async function rotateDatabaseKey(client, host) {
  const name = databaseName(client, host);
  if (!name) throw new Error('לא ידוע מה שם מסד הנתונים של האתר ב־Turso.');
  const p = providers();
  if (!p.turso || !p.vercel) throw new Error('חסרים מפתחות API ל־Turso או ל־Vercel (ראו "חיבורים").');
  const project = await projectOf(client);
  const key = await provision.rotateDatabaseKey(name, env(), fetchImpl, { waitMs: Number(env().TURSO_KEY_WAIT_MS) || 15000 });
  await provision.setEnv(project.id, { LIBSQL_AUTH_TOKEN: key }, env(), fetchImpl);
  if (!client.turso_db) update(client.slug, { turso_db: name });
  return provision.deploy(project, { repo: clientRepo(), branch: clientBranch() }, env(), fetchImpl);
}

/** Sets the client's MANAGE_TOKEN at Vercel and redeploys, so a site added by hand can be managed from here. */
async function installToken(client) {
  const project = await projectOf(client);
  await provision.setEnv(project.id, { MANAGE_TOKEN: manageToken(client.slug) }, env(), fetchImpl);
  return provision.deploy(project, { repo: clientRepo(), branch: clientBranch() }, env(), fetchImpl);
}

/**
 * Gives an existing client the console's mail settings (the same sending mailbox, see sharedMailVars) and redeploys,
 * so its e-mails go out. The client keeps its own sender name (MAIL_FROM_NAME). Returns false without SMTP here.
 */
async function shareMail(client) {
  const vars = sharedMailVars();
  if (!vars) return false;
  const project = await projectOf(client);
  await provision.setEnv(project.id, vars, env(), fetchImpl);
  await provision.deploy(project, { repo: clientRepo(), branch: clientBranch() }, env(), fetchImpl);
  return true;
}

/**
 * The console's scheduled run: asks every listed site to run its jobs (reminders, alerts, failed e-mails), all at once,
 * each with its own time limit, so one slow or broken site doesn't hold up the others. Returns one line per site.
 */
async function runAllJobs() {
  // A new site gets its address only once its first deployment is ready: look for it here too, so a site joins the
  // schedule without anyone opening the console.
  await Promise.all(list().filter((c) => !c.url).map((c) => discoverUrl(c).catch(() => null)));
  const clients = list().filter((c) => c.url);
  return Promise.all(clients.map(async (c) => {
    try {
      const r = await call(c, 'POST', '/api/manage/run-jobs', {}, { timeoutMs: 20000 });
      return { slug: c.slug, ok: true, reminders: r.reminders, mail_sent: r.mail_sent, mail_waiting: r.mail_waiting, mail_failed: r.mail_failed };
    } catch (err) {
      console.warn(`[jobs] ${c.slug}: ${err.message}`);
      return { slug: c.slug, ok: false, error: err.message };
    }
  }));
}

/**
 * Removes a client from the list; with `resources`, also deletes its Vercel project and its Turso database (all its
 * data). What was deleted is forgotten at once, so a failure halfway can simply be retried.
 */
async function deleteClient(client, { resources }) {
  if (resources) {
    if (client.vercel_project_id || client.vercel_project) {
      if (!providers().vercel) throw new Error('חסר מפתח API של Vercel למחיקת הפרויקט.');
      await provision.deleteProject(client.vercel_project_id || client.vercel_project, env(), fetchImpl);
      update(client.slug, { vercel_project: null, vercel_project_id: null });
    }
    if (client.turso_db) {
      if (!providers().turso) throw new Error('חסר מפתח API של Turso למחיקת מסד הנתונים.');
      await provision.deleteDatabase(client.turso_db, env(), fetchImpl);
      update(client.slug, { turso_db: null });
    }
  }
  remove(client.slug);
}

/** Checks the API keys against the services: { turso: {ok, detail}, vercel: {ok, detail} }. */
async function checkConnections() {
  const p = providers();
  const one = async (enabled, fn, describe) => {
    if (!enabled) return { ok: false, detail: 'לא הוגדר' };
    try { return { ok: true, detail: describe(await fn(env(), fetchImpl)) }; } catch (err) { return { ok: false, detail: err.message }; }
  };
  return {
    turso: await one(p.turso, provision.checkTurso, (r) => `מחובר · ${r.databases} מסדי נתונים`),
    vercel: await one(p.vercel, provision.checkVercel, (r) => `מחובר · ${r.projects} פרויקטים`),
  };
}

module.exports = {
  manageToken, masterSecret, providers, clientRepo, clientBranch, list, get, add, update, remove, normalizeUrl,
  call, statusOf, statusAll, discoverUrl, createClient, redeploy, installToken, shareMail, runAllJobs, deleteClient, checkConnections,
  rotateDatabaseKey, databaseName,
  sharedMailVars, sharedGoogleVars, InstanceError, INSTANCE_ERRORS,
};
