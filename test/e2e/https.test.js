'use strict';
// The development server speaks HTTPS itself, with a generated certificate, and redirects plain HTTP.
const { createUser, dataDir } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { X509Certificate } = require('node:crypto');
const config = require('../../src/config');
const { start } = require('../../src/server');

let server, port, ca;

function request(mod, { method = 'GET', path: p = '/', body, headers = {}, servername = 'localhost' } = {}) {
  return new Promise((resolve, reject) => {
    const req = mod.request({ host: '127.0.0.1', port, method, path: p, ca, servername,
      headers: { host: `localhost:${port}`, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

before(async () => {
  assert.equal(config.https.enabled, true, 'HTTPS is the default outside production');
  createUser({ email: 'tls@test.org' });
  server = await start({ port: 0, host: '127.0.0.1', jobs: false });
  port = server.address().port;
  ca = fs.readFileSync(path.join(dataDir, 'certs', 'localhost-cert.pem'));
});
after(() => new Promise((r) => server.close(r)));

test('the default public URL is https', () => {
  assert.match(config.baseUrl, /^https:\/\/localhost:/);
});

test('generated certificate is valid for localhost and 127.0.0.1, verified by the client', async () => {
  const cert = new X509Certificate(ca);
  assert.match(cert.subjectAltName, /DNS:localhost/);
  assert.match(cert.subjectAltName, /IP Address:127\.0\.0\.1/);
  assert.ok(new Date(cert.validTo) > new Date(Date.now() + 300 * 86400000));
  const r = await request(https, { path: '/login' });
  assert.equal(r.status, 200, 'TLS handshake succeeded with the generated cert as CA');
  assert.match(r.body, /התחברות/);
});

test('plain HTTP on the same port redirects to HTTPS', async () => {
  const r = await request(http, { path: '/calendar?view=week' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, `https://localhost:${port}/calendar?view=week`);
});

test('session cookie is Secure over HTTPS; no HSTS for localhost', async () => {
  const r = await request(https, { method: 'POST', path: '/login', body: 'email=tls%40test.org&password=Password1' });
  assert.equal(r.status, 302);
  const sid = r.headers['set-cookie'].find((c) => c.startsWith('sid='));
  assert.match(sid, /; Secure/);
  assert.match(sid, /HttpOnly/);
  assert.equal(r.headers['strict-transport-security'], undefined, 'HSTS would pin all of localhost');
});

test('HSTS is sent for real host names', async () => {
  const r = await request(https, { path: '/login', headers: { host: 'car.example.org' } });
  assert.equal(r.headers['strict-transport-security'], 'max-age=31536000');
});

test('the certificate is reused on restart', async () => {
  const { selfSignedCertificate } = require('../../src/tls');
  const again = await selfSignedCertificate(path.join(dataDir, 'certs'));
  assert.equal(String(again.cert), String(ca));
});

test('custom certificate files are used when configured', async () => {
  const { tlsOptions } = require('../../src/tls');
  const certFile = path.join(dataDir, 'certs', 'localhost-cert.pem');
  const keyFile = path.join(dataDir, 'certs', 'localhost-key.pem');
  Object.assign(config.https, { certFile, keyFile });
  try {
    const opts = await tlsOptions();
    assert.equal(String(opts.cert), String(ca));
    config.https.keyFile = null;
    await assert.rejects(tlsOptions(), /HTTPS_CERT_FILE and HTTPS_KEY_FILE/);
  } finally {
    Object.assign(config.https, { certFile: null, keyFile: null });
  }
});

test('the generated certificate also covers this machine\'s network addresses (Wi-Fi access)', () => {
  const { certIdentities } = require('../../src/tls');
  const cert = new X509Certificate(ca);
  const { dns, ips } = certIdentities();
  for (const ip of ips) assert.equal(cert.checkIP(ip), ip, ip);
  for (const name of dns) assert.equal(cert.checkHost(name), name, name);
});

test('no HSTS for raw IP addresses (LAN access)', async () => {
  const r = await request(https, { path: '/login', headers: { host: `192.168.1.50:${port}` } });
  assert.equal(r.status, 200);
  assert.equal(r.headers['strict-transport-security'], undefined);
});

test('plain HTTP via a LAN address redirects to https on that address', async () => {
  const r = await request(http, { path: '/', headers: { host: `192.168.1.50:${port}` } });
  assert.equal(r.headers.location, `https://192.168.1.50:${port}/`);
});

test('forms posted from the LAN address are accepted (same-origin check uses the Host)', async () => {
  const r = await request(https, {
    method: 'POST', path: '/login', body: 'email=tls%40test.org&password=Password1',
    headers: { host: `192.168.1.50:${port}`, origin: `https://192.168.1.50:${port}` },
  });
  assert.equal(r.status, 302);
});

test('forms posted through a tunnel that rewrites Host are accepted when BASE_URL matches the origin', async () => {
  // e.g. a tunnel forwarding to localhost:3000 while the browser is on https://abc.trycloudflare.com
  const r = await request(https, {
    method: 'POST', path: '/login', body: 'email=tls%40test.org&password=Password1',
    headers: { origin: new URL(config.baseUrl).origin },
  });
  assert.equal(r.status, 302);
  const bad = await request(https, {
    method: 'POST', path: '/login', body: 'email=tls%40test.org&password=Password1',
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(bad.status, 403);
});
