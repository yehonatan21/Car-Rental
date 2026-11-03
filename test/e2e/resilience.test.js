'use strict';
// The real server process (npm start) survives a stray asynchronous error instead of exiting.
require('../helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

test('an unexpected async error is logged and the server keeps answering', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-'));
  const boom = path.join(tmp, 'boom.js');
  // Thrown outside any request, after the server is up, like a late socket error from a library.
  fs.writeFileSync(boom, "setTimeout(() => { throw new Error('late socket error'); }, 300);\n"
    + "setTimeout(() => Promise.reject(new Error('lost promise')), 400);\n");
  const child = spawn(process.execPath, ['--no-warnings', '-r', boom, 'src/server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { PATH: process.env.PATH, PORT: '0', HTTPS: 'false', DATA_DIR: path.join(tmp, 'data') },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    const port = await new Promise((resolve, reject) => {
      child.stdout.on('data', () => { const m = /Local:\s+http:\/\/localhost:(\d+)/.exec(out); if (m) resolve(Number(m[1])); });
      child.on('exit', (code) => reject(new Error(`server exited ${code}\n${out}`)));
    });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(child.exitCode, null, 'still running');
    const status = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/healthz`, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(status, 200);
    assert.match(out, /\[error\] Unexpected error; the server keeps running:[\s\S]*late socket error/);
    assert.match(out, /\[error\] Unhandled rejection; the server keeps running:[\s\S]*lost promise/);
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
