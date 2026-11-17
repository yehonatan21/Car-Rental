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
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const provision = require('../src/provision');
const { validate, instanceVars, SECRETS, createDatabase, createDeployment, randomSecret } = provision;

const ROOT = path.join(__dirname, '..');

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
  --master                create the master console instead (manages all client instances; see docs/master.md):
                          slug "master", and the API keys below are copied into it
  --dry-run               only show what would be done

Environment: TURSO_API_TOKEN, TURSO_ORG, VERCEL_TOKEN, VERCEL_TEAM_ID (optional), CLIENT_SMTP_PASS (optional).`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key === 'dryRun' || key === 'help' || key === 'master') out[key] = true;
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

/** The master console's own variables: master mode, and the API keys it uses to create and manage clients. */
function masterVars(o, env) {
  const vars = { APP_MODE: 'master', MASTER_SECRET: randomSecret(32), CLIENT_REPO: o.repo, CLIENT_BRANCH: o.branch };
  for (const k of ['TURSO_API_TOKEN', 'TURSO_ORG', 'TURSO_GROUP', 'VERCEL_TOKEN', 'VERCEL_TEAM_ID']) if (env[k]) vars[k] = env[k];
  return vars;
}

function envFile(o, vars, result) {
  const lines = [
    `# ${o.master ? 'Master console' : 'Client instance'} "${o.name}" (${o.slug}), created ${new Date().toISOString().slice(0, 10)}.`,
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
  if (o.master) Object.assign(o, { slug: o.slug || 'master', name: o.name || 'מרכז ניהול לקוחות' });
  const problems = validate(o);
  if (!o.repo) problems.push('--repo: could not read the GitHub repository from git; pass --repo owner/name');
  if (problems.length) throw new Error(`Cannot create the ${o.master ? 'master console' : 'client'}:\n  - ${problems.join('\n  - ')}`);

  const secrets = {
    adminPassword: o.adminPassword || require('node:crypto').randomBytes(12).toString('base64url'),
    cronSecret: randomSecret(),
  };
  const vars = { ...instanceVars(o, env, secrets), ...(o.master ? masterVars(o, env) : {}) };
  const canDb = Boolean(env.TURSO_API_TOKEN && env.TURSO_ORG);
  const canDeploy = Boolean(env.VERCEL_TOKEN);
  const steps = [];

  log(`${o.master ? 'Master console' : 'Client'} "${o.name}" (${o.slug})`);
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
  steps.push('Google sign-in (optional): register https://<the address>/auth/google/callback and set GOOGLE_CLIENT_ID / _SECRET.');
  if (o.master) steps.push('Open the console, sign in, and add the sites that already exist under "הוספת אתר קיים" (see docs/master.md).');

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

module.exports = { createClient, parseArgs, validate, instanceVars, SECRETS, masterVars };

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
