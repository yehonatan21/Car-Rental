'use strict';
// scripts/new-client.js: creating a client instance (own Turso database + own Vercel deployment), against fake APIs.
require('../helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClient, parseArgs } = require('../../scripts/new-client');

/** A fake fetch for the Turso and Vercel APIs; records every call. `existing` makes "create" answer 409. */
function fakeApis({ existing = false, failOn } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body, auth: init.headers?.authorization });
    const reply = (status, data) => ({ ok: status < 300, status, statusText: '', text: async () => JSON.stringify(data) });
    if (failOn && url.includes(failOn)) return reply(403, { error: { message: 'not allowed for this token' } });
    if (url.includes('api.turso.tech')) {
      if (url.endsWith('/databases') && init.method === 'POST') {
        return existing ? reply(409, { error: 'database already exists' })
          : reply(200, { database: { Name: body.name, Hostname: `${body.name}-myorg.aws-eu-central-1.turso.io` } });
      }
      if (init.method === 'GET') return reply(200, { database: { Name: 'car-rental-bne-adam', Hostname: 'car-rental-bne-adam-myorg.aws-eu-central-1.turso.io' } });
      if (url.includes('/auth/tokens')) return reply(200, { jwt: 'eyJhbGciOi.SECRET-DB-TOKEN.sig' });
    }
    if (url.includes('api.vercel.com')) {
      if (url.includes('/v11/projects') && init.method === 'POST') {
        return existing ? reply(409, { error: { message: 'Project already exists' } }) : reply(200, { id: 'prj_new', name: body.name, link: { repoId: 123456 } });
      }
      if (url.includes('/v9/projects/')) return reply(200, { id: 'prj_old', name: 'car-rental-bne-adam' });
      if (url.includes('/env')) return reply(201, { created: body });
      if (url.includes('/v13/deployments')) return reply(200, { id: 'dpl_1', url: 'car-rental-bne-adam-abc123.vercel.app' });
    }
    return reply(404, { error: 'unexpected call ' + url });
  };
  return { calls, fetchImpl };
}

const ENV = { TURSO_API_TOKEN: 'turso-api-token', TURSO_ORG: 'myorg', VERCEL_TOKEN: 'vercel-token', VERCEL_TEAM_ID: 'team_x', CLIENT_SMTP_PASS: 'abcd efgh ijkl mnop' };
const OPTS = { slug: 'bne-adam', name: 'גמח רכב בני אדם', adminEmail: 'Admin@Example.org', color: '#1d4ed8', contactPhone: '050-1234567',
  smtpUser: 'gmach.car.bne.adam@gmail.com', repo: 'yehonatan21/Car-Rental' };

function run(opts = OPTS, env = ENV, apis = fakeApis()) {
  const out = [];
  const files = {};
  return createClient(opts, { env, fetchImpl: apis.fetchImpl, log: (l) => out.push(l), write: (slug, content) => { files[slug] = content; return `clients/${slug}.env`; } })
    .then((result) => ({ result, out: out.join('\n'), files, calls: apis.calls }));
}

test('creates the database, the Vercel project with its variables, and the first deployment', async () => {
  const { result, out, files, calls } = await run();
  const turso = calls.filter((c) => c.url.includes('api.turso.tech'));
  assert.equal(turso[0].url, 'https://api.turso.tech/v1/organizations/myorg/databases');
  assert.deepEqual(turso[0].body, { name: 'car-rental-bne-adam', group: 'default' });
  assert.equal(turso[0].auth, 'Bearer turso-api-token');
  assert.match(turso[1].url, /\/databases\/car-rental-bne-adam\/auth\/tokens\?expiration=53w&authorization=full-access$/);

  const vercel = calls.filter((c) => c.url.includes('api.vercel.com'));
  assert.equal(vercel[0].url, 'https://api.vercel.com/v11/projects?teamId=team_x');
  assert.deepEqual(vercel[0].body, { name: 'car-rental-bne-adam', framework: null, gitRepository: { type: 'github', repo: 'yehonatan21/Car-Rental' } });
  assert.equal(vercel[1].url, 'https://api.vercel.com/v10/projects/prj_new/env?upsert=true&teamId=team_x');
  const envs = Object.fromEntries(vercel[1].body.map((e) => [e.key, e]));
  assert.equal(envs.LIBSQL_URL.value, 'libsql://car-rental-bne-adam-myorg.aws-eu-central-1.turso.io');
  assert.equal(envs.APP_NAME.value, 'גמח רכב בני אדם');
  assert.equal(envs.MAIL_FROM_NAME.value, 'גמח רכב בני אדם');
  assert.equal(envs.ADMIN_EMAIL.value, 'admin@example.org');
  assert.equal(envs.BRAND_COLOR.value, '#1d4ed8');
  assert.equal(envs.SMTP_HOST.value, 'smtp.gmail.com');
  assert.equal(envs.SMTP_PORT.value, '465');
  for (const e of vercel[1].body) assert.deepEqual(e.target, e.key === 'CLIENT_SITE' ? ['production', 'preview'] : ['production']);
  assert.equal(envs.CLIENT_SITE.value, '1', 'only main is built for a client site');
  for (const k of ['LIBSQL_AUTH_TOKEN', 'ADMIN_PASSWORD', 'CRON_SECRET', 'SMTP_PASS']) assert.equal(envs[k].type, 'sensitive', k);
  assert.equal(envs.APP_NAME.type, 'plain');
  assert.ok(envs.ADMIN_PASSWORD.value.length >= 12, 'a random admin password');
  assert.deepEqual(vercel[2].body, { name: 'car-rental-bne-adam', project: 'prj_new', target: 'production',
    gitSource: { type: 'github', repoId: 123456, ref: 'main' } });

  assert.equal(result.deployment.deploymentUrl, 'https://car-rental-bne-adam-abc123.vercel.app');
  assert.match(files['bne-adam'], /^LIBSQL_AUTH_TOKEN=eyJhbGciOi\.SECRET-DB-TOKEN\.sig$/m, 'everything in the client file');
  assert.match(files['bne-adam'], /^APP_NAME="גמח רכב בני אדם"$/m);
  assert.doesNotMatch(out, /SECRET-DB-TOKEN|abcd efgh|turso-api-token|vercel-token/, 'no secret is printed');
  assert.doesNotMatch(out, new RegExp(envs.ADMIN_PASSWORD.value));
  assert.ok(!result.steps.some((s) => /Turso|Add New → Project/.test(s)), 'nothing left to do by hand for database and deployment');
});

test('running it again for the same client reuses the database and the project', async () => {
  const { result, calls } = await run(OPTS, ENV, fakeApis({ existing: true }));
  assert.ok(calls.some((c) => c.method === 'GET' && c.url.endsWith('/organizations/myorg/databases/car-rental-bne-adam')));
  assert.ok(calls.some((c) => c.url.includes('/v9/projects/car-rental-bne-adam?teamId=team_x')));
  assert.equal(result.deployment.projectId, 'prj_old');
  const deploy = calls.find((c) => c.url.includes('/v13/deployments'));
  assert.deepEqual(deploy.body.gitSource, { type: 'github', org: 'yehonatan21', repo: 'Car-Rental', ref: 'main' });
});

test('without API tokens: no network calls, the file and the manual steps instead', async () => {
  const { result, files, calls } = await run(OPTS, {});
  assert.equal(calls.length, 0);
  assert.match(files['bne-adam'], /^ADMIN_EMAIL=admin@example\.org$/m);
  assert.doesNotMatch(files['bne-adam'], /LIBSQL_URL/);
  assert.ok(result.steps.some((s) => /Create a Turso database/.test(s)));
  assert.ok(result.steps.some((s) => /import yehonatan21\/Car-Rental/.test(s)));
  assert.ok(result.steps.some((s) => /SMTP_PASS/.test(s)), 'the mail password is still missing');
});

test('dry run creates nothing; bad options are refused; API errors are reported clearly', async () => {
  const dry = await run({ ...OPTS, dryRun: true });
  assert.equal(dry.calls.length, 0);
  assert.deepEqual(dry.files, {});
  await assert.rejects(run({ ...OPTS, slug: 'Bad Slug', adminEmail: 'nope', color: 'blue' }),
    (err) => /--slug/.test(err.message) && /--admin-email/.test(err.message) && /--color/.test(err.message));
  await assert.rejects(run(OPTS, ENV, fakeApis({ failOn: '/v11/projects' })), /api\.vercel\.com\/v11\/projects → 403: not allowed for this token/);
  await assert.rejects(run(OPTS, { VERCEL_TOKEN: 'v' }), /needs the database/);
});

test('command line options', () => {
  assert.deepEqual(parseArgs(['--slug', 'x', '--admin-email', 'a@b.co', '--smtp-user', 'm@g.com', '--dry-run']),
    { slug: 'x', adminEmail: 'a@b.co', smtpUser: 'm@g.com', dryRun: true });
});

test('--master creates the master console: master mode, its own secret, and the API keys it needs to create clients', async () => {
  const { calls, files } = await run({ master: true, adminEmail: 'boss@example.org', repo: 'yehonatan21/Car-Rental' });
  const vercel = calls.filter((c) => c.url.includes('api.vercel.com'));
  assert.equal(vercel[0].body.name, 'car-rental-master');
  const envs = Object.fromEntries(vercel[1].body.map((e) => [e.key, e]));
  assert.equal(envs.APP_MODE.value, 'master');
  assert.equal(envs.APP_NAME.value, 'מרכז ניהול לקוחות');
  assert.equal(envs.CLIENT_REPO.value, 'yehonatan21/Car-Rental');
  assert.equal(envs.TURSO_ORG.value, 'myorg');
  assert.equal(envs.VERCEL_TEAM_ID.value, 'team_x');
  for (const k of ['TURSO_API_TOKEN', 'VERCEL_TOKEN', 'MASTER_SECRET', 'ADMIN_PASSWORD', 'LIBSQL_AUTH_TOKEN']) assert.equal(envs[k].type, 'sensitive', k);
  assert.equal(envs.TURSO_API_TOKEN.value, 'turso-api-token');
  assert.ok(envs.MASTER_SECRET.value.length >= 64);
  assert.match(files.master, /^APP_MODE=master$/m);
});
