'use strict';
// Creates a new client instance of the app: the client's own database (Turso) and its own deployment (Vercel),
// configured with the client's name, colour and contact details. Every client is a separate instance, so their data
// never mix and each can be changed or removed on its own.
//
//   npm run new-client -- --slug bne-adam --name "גמח רכב בני אדם" --admin-email admin@example.org [options]
//
// With TURSO_API_TOKEN + TURSO_ORG it creates the database, with VERCEL_TOKEN (+ VERCEL_TEAM_ID) the Vercel project,
// its environment variables and the first deployment. Without them it does what it can and prints the rest as steps.
// Everything the instance needs, secrets included, is written to clients/<slug>.env (not committed). See
// docs/new-client.md.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TURSO_API = 'https://api.turso.tech/v1';
const VERCEL_API = 'https://api.vercel.com';

const HELP = `Create a new client instance (own database + own Vercel deployment).

Required:
  --slug <id>             short id: lower-case letters, digits and "-" (e.g. bne-adam)
  --name <name>           the client's name, shown in the app and e-mails (e.g. "גמח רכב בני אדם")
  --admin-email <email>   the client's first admin

Optional:
  --admin-password <pw>   default: a random password (saved in clients/<slug>.env)
  --color <#rrggbb>       main colour       --contact-email <e>   --contact-phone <p>
  --mail-from-name <n>    sender name in e-mails (default: --name)
  --smtp-user <gmail>     sending mailbox; its app password is read from CLIENT_SMTP_PASS
  --smtp-host <host>      default smtp.gmail.com      --smtp-port <n>   default 465
  --repo <owner/name>     GitHub repository (default: this checkout's origin)
  --branch <name>         default main
  --turso-group <name>    Turso group (it decides the location), default "default"
  --dry-run               only show what would be done

Environment: TURSO_API_TOKEN, TURSO_ORG, VERCEL_TOKEN, VERCEL_TEAM_ID (optional), CLIENT_SMTP_PASS (optional).`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key === 'dryRun' || key === 'help') out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

function originRepo() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim();
    return /github\.com[/:]([^/]+\/[^/.]+?)(\.git)?$/.exec(url)?.[1] || null;
  } catch {
    return null;
  }
}

/** Checks the options; returns the problems (empty when all is well). */
function validate(o) {
  const problems = [];
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(o.slug || '')) problems.push('--slug: 1–32 lower-case letters, digits or "-"');
  if (!String(o.name || '').trim()) problems.push('--name is required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.adminEmail || '')) problems.push('--admin-email: a valid e-mail address');
  if (o.adminPassword && o.adminPassword.length < 8) problems.push('--admin-password: at least 8 characters');
  if (o.color && !/^#[0-9a-f]{6}$/i.test(o.color)) problems.push('--color: like #0b7a63');
  if (o.repo && !/^[\w.-]+\/[\w.-]+$/.test(o.repo)) problems.push('--repo: owner/name');
  return problems;
}

/** A small API client: JSON in and out, errors with the service's own message. */
function api(fetchImpl, base, token) {
  return async (method, url, body, { okStatuses = [] } = {}) => {
    const res = await fetchImpl(base + url, {
      method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
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

/** Creates (or reuses) the client's database and a never-expiring read/write token for it. */
async function createDatabase(o, env, fetchImpl, log) {
  const call = api(fetchImpl, TURSO_API, env.TURSO_API_TOKEN);
  const org = encodeURIComponent(env.TURSO_ORG);
  const name = `car-rental-${o.slug}`;
  let r = await call('POST', `/organizations/${org}/databases`, { name, group: o.tursoGroup || 'default' }, { okStatuses: [409] });
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

/** Creates (or reuses) the Vercel project linked to the repository, sets its variables and starts a deployment. */
async function createDeployment(o, env, vars, fetchImpl, log) {
  const call = api(fetchImpl, VERCEL_API, env.VERCEL_TOKEN);
  const team = env.VERCEL_TEAM_ID ? `teamId=${encodeURIComponent(env.VERCEL_TEAM_ID)}` : '';
  const q = (extra = '') => [extra, team].filter(Boolean).join('&').replace(/^/, '?').replace(/^\?$/, '');
  const name = `car-rental-${o.slug}`;
  let r = await call('POST', `/v11/projects${q()}`, { name, framework: null, gitRepository: { type: 'github', repo: o.repo } },
    { okStatuses: [409] });
  if (r.status === 409) {
    log(`  Vercel project ${name} already exists: updating it`);
    r = await call('GET', `/v9/projects/${encodeURIComponent(name)}${q()}`);
  }
  const project = r.data;
  if (!project?.id) throw new Error(`Vercel did not return the project ${name}`);
  // Secrets are "sensitive" (cannot be read back in the dashboard); the rest are plain, so they can be checked there.
  await call('POST', `/v10/projects/${project.id}/env${q('upsert=true')}`, Object.entries(vars).map(([key, value]) => ({
    key, value: String(value), target: ['production'], type: SECRETS.has(key) ? 'sensitive' : 'plain',
  })));
  const [org, repo] = o.repo.split('/');
  const gitSource = project.link?.repoId
    ? { type: 'github', repoId: project.link.repoId, ref: o.branch }
    : { type: 'github', org, repo, ref: o.branch };
  const d = await call('POST', `/v13/deployments${q()}`, { name, project: project.id, target: 'production', gitSource });
  return { project: name, projectId: project.id, deploymentUrl: d.data?.url ? `https://${d.data.url}` : null };
}

const SECRETS = new Set(['LIBSQL_AUTH_TOKEN', 'ADMIN_PASSWORD', 'CRON_SECRET', 'SMTP_PASS']);

/** The instance's environment variables (database ones are added once the database exists). */
function instanceVars(o, env, secrets) {
  const vars = {
    APP_NAME: o.name.trim(),
    MAIL_FROM_NAME: (o.mailFromName || o.name).trim(),
    ADMIN_EMAIL: o.adminEmail.toLowerCase(),
    ADMIN_PASSWORD: secrets.adminPassword,
    CRON_SECRET: secrets.cronSecret,
  };
  if (o.color) vars.BRAND_COLOR = o.color.toLowerCase();
  if (o.contactEmail) vars.CONTACT_EMAIL = o.contactEmail;
  if (o.contactPhone) vars.CONTACT_PHONE = o.contactPhone;
  if (o.smtpUser) {
    Object.assign(vars, { SMTP_HOST: o.smtpHost || 'smtp.gmail.com', SMTP_PORT: String(o.smtpPort || 465), SMTP_USER: o.smtpUser });
    if (env.CLIENT_SMTP_PASS) vars.SMTP_PASS = env.CLIENT_SMTP_PASS;
  }
  return vars;
}

function envFile(o, vars, result) {
  const lines = [
    `# Client instance "${o.name}" (${o.slug}), created ${new Date().toISOString().slice(0, 10)}.`,
    '# Contains secrets: keep it private and never commit it.',
    result.deployment ? `# Vercel project: ${result.deployment.project}` : '# Vercel project: not created (see docs/new-client.md)',
    result.database ? `# Turso database: ${result.database.name}` : '# Turso database: not created (see docs/new-client.md)',
    '',
    ...Object.entries(vars).map(([k, v]) => `${k}=${/[\s#"']/.test(v) ? JSON.stringify(v) : v}`),
    '',
  ];
  return lines.join('\n');
}

/**
 * Creates the client instance. `deps` lets tests replace the network and the file system.
 * Returns what was created; never prints secret values.
 */
async function createClient(options, { env = process.env, fetchImpl = globalThis.fetch, log = console.log, write = writeEnvFile } = {}) {
  const o = { branch: 'main', ...options, repo: options.repo || originRepo() };
  const problems = validate(o);
  if (!o.repo) problems.push('--repo: could not read the GitHub repository from git; pass --repo owner/name');
  if (problems.length) throw new Error(`Cannot create the client:\n  - ${problems.join('\n  - ')}`);

  const secrets = {
    adminPassword: o.adminPassword || crypto.randomBytes(12).toString('base64url'),
    cronSecret: crypto.randomBytes(24).toString('hex'),
  };
  const vars = instanceVars(o, env, secrets);
  const canDb = Boolean(env.TURSO_API_TOKEN && env.TURSO_ORG);
  const canDeploy = Boolean(env.VERCEL_TOKEN);
  const steps = [];

  log(`Client "${o.name}" (${o.slug})`);
  log(`  database:   ${canDb ? `Turso car-rental-${o.slug} (org ${env.TURSO_ORG})` : 'not created: TURSO_API_TOKEN / TURSO_ORG not set'}`);
  log(`  deployment: ${canDeploy ? `Vercel project car-rental-${o.slug}, from ${o.repo} (${o.branch})` : 'not created: VERCEL_TOKEN not set'}`);
  log(`  variables:  ${[...Object.keys(vars), ...(canDb ? ['LIBSQL_URL', 'LIBSQL_AUTH_TOKEN'] : [])].join(', ')}`);
  if (o.dryRun) {
    log('Dry run: nothing was created.');
    return { dryRun: true, vars: Object.keys(vars) };
  }

  const result = {};
  if (canDb) {
    log('Creating the database…');
    result.database = await createDatabase(o, env, fetchImpl, log);
    vars.LIBSQL_URL = result.database.url;
    vars.LIBSQL_AUTH_TOKEN = result.database.token;
  } else {
    steps.push(`Create a Turso database (e.g. car-rental-${o.slug}, region Frankfurt) and a token; add LIBSQL_URL and LIBSQL_AUTH_TOKEN.`);
  }
  if (canDeploy) {
    if (!canDb) throw new Error('The deployment needs the database: set TURSO_API_TOKEN and TURSO_ORG too (or create the project by hand).');
    log('Creating the Vercel project and the first deployment…');
    result.deployment = await createDeployment(o, env, vars, fetchImpl, log);
  } else {
    steps.push(`In Vercel: Add New → Project → import ${o.repo}, name it car-rental-${o.slug}, add the variables from the file below (Production), Deploy.`);
  }
  if (!vars.SMTP_HOST) steps.push('E-mail: add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (see docs/email-setup.md), then redeploy.');
  else if (!vars.SMTP_PASS) steps.push('E-mail: add SMTP_PASS (the app password of SMTP_USER) in Vercel as Sensitive, then redeploy.');
  steps.push('Google sign-in (optional): register https://<the client address>/auth/google/callback and set GOOGLE_CLIENT_ID / _SECRET.');

  result.file = write(o.slug, envFile(o, vars, result));
  log('');
  log('Done.');
  if (result.deployment) {
    log(`  Vercel project: ${result.deployment.project}${result.deployment.deploymentUrl ? `, first deployment: ${result.deployment.deploymentUrl}` : ''}`);
    log(`  Address (once deployed): https://car-rental-${o.slug}.vercel.app (check Settings → Domains in Vercel)`);
  }
  log(`  Admin login: ${vars.ADMIN_EMAIL}; the password and all other values are in ${path.relative(process.cwd(), result.file) || result.file}`);
  log('Next:');
  for (const s of steps) log(`  - ${s}`);
  result.steps = steps;
  return result;
}

function writeEnvFile(slug, content) {
  const dir = path.join(ROOT, 'clients');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}.env`);
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

module.exports = { createClient, parseArgs, validate, instanceVars, SECRETS };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
  } else {
    createClient(args).catch((err) => {
      console.error(err.message);
      console.error('\nRun with --help for the options.');
      process.exit(1);
    });
  }
}
