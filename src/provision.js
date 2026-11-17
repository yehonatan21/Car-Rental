'use strict';
// Creating, changing and removing client instances at the hosting services: the client's own database (Turso) and
// its own deployment (Vercel). Used by `npm run new-client` and by the master console (routes/master.js).
// Every function takes the environment (API tokens) and a fetch implementation, so tests can use fake services.
const crypto = require('node:crypto');

const clean = (v) => String(v ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
const tursoApi = (env) => (clean(env.TURSO_API_URL) || 'https://api.turso.tech/v1').replace(/\/+$/, '');
const vercelApi = (env) => (clean(env.VERCEL_API_URL) || 'https://api.vercel.com').replace(/\/+$/, '');

/** Which hosting services can be used with the tokens in `env`. */
const providers = (env) => ({
  turso: Boolean(clean(env.TURSO_API_TOKEN) && clean(env.TURSO_ORG)),
  vercel: Boolean(clean(env.VERCEL_TOKEN)),
});

/** Names at the hosting services for a client. */
const resourceName = (slug) => `car-rental-${slug}`;

const validSlug = (s) => /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(String(s || ''));

/** Checks a client's options; returns the problems (empty when all is well). */
function validate(o, { adminEmail = true } = {}) {
  const problems = [];
  if (!validSlug(o.slug)) problems.push('--slug: 1–32 lower-case letters, digits or "-"');
  if (!String(o.name || '').trim()) problems.push('--name is required');
  if ((adminEmail || o.adminEmail) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.adminEmail || '')) problems.push('--admin-email: a valid e-mail address');
  if (o.adminPassword && o.adminPassword.length < 8) problems.push('--admin-password: at least 8 characters');
  if (o.color && !/^#[0-9a-f]{6}$/i.test(o.color)) problems.push('--color: like #0b7a63');
  if (o.repo && !/^[\w.-]+\/[\w.-]+$/.test(o.repo)) problems.push('--repo: owner/name');
  return problems;
}

/** A small API client: JSON in and out, errors with the service's own message. */
function api(fetchImpl, base, token) {
  return async (method, url, body, { okStatuses = [] } = {}) => {
    let res;
    try {
      res = await fetchImpl(base + url, {
        method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      throw new Error(`${method} ${base}${url.split('?')[0]} → no answer: ${err.cause?.message || err.message}`);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok && !okStatuses.includes(res.status)) {
      const msg = data?.error?.message || data?.error || data?.message || text || res.statusText;
      throw new Error(`${method} ${base}${url.split('?')[0]} → ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    }
    return { status: res.status, data };
  };
}

// ---------- Turso ----------
const turso = (env, fetchImpl) => ({
  call: api(fetchImpl, tursoApi(env), clean(env.TURSO_API_TOKEN)),
  org: encodeURIComponent(clean(env.TURSO_ORG)),
});

/** Creates (or reuses) the client's database and a never-expiring read/write token for it. */
async function createDatabase(o, env, fetchImpl, log = () => {}) {
  const { call, org } = turso(env, fetchImpl);
  const name = resourceName(o.slug);
  let r = await call('POST', `/organizations/${org}/databases`, { name, group: o.tursoGroup || clean(env.TURSO_GROUP) || 'default' },
    { okStatuses: [409] });
  if (r.status === 409) {
    log(`  database ${name} already exists: using it`);
    r = await call('GET', `/organizations/${org}/databases/${encodeURIComponent(name)}`);
  }
  const hostname = r.data?.database?.Hostname;
  if (!hostname) throw new Error(`Turso did not return the database address for ${name}`);
  const t = await call('POST', `/organizations/${org}/databases/${encodeURIComponent(name)}/auth/tokens?expiration=never&authorization=full-access`);
  if (!t.data?.jwt) throw new Error('Turso did not return a database token');
  return { name, url: `libsql://${hostname}`, token: t.data.jwt };
}

/** Deletes a database with all its data. A database that is already gone is fine. */
async function deleteDatabase(name, env, fetchImpl) {
  const { call, org } = turso(env, fetchImpl);
  const r = await call('DELETE', `/organizations/${org}/databases/${encodeURIComponent(name)}`, null, { okStatuses: [404] });
  return r.status !== 404;
}

/** Checks the Turso token and organisation: the number of databases, or an error. */
async function checkTurso(env, fetchImpl) {
  const { call, org } = turso(env, fetchImpl);
  const r = await call('GET', `/organizations/${org}/databases`);
  return { databases: (r.data?.databases || []).length };
}

// ---------- Vercel ----------
function vercel(env, fetchImpl) {
  const team = clean(env.VERCEL_TEAM_ID) ? `teamId=${encodeURIComponent(clean(env.VERCEL_TEAM_ID))}` : '';
  return {
    call: api(fetchImpl, vercelApi(env), clean(env.VERCEL_TOKEN)),
    // Query string with the team, e.g. q('upsert=true') → "?upsert=true&teamId=…"
    q: (extra = '') => { const s = [extra, team].filter(Boolean).join('&'); return s ? `?${s}` : ''; },
  };
}

// Secrets are "sensitive" (cannot be read back in the dashboard); the rest are plain, so they can be checked there.
const SECRETS = new Set(['LIBSQL_AUTH_TOKEN', 'ADMIN_PASSWORD', 'CRON_SECRET', 'SMTP_PASS', 'MANAGE_TOKEN', 'MASTER_SECRET',
  'GOOGLE_CLIENT_SECRET', 'TURSO_API_TOKEN', 'VERCEL_TOKEN']);

// Also set for preview builds: CLIENT_SITE tells scripts/vercel-ignore-build.js not to build this site's branch previews.
const ALL_TARGETS = new Set(['CLIENT_SITE']);

/** A Vercel project (by name or id), or null. */
async function getProject(nameOrId, env, fetchImpl) {
  const { call, q } = vercel(env, fetchImpl);
  const r = await call('GET', `/v9/projects/${encodeURIComponent(nameOrId)}${q()}`, null, { okStatuses: [404] });
  return r.status === 404 ? null : r.data;
}

/** Creates (or reuses) the Vercel project linked to the repository. */
async function ensureProject(name, repo, env, fetchImpl, log = () => {}) {
  const { call, q } = vercel(env, fetchImpl);
  let r = await call('POST', `/v11/projects${q()}`, { name, framework: null, gitRepository: { type: 'github', repo } }, { okStatuses: [409] });
  if (r.status === 409) {
    log(`  Vercel project ${name} already exists: updating it`);
    r = await call('GET', `/v9/projects/${encodeURIComponent(name)}${q()}`);
  }
  if (!r.data?.id) throw new Error(`Vercel did not return the project ${name}`);
  return r.data;
}

/** Sets (adds or replaces) Production environment variables of a project. */
async function setEnv(projectId, vars, env, fetchImpl) {
  const { call, q } = vercel(env, fetchImpl);
  await call('POST', `/v10/projects/${encodeURIComponent(projectId)}/env${q('upsert=true')}`, Object.entries(vars).map(([key, value]) => ({
    key, value: String(value), target: ALL_TARGETS.has(key) ? ['production', 'preview'] : ['production'], type: SECRETS.has(key) ? 'sensitive' : 'plain',
  })));
}

/** Starts a production deployment of the project from the repository branch (new variables take effect). */
async function deploy(project, { repo, branch = 'main' }, env, fetchImpl) {
  const { call, q } = vercel(env, fetchImpl);
  const repoId = project.link?.repoId || (repo === `${clean(env.VERCEL_GIT_REPO_OWNER)}/${clean(env.VERCEL_GIT_REPO_SLUG)}` && clean(env.VERCEL_GIT_REPO_ID));
  const [org, name] = String(repo || '').split('/');
  const gitSource = repoId ? { type: 'github', repoId: Number(repoId) || repoId, ref: branch } : { type: 'github', org, repo: name, ref: branch };
  const d = await call('POST', `/v13/deployments${q()}`, { name: project.name, project: project.id, target: 'production', gitSource });
  return { id: d.data?.id || null, url: d.data?.url ? `https://${d.data.url}` : null };
}

/** Creates (or reuses) the project, sets its variables and starts a deployment. */
async function createDeployment(o, env, vars, fetchImpl, log = () => {}) {
  const name = resourceName(o.slug);
  const project = await ensureProject(name, o.repo, env, fetchImpl, log);
  await setEnv(project.id, vars, env, fetchImpl);
  const d = await deploy({ ...project, name }, { repo: o.repo, branch: o.branch }, env, fetchImpl);
  return { project: name, projectId: project.id, deploymentUrl: d.url };
}

/** The project's own addresses (production domains), best first: custom domains, then *.vercel.app. */
async function projectDomains(projectId, env, fetchImpl) {
  const { call, q } = vercel(env, fetchImpl);
  const r = await call('GET', `/v9/projects/${encodeURIComponent(projectId)}/domains${q()}`, null, { okStatuses: [404] });
  const names = (r.data?.domains || []).filter((d) => !d.redirect && !d.gitBranch).map((d) => d.name);
  return names.sort((a, b) => Number(a.endsWith('.vercel.app')) - Number(b.endsWith('.vercel.app')));
}

/** Deletes a project with all its deployments. A project that is already gone is fine. */
async function deleteProject(nameOrId, env, fetchImpl) {
  const { call, q } = vercel(env, fetchImpl);
  const r = await call('DELETE', `/v9/projects/${encodeURIComponent(nameOrId)}${q()}`, null, { okStatuses: [404] });
  return r.status !== 404;
}

/** Checks the Vercel token (and team). */
async function checkVercel(env, fetchImpl) {
  const { call, q } = vercel(env, fetchImpl);
  const r = await call('GET', `/v9/projects${q('limit=100')}`);
  return { projects: (r.data?.projects || []).length };
}

// ---------- The instance's environment variables ----------
/**
 * Variables of a client instance (the database ones are added once the database exists).
 * secrets: { adminPassword?, cronSecret, manageToken? }. With adminPassword the first admin is created from
 * ADMIN_EMAIL/ADMIN_PASSWORD; instances created from the master console invite their manager instead.
 */
function instanceVars(o, env, secrets) {
  // CLIENT_SITE: only main is built for this site (scripts/vercel-ignore-build.js), so dev pushes add no deployments.
  const vars = { APP_NAME: o.name.trim(), MAIL_FROM_NAME: (o.mailFromName || o.name).trim(), CLIENT_SITE: '1' };
  if (secrets.adminPassword) Object.assign(vars, { ADMIN_EMAIL: o.adminEmail.toLowerCase(), ADMIN_PASSWORD: secrets.adminPassword });
  vars.CRON_SECRET = secrets.cronSecret;
  if (secrets.manageToken) vars.MANAGE_TOKEN = secrets.manageToken;
  if (o.color) vars.BRAND_COLOR = o.color.toLowerCase();
  if (o.contactEmail) vars.CONTACT_EMAIL = o.contactEmail;
  if (o.contactPhone) vars.CONTACT_PHONE = o.contactPhone;
  if (o.smtpUser) {
    Object.assign(vars, { SMTP_HOST: o.smtpHost || 'smtp.gmail.com', SMTP_PORT: String(o.smtpPort || 465), SMTP_USER: o.smtpUser });
    if (env.CLIENT_SMTP_PASS) vars.SMTP_PASS = env.CLIENT_SMTP_PASS;
  }
  Object.assign(vars, o.extraVars || {});
  return vars;
}

const randomSecret = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');

module.exports = {
  providers, resourceName, validSlug, validate, api, SECRETS, instanceVars, randomSecret, clean,
  createDatabase, deleteDatabase, checkTurso,
  getProject, ensureProject, setEnv, deploy, createDeployment, projectDomains, deleteProject, checkVercel,
};
