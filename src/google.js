'use strict';
// "Sign in with Google": OAuth 2.0 authorization-code flow with PKCE, state and nonce (OpenID Connect).
// The ID token comes straight from Google's token endpoint over HTTPS, authenticated with our client secret,
// so its claims are trusted after checking issuer, audience, expiry, nonce and e-mail verification
// (as recommended in Google's "OpenID Connect" server-flow documentation).
const crypto = require('node:crypto');
const config = require('./config');
const { db } = require('./db');

const STATE_TTL_MS = 10 * 60000;
const SIGNUP_TTL_MS = 30 * 60000;
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

class GoogleAuthError extends Error {}

const enabled = () => Boolean(config.google.clientId && config.google.clientSecret);
const redirectUri = () => `${config.baseUrl}/auth/google/callback`;
const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

/** Starts a login: remembers state/nonce/PKCE verifier and returns Google's consent URL. */
function begin(next) {
  const state = random();
  const nonce = random();
  const verifier = random(48);
  db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO oauth_states (state, verifier, nonce, next, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(state, verifier, nonce, next || null, Date.now() + STATE_TTL_MS);
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: sha256(verifier).toString('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return { state, url: `${config.google.authUrl}?${params}` };
}

function decodeJwtPayload(token) {
  const part = String(token || '').split('.')[1];
  if (!part) throw new GoogleAuthError('missing id_token');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/** Completes a login: validates state, exchanges the code and returns the verified Google profile. */
async function complete({ code, state, cookieState }) {
  if (!state || !cookieState || state !== cookieState) throw new GoogleAuthError('state mismatch');
  const row = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state);
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state); // single use
  if (!row || row.expires_at < Date.now()) throw new GoogleAuthError('unknown or expired state');
  if (!code) throw new GoogleAuthError('missing code');

  const res = await fetch(config.google.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
      code_verifier: row.verifier,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleAuthError(`token endpoint ${res.status}: ${body.error || ''}`);

  const claims = decodeJwtPayload(body.id_token);
  if (!ISSUERS.has(claims.iss)) throw new GoogleAuthError('wrong issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.google.clientId)) throw new GoogleAuthError('wrong audience');
  if (!(claims.exp * 1000 > Date.now())) throw new GoogleAuthError('expired token');
  if (claims.nonce !== row.nonce) throw new GoogleAuthError('nonce mismatch');
  if (!claims.sub || !claims.email) throw new GoogleAuthError('missing claims');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new GoogleAuthError('email not verified');

  return {
    sub: String(claims.sub),
    email: String(claims.email).toLowerCase(),
    firstName: claims.given_name || '',
    lastName: claims.family_name || '',
    next: row.next,
  };
}

/** Keeps a Google profile that has no account yet; the token goes in a cookie for the registration form. */
function rememberSignup(profile) {
  const token = random();
  db.prepare('DELETE FROM google_signups WHERE expires_at < ? OR sub = ?').run(Date.now(), profile.sub);
  db.prepare('INSERT INTO google_signups (token_hash, sub, email, first_name, last_name, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256(token).toString('hex'), profile.sub, profile.email, profile.firstName, profile.lastName, Date.now() + SIGNUP_TTL_MS);
  return token;
}

function pendingSignup(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM google_signups WHERE token_hash = ?').get(sha256(token).toString('hex'));
  return row && row.expires_at > Date.now() ? row : null;
}

function clearSignup(token) {
  if (token) db.prepare('DELETE FROM google_signups WHERE token_hash = ?').run(sha256(token).toString('hex'));
}

module.exports = { enabled, redirectUri, begin, complete, rememberSignup, pendingSignup, clearSignup, GoogleAuthError };
