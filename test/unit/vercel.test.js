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
    'const c = require("./src/config"); console.log(JSON.stringify({ dataDir: c.dataDir, baseUrl: c.baseUrl, ephemeral: c.ephemeral }))'],
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

test('the Vercel entry point serves the app without writing next to the code', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-run-'));
  const script = `
    const http = require('node:http');
    const s = http.createServer(require('./api/index.js')).listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port));`;
  const child = spawn(process.execPath, ['--no-warnings', '-e', script], {
    cwd: root, env: { PATH: process.env.PATH, VERCEL: '1', VERCEL_URL: 'demo.vercel.app', NODE_ENV: 'production', TMPDIR: tmp,
      ADMIN_EMAIL: 'vercel-admin@test.org', ADMIN_PASSWORD: 'VercelAdmin1' },
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
  assert.deepEqual(v.rewrites, [{ source: '/(.*)', destination: '/api/index' }]);
  assert.match(v.functions['api/index.js'].includeFiles, /src/);
  assert.match(v.functions['api/index.js'].includeFiles, /public/);
});
