'use strict';
// "Sign in with Google" on a client site through the main site's callback (GOOGLE_RELAY_URL): Google only knows the main
// site's address, the main site passes the answer on to the client site, and only to its own clients.
process.env.MASTER_CONSOLE = 'true';
process.env.ADMIN_EMAIL = 'main@relay.test';
process.env.GOOGLE_CLIENT_ID = 'shared-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'shared-secret';
const { startServer, startInstanceProcess, Client } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const config = require('../../src/config');
const master = require('../../src/master');

let srv, site, fakeGoogle;
const codes = new Map();
const tokenRequests = [];
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

before(async () => {
  srv = await startServer();
  config.baseUrl = srv.base; // the main site, whose callback is the one registered with Google
  const relayCallback = `${srv.base}/auth/google/callback`;
  // A fake Google token endpoint that, like Google, accepts only the registered redirect URI (and checks PKCE).
  fakeGoogle = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = new URLSearchParams(body);
      tokenRequests.push(Object.fromEntries(p));
      const entry = codes.get(p.get('code'));
      codes.delete(p.get('code'));
      const send = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (p.get('redirect_uri') !== relayCallback) return send(400, { error: 'redirect_uri_mismatch' });
      if (!entry || crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') !== entry.challenge) return send(400, { error: 'invalid_grant' });
      send(200, { access_token: 'x', id_token: `${b64url({ alg: 'RS256' })}.${b64url(entry.claims)}.sig` });
    });
  });
  await new Promise((r) => fakeGoogle.listen(0, '127.0.0.1', r));
  const port = await freePort();
  site = await startInstanceProcess({
    TEST_PORT: String(port), BASE_URL: `http://127.0.0.1:${port}`, APP_NAME: 'גמח רכב בית חגי',
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_TOKEN_URL: `http://127.0.0.1:${fakeGoogle.address().port}/token`, GOOGLE_RELAY_URL: srv.base,
    ADMIN_EMAIL: 'manager@hagi.test', ADMIN_PASSWORD: 'HagiManager1',
  });
  master.add({ slug: 'biet-hagi', name: 'גמח רכב בית חגי', url: site.base });
});
after(async () => {
  if (site) await site.stop();
  fakeGoogle.close();
  await srv.close();
});

test('a client site signs in with Google through the main site, with nothing registered for the client', async () => {
  const browserAtSite = new Client(site.base);
  const start = await browserAtSite.get('/auth/google');
  assert.equal(start.status, 302);
  const google = new URL(start.location);
  assert.equal(google.searchParams.get('redirect_uri'), `${srv.base}/auth/google/callback`, 'the main site\'s registered address');
  const state = google.searchParams.get('state');
  assert.match(state, /^r\./);

  // Google answers at the main site, which passes it on to the client site.
  const code = 'code-' + crypto.randomBytes(6).toString('hex');
  codes.set(code, {
    challenge: google.searchParams.get('code_challenge'),
    claims: { iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600,
      nonce: google.searchParams.get('nonce'), email_verified: true, sub: 'g-hagi-1', email: 'driver@hagi.test', given_name: 'נועם' },
  });
  const atMain = await new Client(srv.base).get(`/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}`);
  assert.equal(atMain.status, 302);
  const forwarded = new URL(atMain.location);
  assert.equal(forwarded.origin + forwarded.pathname, `${site.base}/auth/google/callback`);
  assert.equal(forwarded.searchParams.get('state'), state);

  // The client site checks its own state cookie and PKCE, and exchanges the code with the same registered address.
  const done = await browserAtSite.get(forwarded.pathname + forwarded.search);
  assert.equal(done.status, 302, 'the client site handles an answer meant for itself (it does not pass it on again)');
  assert.equal(done.location, '/register', 'a new Google user continues to the registration form');
  assert.equal(tokenRequests.at(-1).redirect_uri, `${srv.base}/auth/google/callback`);
  assert.match((await browserAtSite.get('/register')).text, /driver@hagi\.test/);
});

test('the main site passes answers on only to its own client sites', async () => {
  const evil = `r.${Buffer.from('https://evil.example').toString('base64url')}.${crypto.randomBytes(24).toString('base64url')}`;
  const r = await new Client(srv.base).get(`/auth/google/callback?code=stolen&state=${evil}`);
  assert.equal(r.status, 400);
  assert.equal(r.location, null);
  assert.match(r.text, /האתר שממנו התחלתם את ההתחברות אינו מוכר כאן/);
  // A broken relay state is an ordinary (failed) login of the main site, never a redirect elsewhere.
  const broken = await new Client(srv.base).get('/auth/google/callback?code=x&state=r.@@@.abc');
  assert.notEqual(new URL(broken.location || '/', srv.base).origin, 'https://evil.example');
  assert.equal(broken.location, '/login');
});

test('the client site\'s settings say nothing needs registering in Google Cloud', async () => {
  const manager = new Client(site.base);
  await manager.login('manager@hagi.test', 'HagiManager1');
  const page = (await manager.get('/admin/settings?tab=integrations')).text;
  assert.match(page, new RegExp(`ההתחברות עוברת דרך כתובת החזרה של <code dir="ltr">${srv.base.replace(/[.]/g, '\\.')}</code>`));
  assert.doesNotMatch(page, /מה להזין ב־Google Cloud Console/);
});
