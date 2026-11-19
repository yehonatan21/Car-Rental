'use strict';
// Running on Vercel: writable temp storage, public URL, demo banner, admin from environment variables.
const { db } = require('../helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');
const { ensureAdminFromEnv } = require('../../src/bootstrap');

const root = path.join(__dirname, '..', '..');

function configWith(env) {
  return JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e',
    'const c = require("./src/config"); console.log(JSON.stringify({ dataDir: c.dataDir, baseUrl: c.baseUrl, ephemeral: c.ephemeral, uploadMaxBytes: c.uploadMaxBytes }))'],
  { cwd: root, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }));
}

test('on Vercel, data goes to the temp directory and the public URL comes from Vercel', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
  const c = configWith({ VERCEL: '1', VERCEL_URL: 'car-rental-abc.vercel.app', TMPDIR: tmp });
  assert.equal(c.dataDir, path.join(tmp, 'car-rental'));
  assert.equal(c.baseUrl, 'https://car-rental-abc.vercel.app');
  assert.equal(c.ephemeral, true);
  const prod = configWith({ VERCEL: '1', VERCEL_URL: 'x.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'car-rental.vercel.app', TMPDIR: tmp });
  assert.equal(prod.baseUrl, 'https://car-rental.vercel.app', 'production domain preferred');
  const persistent = configWith({ VERCEL: '1', DATA_DIR: '/mnt/data' });
  assert.equal(persistent.ephemeral, false, 'no banner when DATA_DIR points at real storage');
  assert.equal(configWith({}).ephemeral, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('admin account from ADMIN_EMAIL / ADMIN_PASSWORD', () => {
  assert.equal(ensureAdminFromEnv({}), null);
  assert.equal(ensureAdminFromEnv({ ADMIN_EMAIL: 'weak@test.org', ADMIN_PASSWORD: 'short' }), null, 'weak password refused');
  const a = ensureAdminFromEnv({ ADMIN_EMAIL: 'Boss@Test.org', ADMIN_PASSWORD: 'LongEnough1' });
  assert.equal(a.email, 'boss@test.org');
  assert.equal(a.role, 'admin');
  assert.equal(a.status, 'active');
  const again = ensureAdminFromEnv({ ADMIN_EMAIL: 'boss@test.org', ADMIN_PASSWORD: 'DifferentPass1' });
  assert.equal(again.password_hash, a.password_hash, 'an existing account is never overwritten');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'boss@test.org'").get().n, 1);
});

test('ADMIN_EMAIL alone: an admin without a password (signs in by e-mail code / Google); the console keeps its main admin', () => {
  const a = ensureAdminFromEnv({ ADMIN_EMAIL: ' "Owner@Test.org" ' });
  assert.equal(a.email, 'owner@test.org');
  assert.equal(a.role, 'admin');
  assert.equal(a.password_hash, null);
  assert.equal(ensureAdminFromEnv({ ADMIN_EMAIL: 'not-an-email' }), null);

  db.prepare("UPDATE users SET role = 'user', status = 'blocked' WHERE id = ?").run(a.id);
  assert.equal(ensureAdminFromEnv({ ADMIN_EMAIL: 'owner@test.org' }, { keepAdmin: false }).role, 'user', 'a client site respects its managers');
  const back = ensureAdminFromEnv({ ADMIN_EMAIL: 'owner@test.org' }, { keepAdmin: true });
  assert.deepEqual([back.role, back.status], ['admin', 'active'], 'the console main admin is never locked out');
});

test('the Vercel entry point serves the app without writing next to the code', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-run-'));
  const script = `
    const http = require('node:http');
    const s = http.createServer(require('./api/index.js')).listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port));`;
  const child = spawn(process.execPath, ['--no-warnings', '-e', script], {
    cwd: root, env: { PATH: process.env.PATH, VERCEL: '1', VERCEL_URL: 'demo.vercel.app', NODE_ENV: 'production', TMPDIR: tmp,
      ADMIN_EMAIL: 'vercel-admin@test.org', ADMIN_PASSWORD: 'VercelAdmin1', ALLOW_TEMPORARY_DATA: 'true', VERCEL_ANALYTICS: 'true' },
  });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => { out += d; const m = /PORT (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
      child.on('exit', (code) => reject(new Error('exited ' + code)));
    });
    const get = (p) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p, headers: { host: 'demo.vercel.app', 'x-forwarded-proto': 'https' } }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
    assert.equal((await get('/healthz')).status, 200);
    const login = await get('/login');
    assert.equal(login.status, 200);
    assert.match(login.body, /סביבת הדגמה/);
    assert.match(login.body, /<script defer src="\/_vercel\/insights\/script.js"><\/script>/, 'Vercel Web Analytics on every page, when switched on');
    assert.match((await get('/privacy')).body, /Vercel Web Analytics/);
    assert.equal((await get('/static/style.css')).status, 200);
    assert.ok(fs.existsSync(path.join(tmp, 'car-rental', 'app.db')), 'database in the temp dir');
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('vercel.json routes everything to the function and does not publish the source code', () => {
  const v = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.equal(v.outputDirectory, 'public', 'only public/ is served as static files');
  assert.equal(v.rewrites.length, 2);
  assert.deepEqual(v.rewrites[0], { source: '/static/(.*)', destination: '/$1' }, 'CSS, JS and fonts straight from Vercel\'s CDN');
  assert.equal(v.rewrites[1].destination, '/api/index');
  const routed = new RegExp(`^${v.rewrites[1].source.replace('/(', '/(?:').replace(/\)$/, ')')}$`);
  assert.ok(routed.test('/login') && routed.test('/') && routed.test('/admin/users/1'), 'app pages go to the function');
  assert.ok(!routed.test('/_vercel/insights/script.js') && !routed.test('/_vercel/insights/view'), 'Vercel Analytics paths are left to Vercel');
  assert.match(v.functions['api/index.js'].includeFiles, /src/);
  assert.match(v.functions['api/index.js'].includeFiles, /public/);
  assert.match(v.functions['api/index.js'].includeFiles, /node_modules\/@libsql\/linux-\*-gnu/, 'native libsql binary (loaded by computed name) is bundled');
  assert.doesNotMatch(v.functions['api/index.js'].includeFiles, /musl|@libsql\}/, 'not the musl build (Vercel runs glibc): it doubled every deployment\'s size');
  assert.equal(v.ignoreCommand, 'node scripts/vercel-ignore-build.js');
  assert.deepEqual(v.crons.map((c) => c.path), ['/internal/cron']);
  const cache = (has) => v.headers.find((h) => h.source === '/static/(.*)' && h[has])?.headers.find((x) => x.key === 'Cache-Control')?.value;
  assert.equal(cache('has'), 'public, max-age=31536000, immutable', 'versioned files: a year');
  assert.equal(cache('missing'), 'public, max-age=604800', 'others: a week');
});

test('the analytics script is added only on Vercel, and only when switched on', () => {
  const flag = (env) => JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e', 'console.log(require("./src/config").vercelAnalytics)'],
    { cwd: root, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }));
  assert.equal(flag({}), false, 'not off Vercel (the script would 404)');
  assert.equal(flag({ VERCEL: '1' }), false, 'not enabled on the project: the script would 404');
  assert.equal(flag({ VERCEL: '1', VERCEL_ANALYTICS: 'true' }), true);
  assert.equal(flag({ VERCEL_ANALYTICS: 'true' }), false);
});

test('Vercel entry point: a database that cannot be reached gives an explained 503, not a crash', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-down-'));
  const script = `
    const http = require('node:http');
    const s = http.createServer(require('./api/index.js')).listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port));`;
  const child = spawn(process.execPath, ['--no-warnings', '-e', script], {
    cwd: root, env: { PATH: process.env.PATH, VERCEL: '1', NODE_ENV: 'production', TMPDIR: tmp,
      // Pasted with a trailing newline, pointing at a port nobody listens on.
      TURSO_DATABASE_URL: 'libsql://127.0.0.1:9\n', TURSO_AUTH_TOKEN: 'eyJhbGciOi.eyJzZWNyZXQi.c2lnbmF0dXJl' },
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => { out += d; const m = /PORT (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
      child.on('exit', (code) => reject(new Error('exited ' + code + ': ' + stderr)));
    });
    const get = () => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/', headers: { 'x-forwarded-proto': 'https' } }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
    const first = await get();
    assert.equal(first.status, 503);
    assert.match(first.body, /TURSO_DATABASE_URL/);
    assert.match(first.body, /Connection refused/, 'the real reason is shown');
    assert.doesNotMatch(first.body, /eyJzZWNyZXQi/, 'no token on the page');
    assert.equal((await get()).status, 503, 'still serving (retries startup), not crashed');
    assert.match(stderr, /\[startup\] The app failed to start/);
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Israel time even where the host sets TZ=:UTC (Vercel / AWS Lambda); APP_TIMEZONE overrides', () => {
  const offsetFor = (env) => Number(execFileSync(process.execPath, ['--no-warnings', '-e',
    'require("./src/config"); console.log(new Date("2026-07-01T12:00:00Z").getTimezoneOffset())'],
  { cwd: root, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }));
  assert.equal(offsetFor({ VERCEL: '1', TZ: ':UTC' }), -180, 'summer time in Israel is UTC+3');
  assert.equal(offsetFor({}), -180);
  assert.equal(offsetFor({ TZ: ':UTC', APP_TIMEZONE: 'Europe/London' }), -60);
});

test('preview deployments (the dev branch) use their own branch address; uploads stay under Vercel\'s 4.5 MB limit', () => {
  const preview = configWith({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'car-rental-abc123-team.vercel.app',
    VERCEL_BRANCH_URL: 'car-rental-git-dev-team.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'car-rental.vercel.app' });
  assert.equal(preview.baseUrl, 'https://car-rental-git-dev-team.vercel.app', 'not the production site');
  const production = configWith({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_URL: 'car-rental-abc123-team.vercel.app',
    VERCEL_BRANCH_URL: 'car-rental-git-main-team.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'car-rental.vercel.app' });
  assert.equal(production.baseUrl, 'https://car-rental.vercel.app');
  assert.equal(configWith({ VERCEL: '1', VERCEL_ENV: 'preview', BASE_URL: 'https://dev.example.org' }).baseUrl, 'https://dev.example.org');
  assert.ok(preview.uploadMaxBytes < 4.5 * 1024 * 1024);
  assert.equal(configWith({}).uploadMaxBytes, 8 * 1024 * 1024);
});

test('addresses pasted without https:// / libsql:// or in quotes still work; a broken one names the variable', async () => {
  assert.equal(configWith({ BASE_URL: 'car-rental-brown-kappa.vercel.app' }).baseUrl, 'https://car-rental-brown-kappa.vercel.app');
  assert.equal(configWith({ BASE_URL: ' "https://car-rental.vercel.app/" ' }).baseUrl, 'https://car-rental.vercel.app');
  const db = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e', 'console.log(JSON.stringify(require("./src/config").database))'],
    { cwd: root, env: { PATH: process.env.PATH, TURSO_DATABASE_URL: "'car-rental-x.turso.io'", TURSO_AUTH_TOKEN: ' "Bearer abc.def" ' }, encoding: 'utf8' }));
  assert.deepEqual(db, { url: 'libsql://car-rental-x.turso.io', authToken: 'abc.def', from: 'TURSO_DATABASE_URL' }, 'never taken as a local file name');

  // On Vercel the entry point explains it instead of a bare "Invalid URL".
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-url-'));
  const out = execFileSync(process.execPath, ['--no-warnings', '-e', `
    const http = require('node:http');
    const s = http.createServer(require('./api/index.js')).listen(0, '127.0.0.1', () => {
      http.get({ host: '127.0.0.1', port: s.address().port, path: '/' }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { console.log(res.statusCode + ' ' + b); process.exit(0); });
      });
    });`], { cwd: root, env: { PATH: process.env.PATH, VERCEL: '1', NODE_ENV: 'production', TMPDIR: tmp, BASE_URL: 'https://' }, encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.match(out, /^503 /);
  assert.match(out, /הערך של BASE_URL אינו כתובת תקינה/);
  assert.match(out, /BASE_URL is not a valid address: &quot;https:\/\/&quot;/);
});

/** GET / through the Vercel entry point in a child process with the given environment: "<status> <body>". */
function vercelGet(env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-get-'));
  try {
    return execFileSync(process.execPath, ['--no-warnings', '-e', `
      const http = require('node:http');
      const s = http.createServer(require('./api/index.js')).listen(0, '127.0.0.1', () => {
        http.get({ host: '127.0.0.1', port: s.address().port, path: '/login', headers: { 'x-forwarded-proto': 'https' } }, (res) => {
          let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { console.log(res.statusCode + ' ' + b); process.exit(0); });
        });
      });`], { cwd: root, env: { PATH: process.env.PATH, VERCEL: '1', NODE_ENV: 'production', TMPDIR: tmp, ...env }, encoding: 'utf8' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('Vercel without a hosted database: a clear stop page instead of data that silently disappears', () => {
  const out = vercelGet({ VERCEL_ENV: 'production' });
  assert.match(out, /^503 /);
  assert.match(out, /לא מחובר מסד נתונים לפריסה הזו/);
  assert.match(out, /No database is connected to this production deployment/);
  const demo = vercelGet({ ALLOW_TEMPORARY_DATA: 'true' });
  assert.match(demo, /^200 [\s\S]*סביבת הדגמה/m, 'a throwaway demo only on purpose');
  assert.match(demo, /^\[db\] temporary database file/m, 'and the log says so');
});

test('Turso variables added by the Vercel integration under a custom prefix are found', () => {
  const db = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e', 'console.log(JSON.stringify(require("./src/config").database))'],
    { cwd: root, env: { PATH: process.env.PATH, STORAGE_TURSO_DATABASE_URL: 'libsql://car-rental-team.aws-eu-west-1.turso.io',
      STORAGE_TURSO_AUTH_TOKEN: 'tok', OTHER_DATABASE_URL: 'postgres://x' }, encoding: 'utf8' }));
  assert.deepEqual(db, { url: 'libsql://car-rental-team.aws-eu-west-1.turso.io', authToken: 'tok', from: 'STORAGE_TURSO_DATABASE_URL' });
});

test('LIBSQL_URL pins one permanent database even when the Turso integration injects TURSO_DATABASE_URL', () => {
  const db = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e', 'console.log(JSON.stringify(require("./src/config").database))'],
    { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH,
      TURSO_DATABASE_URL: 'libsql://dpl-h3ftpc1wn599qufqmwhc28-vercel-icfg-beumz0zl0at2ayxpixsatymh.aws-us-east-1.turso.io', TURSO_AUTH_TOKEN: 'per-deploy',
      LIBSQL_URL: 'libsql://car-rental-yehonatan21.aws-eu-central-1.turso.io', LIBSQL_AUTH_TOKEN: 'permanent' } }));
  assert.deepEqual(db, { url: 'libsql://car-rental-yehonatan21.aws-eu-central-1.turso.io', authToken: 'permanent', from: 'LIBSQL_URL' });
});

test('a database created for one deployment by the integration is recognised', () => {
  const { isPerDeploymentHost } = require('../../src/db');
  assert.equal(isPerDeploymentHost('dpl-h3ftpc1wn599qufqmwhc28-vercel-icfg-beumz0zl0at2ayxpixsatymh.aws-us-east-1.turso.io'), true);
  assert.equal(isPerDeploymentHost('car-rental-yehonatan21.aws-eu-central-1.turso.io'), false);
  assert.equal(isPerDeploymentHost(null), false);
});

test('only the harmless url.parse() deprecation (DEP0169) is silenced', () => {
  const { stderr } = require('node:child_process').spawnSync(process.execPath, ['-e', `
    require('./src/quiet-warnings');
    process.emitWarning('url.parse() behavior is not standardized', 'DeprecationWarning', 'DEP0169');
    process.emitWarning('url.parse() again', { type: 'DeprecationWarning', code: 'DEP0169' });
    process.emitWarning('something else', 'DeprecationWarning', 'DEP0005');
    setTimeout(() => {}, 50);`], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.doesNotMatch(stderr, /DEP0169|url\.parse/);
  assert.match(stderr, /DEP0005.*something else|something else/, 'other warnings still print');
});

test('Vercel deploys production only: main is always built, no other branch', () => {
  const v = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.equal(v.git.deploymentEnabled.dev, false, 'dev pushes create no Vercel deployment');
  assert.notEqual(v.git.deploymentEnabled.main, false);
  const { decide } = require('../../scripts/vercel-ignore-build');
  const build = (env, changed) => decide(env, changed).build;
  assert.equal(build({ VERCEL_GIT_COMMIT_REF: 'main' }, ['src/server.js']), true);
  assert.equal(build({ VERCEL_GIT_COMMIT_REF: 'dev' }, ['src/server.js']), false, 'no dev previews');
  assert.equal(build({ VERCEL_GIT_COMMIT_REF: 'claude/some-work' }, ['src/server.js']), false, 'work and pull-request branches');
  assert.equal(build({ VERCEL_GIT_COMMIT_REF: 'main', CLIENT_SITE: '1' }, ['src/server.js']), true, 'client sites build main too');
  assert.equal(build({ VERCEL_GIT_COMMIT_REF: 'main' }, ['.claude/settings.json']), true, 'a redeploy after a docs-only commit still builds (new variables)');
  assert.equal(build({ VERCEL_GIT_COMMIT_REF: 'main' }, ['README.md', 'package-lock.json']), true);
  assert.equal(build({ VERCEL_GIT_COMMIT_REF: 'main' }, []), true, 'a redeploy of the same commit (e.g. new variables) is built');
  assert.equal(build({ VERCEL_GIT_COMMIT_REF: 'main' }, null), true, 'unknown changes: built, to be safe');
  assert.equal(build({}, null), true, 'deployments made through the API or CLI are built');
});
