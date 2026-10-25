'use strict';
// "Sign in with Google" against a fake Google token endpoint (checks PKCE like Google does).
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
const { db, createUser, getUser, startServer, Client, registrationForm } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const config = require('../../src/config');
const auth = require('../../src/auth');

let srv, fakeGoogle;
const codes = new Map(); // code → { claims, challenge } | { status }
const tokenRequests = [];
const client = () => new Client(srv.base);
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

before(async () => {
  fakeGoogle = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = new URLSearchParams(body);
      tokenRequests.push(Object.fromEntries(p));
      const entry = codes.get(p.get('code'));
      codes.delete(p.get('code'));
      const pkceOk = entry && crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') === entry.challenge;
      if (!entry || entry.status || !pkceOk || p.get('client_secret') !== 'test-secret') {
        res.writeHead(entry?.status || 400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: entry?.error || 'invalid_grant' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'x', id_token: `${b64url({ alg: 'RS256' })}.${b64url(entry.claims)}.sig` }));
    });
  });
  await new Promise((r) => fakeGoogle.listen(0, '127.0.0.1', r));
  config.google.tokenUrl = `http://127.0.0.1:${fakeGoogle.address().port}/token`;
  srv = await startServer();
  config.baseUrl = srv.base; // Google returns users to BASE_URL, so the tests browse at that address
});
after(async () => {
  await srv.close();
  fakeGoogle.close();
});

/** Runs the browser side of the flow: /auth/google → (Google) → /auth/google/callback. */
async function googleLogin(c, claims = {}, { next, tamper, status } = {}) {
  const start = await c.get('/auth/google' + (next ? `?next=${encodeURIComponent(next)}` : ''));
  assert.equal(start.status, 302);
  const url = new URL(start.location);
  const state = url.searchParams.get('state');
  const code = crypto.randomBytes(8).toString('hex');
  codes.set(code, status ? { status } : {
    challenge: url.searchParams.get('code_challenge'),
    claims: {
      iss: 'https://accounts.google.com', aud: config.google.clientId, exp: Math.floor(Date.now() / 1000) + 600,
      nonce: url.searchParams.get('nonce'), email_verified: true, sub: 'g-' + code, ...claims,
    },
  });
  return c.get(`/auth/google/callback?code=${code}&state=${tamper?.state ?? state}`);
}

test('login and registration pages offer "Sign in with Google"', async () => {
  assert.match((await client().get('/login')).text, /href="\/auth\/google"[^>]*>[\s\S]*התחברות עם Google/);
  assert.match((await client().get('/login?next=/calendar')).text, /href="\/auth\/google\?next=%2Fcalendar"/);
  assert.match((await client().get('/register')).text, /הרשמה מהירה עם Google/);
});

test('the authorization request uses PKCE, state, nonce and the configured redirect URI', async () => {
  const r = await client().get('/auth/google');
  const url = new URL(r.location);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const p = url.searchParams;
  assert.equal(p.get('client_id'), config.google.clientId);
  assert.equal(p.get('redirect_uri'), `${config.baseUrl}/auth/google/callback`);
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('scope'), 'openid email profile');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.ok(p.get('state').length >= 40 && p.get('nonce').length >= 40 && p.get('code_challenge'));
  assert.match(r.headers.getSetCookie().join(), /gstate=.*HttpOnly/i);
});

test('existing user signs in with Google: account linked by verified e-mail, then by Google id', async () => {
  const u = createUser({ email: 'linked@test.org' });
  const c = client();
  const r = await googleLogin(c, { email: 'Linked@test.org', sub: 'sub-linked' });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/calendar');
  assert.equal((await c.get('/me')).status, 200);
  assert.equal(getUser(u.id).google_sub, 'sub-linked');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'user.google_link' AND target_id = ?").get(u.id));
  const last = tokenRequests.at(-1);
  assert.equal(last.grant_type, 'authorization_code');
  assert.equal(last.redirect_uri, `${config.baseUrl}/auth/google/callback`);

  // Later logins match the Google account id even if the Google e-mail changed.
  const r2 = await googleLogin(client(), { email: 'new-address@gmail.com', sub: 'sub-linked' });
  assert.equal(r2.location, '/calendar');
});

test('the "next" page is kept through the Google round trip', async () => {
  createUser({ email: 'next@test.org' });
  const r = await googleLogin(client(), { email: 'next@test.org', sub: 'sub-next' }, { next: '/me/bookings' });
  assert.equal(r.location, '/me/bookings');
  const evil = await googleLogin(client(), { email: 'next@test.org', sub: 'sub-next' }, { next: '//evil.example' });
  assert.equal(evil.location, '/calendar');
});

test('new person: Google pre-fills registration, e-mail is locked to the Google one', async () => {
  const c = client();
  const r = await googleLogin(c, { email: 'newbie@gmail.com', given_name: 'נגה', family_name: 'גוגל', sub: 'sub-newbie' });
  assert.equal(r.location, '/register');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'newbie@gmail.com'").get().n, 0, 'no account yet');
  const page = (await c.get('/register')).text;
  assert.match(page, /מתחברים עם חשבון Google <b>newbie@gmail.com<\/b>/);
  assert.match(page, /value="נגה"/);
  assert.match(page, /value="newbie@gmail.com" readonly/);

  const reg = await c.post('/register', registrationForm({ email: 'attacker@evil.example', first_name: 'נגה', last_name: 'גוגל', password: null }));
  assert.equal(reg.status, 302);
  const u = db.prepare("SELECT * FROM users WHERE google_sub = 'sub-newbie'").get();
  assert.equal(u.email, 'newbie@gmail.com', 'posted e-mail is ignored');
  assert.equal(u.status, 'pending');
  assert.equal(u.password_hash, null);
  assert.ok(!db.prepare("SELECT 1 FROM users WHERE email = 'attacker@evil.example'").get());
  assert.equal(c.cookies.gsignup, undefined, 'signup cookie cleared');

  const again = await googleLogin(client(), { email: 'newbie@gmail.com', sub: 'sub-newbie' });
  assert.equal(again.location, '/me', 'pending users land on their status page');
});

test('the pre-filled registration needs the Google cookie; it cannot be reused by others', async () => {
  const c = client();
  await googleLogin(c, { email: 'cookie@gmail.com', sub: 'sub-cookie' });
  const other = client();
  assert.doesNotMatch((await other.get('/register')).text, /cookie@gmail.com/);
  other.cookies.gsignup = 'forged-token';
  assert.doesNotMatch((await other.get('/register')).text, /מתחברים עם חשבון Google/);
});

test('admins with two-factor auth still need their code after Google', async () => {
  const a = createUser({ role: 'admin', email: 'totp-admin@test.org' });
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?').run(auth.newTotpSecret(), a.id);
  const c = client();
  const r = await googleLogin(c, { email: 'totp-admin@test.org' });
  assert.equal(r.location, '/login/2fa');
  assert.equal((await c.get('/admin')).location, '/login/2fa');
});

test('rejected responses never log anyone in', async () => {
  createUser({ email: 'victim@test.org' });
  const cases = {
    'wrong audience': { aud: 'someone-else.apps.googleusercontent.com' },
    'wrong issuer': { iss: 'https://evil.example' },
    'expired token': { exp: Math.floor(Date.now() / 1000) - 10 },
    'nonce mismatch': { nonce: 'replayed' },
    'unverified e-mail': { email_verified: false },
    'missing e-mail': { email: undefined },
  };
  for (const [name, claims] of Object.entries(cases)) {
    const c = client();
    const r = await googleLogin(c, { email: 'victim@test.org', ...claims });
    assert.equal(r.location, '/login', name);
    assert.match(c.flash().text, /Google/, name);
    assert.equal((await c.get('/me')).status, 302, `${name}: not logged in`);
  }
  assert.equal(db.prepare("SELECT google_sub FROM users WHERE email = 'victim@test.org'").get().google_sub, null);
});

test('state must match the browser cookie and is single-use', async () => {
  createUser({ email: 'state@test.org' });
  const c = client();
  const r = await googleLogin(c, { email: 'state@test.org' }, { tamper: { state: 'forged' } });
  assert.equal(r.location, '/login');
  assert.equal((await c.get('/me')).status, 302);

  // Replaying a callback URL that was already used fails.
  const c2 = client();
  const start = await c2.get('/auth/google');
  const url = new URL(start.location);
  const code = 'replay-code';
  const entry = { challenge: url.searchParams.get('code_challenge'), claims: {
    iss: 'accounts.google.com', aud: config.google.clientId, exp: Math.floor(Date.now() / 1000) + 600,
    nonce: url.searchParams.get('nonce'), email_verified: 'true', email: 'state@test.org', sub: 'sub-state' } };
  codes.set(code, entry);
  const cookie = c2.cookies.gstate;
  const ok = await c2.get(`/auth/google/callback?code=${code}&state=${url.searchParams.get('state')}`);
  assert.equal(ok.location, '/calendar');
  const c3 = client();
  c3.cookies.gstate = cookie;
  codes.set(code, entry);
  const replay = await c3.get(`/auth/google/callback?code=${code}&state=${url.searchParams.get('state')}`);
  assert.equal(replay.location, '/login');
});

test('user cancelling at Google, and token endpoint errors, are handled', async () => {
  const c = client();
  await c.get('/auth/google');
  const r = await c.get('/auth/google/callback?error=access_denied&state=x');
  assert.equal(r.location, '/login');
  assert.match(c.flash().text, /בוטלה/);
  const c2 = client();
  const e = await googleLogin(c2, {}, { status: 500 });
  assert.equal(e.location, '/login');
  assert.match(c2.flash().text, /פג תוקף הקוד מ־Google/);
});

test('an account already linked to another Google id is not taken over', async () => {
  const u = createUser({ email: 'owned@test.org' });
  db.prepare("UPDATE users SET google_sub = 'original-sub' WHERE id = ?").run(u.id);
  const c = client();
  const r = await googleLogin(c, { email: 'owned@test.org', sub: 'other-sub' });
  assert.equal(r.location, '/login');
  assert.match(c.flash().text, /מקושר לחשבון Google אחר/);
});

test('security page shows the Google link', async () => {
  createUser({ email: 'sec-page@test.org' });
  const c = client();
  await googleLogin(c, { email: 'sec-page@test.org' });
  assert.match((await c.get('/me/security')).text, /חשבון Google/);
});

test('without Google credentials the option is hidden and the route is off', async () => {
  const saved = config.google.clientId;
  config.google.clientId = '';
  try {
    assert.doesNotMatch((await client().get('/login')).text, /auth\/google/);
    assert.equal((await client().get('/auth/google')).status, 404);
  } finally {
    config.google.clientId = saved;
  }
});

test('on an address other than BASE_URL the button is replaced by a link to the right address', async () => {
  const saved = config.baseUrl;
  config.baseUrl = 'https://car.example.org';
  try {
    const page = (await client().get('/login')).text;
    assert.doesNotMatch(page, /href="\/auth\/google/);
    assert.match(page, /ההתחברות עם Google זמינה בכתובת <a href="https:\/\/car.example.org\/login">/);
    // Following an old link is sent once to the right address (no redirect loop).
    const r = await client().get('/auth/google?next=/me');
    assert.equal(r.location, 'https://car.example.org/auth/google?next=%2Fme&moved=1');
    const again = await client().get('/auth/google?next=/me&moved=1');
    assert.match(again.location, /^https:\/\/accounts\.google\.com\//);
  } finally {
    config.baseUrl = saved;
  }
});

test('specific, actionable error messages; the admin settings page shows status and the last error', async () => {
  const a = createUser({ role: 'admin', email: 'g-admin@test.org' });
  const adminClient = client();
  await adminClient.login(a.email);
  let page = (await adminClient.get('/admin/settings')).text;
  assert.match(page, /id="google"/);
  assert.match(page, /מופעלת/);
  assert.match(page, new RegExp(`<code>${srv.base}/auth/google/callback</code>`), 'exact redirect URI to register');

  // Wrong client secret at Google → invalid_client
  const c = client();
  const start = await c.get('/auth/google');
  const url = new URL(start.location);
  codes.set('bad-secret', { status: 401, error: 'invalid_client' });
  await c.get(`/auth/google/callback?code=bad-secret&state=${url.searchParams.get('state')}`);
  assert.match(c.flash().text, /הגדרות Google שגויות/);

  // Missing state cookie (login started on another address)
  const c2 = client();
  const s2 = new URL((await c2.get('/auth/google')).location).searchParams.get('state');
  delete c2.cookies.gstate;
  await c2.get(`/auth/google/callback?code=x&state=${s2}`);
  assert.match(c2.flash().text, /בכתובת אחרת/);

  page = (await adminClient.get('/admin/settings')).text;
  assert.match(page, /שגיאה אחרונה/);
  assert.match(page, /state cookie missing/);
});

test('Google unreachable shows a message instead of an error page', async () => {
  const saved = config.google.tokenUrl;
  config.google.tokenUrl = 'http://127.0.0.1:9/token'; // nothing listens on port 9
  try {
    const c = client();
    const r = await googleLogin(c, { email: 'x@test.org' });
    assert.equal(r.status, 302);
    assert.equal(r.location, '/login');
    assert.match(c.flash().text, /לא ניתן להתחבר לשרתי Google/);
  } finally {
    config.google.tokenUrl = saved;
  }
});

test('admin settings explain what is missing when Google is not configured', async () => {
  const a = createUser({ role: 'admin', email: 'g-admin2@test.org' });
  const ac = client();
  await ac.login(a.email);
  const saved = config.google.clientSecret;
  config.google.clientSecret = '';
  try {
    const page = (await ac.get('/admin/settings')).text;
    assert.match(page, /לא מופעלת/);
    assert.match(page, /❌ <code>GOOGLE_CLIENT_SECRET<\/code>/);
    assert.match(page, /✅ <code>GOOGLE_CLIENT_ID<\/code>/);
  } finally {
    config.google.clientSecret = saved;
  }
});
