'use strict';
// Starting the server the way `npm start` does (node src/server.js), in a process of its own: what it prints, the
// background jobs, surviving a stray error, failing clearly when the port is taken; and the schema upgrade running at
// the same moment as another instance's.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..');
const fixture = (f) => path.join(__dirname, '..', 'fixtures', f);

function baseEnv(dataDir, extra = {}) {
  const env = { PATH: process.env.PATH, TZ: 'Asia/Jerusalem', DATA_DIR: dataDir, HTTPS: 'false', ...extra };
  for (const k of ['NODE_V8_COVERAGE']) if (process.env[k]) env[k] = process.env[k]; // the test runner's coverage
  return env;
}

/** Runs `node src/server.js` until `until` matches its output (or it exits). Returns { out, code }. */
function runServer(env, until) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '-r', fixture('graceful.js'), 'src/server.js'], { cwd: root, env });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out:\n${out}`)); }, 20000);
    const onData = (d) => {
      out += d;
      if (until && until.test(out)) child.kill('SIGTERM');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ out, code }); });
  });
}

test('node src/server.js: prints where it runs, starts the jobs, survives a stray error, stops on SIGTERM', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-start-'));
  try {
    const { out, code } = await runServer(baseEnv(dir, { PORT: '0', FAULTS: '1' }), /STILL RUNNING/);
    assert.equal(code, 0);
    assert.match(out, /is running\n {2}Local: {6}http:\/\/localhost:\d+/);
    assert.match(out, /Public URL: /);
    assert.match(out, /\[mail\] No SMTP_HOST set/);
    assert.match(out, /\[error\] Unhandled rejection; the server keeps running: Error: stray rejection/);
    assert.match(out, /\[error\] Unexpected error; the server keeps running: Error: stray error/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('node src/server.js on a port already in use: the reason is printed and it exits with an error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-busy-'));
  const busy = net.createServer();
  await new Promise((r) => busy.listen(0, '0.0.0.0', r));
  try {
    const { out, code } = await runServer(baseEnv(dir, { PORT: String(busy.address().port) }), null);
    assert.equal(code, 1);
    assert.match(out, /EADDRINUSE/);
  } finally {
    busy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('schema upgrade while another instance upgrades the same database: its column changes are not errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-race-'));
  try {
    const load = (preload = []) => execFileSync(process.execPath, ['--no-warnings', ...preload, '-e', "require('./src/db'); console.log('READY')"],
      { cwd: root, env: baseEnv(dir), encoding: 'utf8' });
    assert.match(load(), /READY/); // a new database
    // An older version set it up: the setup runs again on the next start.
    const { DatabaseSync } = require('node:sqlite');
    const file = new DatabaseSync(path.join(dir, 'app.db'));
    file.exec("UPDATE app_meta SET value = 'older' WHERE key = 'schema_version'");
    file.close();
    assert.match(load(['-r', fixture('racing-schema.js')]), /READY/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
