'use strict';
// Production: TLS is terminated by the reverse proxy (Caddy), which forwards X-Forwarded-Proto.
process.env.NODE_ENV = 'production';
delete process.env.HTTPS;
const { createUser, startServer } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../../src/config');

let srv;

/** Raw HTTP request (fetch() would drop the Host header, which the proxy sets). */
function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(srv.base + path, { method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const get = (path, headers) => request(path, { headers });
const form = { 'content-type': 'application/x-www-form-urlencoded' };

before(async () => {
  createUser({ email: 'prod@test.org' });
  srv = await startServer();
});
after(() => srv.close());

test('production defaults: no TLS in Node, HTTPS enforced', () => {
  assert.equal(config.https.enabled, false);
  assert.equal(config.forceHttps, true);
});

test('plain HTTP requests are redirected to https', async () => {
  const r = await get('/login?x=1', { host: 'car.example.org' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, 'https://car.example.org/login?x=1');
});

test('the health check stays reachable over plain HTTP for Docker/platform probes', async () => {
  assert.equal((await get('/healthz')).status, 200);
});

test('requests forwarded as HTTPS by the proxy are served with HSTS and Secure cookies', async () => {
  const headers = { 'x-forwarded-proto': 'https', host: 'car.example.org' };
  const page = await get('/login', headers);
  assert.equal(page.status, 200);
  assert.equal(page.headers['strict-transport-security'], 'max-age=31536000');
  const login = await request('/login', {
    method: 'POST', headers: { ...headers, ...form, origin: 'https://car.example.org' }, body: 'email=prod%40test.org&password=Password1',
  });
  assert.equal(login.status, 302);
  assert.match(login.headers['set-cookie'].find((c) => c.startsWith('sid=')), /; Secure/);
});

test('a cross-origin POST is still rejected behind the proxy', async () => {
  const r = await request('/login', {
    method: 'POST', headers: { 'x-forwarded-proto': 'https', host: 'car.example.org', origin: 'http://car.example.org', ...form }, body: 'email=a&password=b',
  });
  assert.equal(r.status, 403, 'http:// origin does not match the https site');
});
