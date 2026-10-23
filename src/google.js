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

/** A failed Google login. `reason` is shown to the user; `message` has the technical detail for logs/admins. */
class GoogleAuthError extends Error {
  constructor(message, reason = 'ההתחברות עם Google נכשלה. נסו שוב.') {
    super(message);
    this.reason = reason;
  }
}

const REASONS = {
  state: 'פג תוקף ההתחברות, או שהיא התחילה בכתובת אחרת של האתר. נסו שוב.',
  invalid_client: 'הגדרות Google שגויות (Client ID או Client secret). יש לפנות למנהל המערכת.',
  redirect_uri_mismatch: 'כתובת החזרה אינה רשומה ב־Google. יש לפנות למנהל המערכת.',
  invalid_grant: 'פג תוקף הקוד מ־Google. נסו שוב.',
  network: 'לא ניתן להתחבר לשרתי Google כרגע. בדקו את חיבור האינטרנט ונסו שוב.',
  unverified: 'כתובת הדואר האלקטרוני בחשבון Google לא אומתה.',
};

// Last failure, shown to admins on the settings page to help with setup.
let lastError = null;
function recordError(err) {
  lastError = { at: new Date(), message: err.message };
}

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
  if (!state || !cookieState || state !== cookieState) {
    throw new GoogleAuthError(cookieState ? 'state mismatch' : 'state cookie missing (login started on a different address than BASE_URL?)', REASONS.state);
  }
  const row = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state);
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state); // single use
  if (!row || row.expires_at < Date.now()) throw new GoogleAuthError('unknown or expired state', REASONS.state);
  if (!code) throw new GoogleAuthError('missing code');

  let res;
  try {
    res = await fetch(config.google.tokenUrl, {
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
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new GoogleAuthError(`cannot reach ${config.google.tokenUrl}: ${err.cause?.code || err.message}`, REASONS.network);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = [body.error, body.error_description].filter(Boolean).join(': ');
    throw new GoogleAuthError(`token endpoint ${res.status} ${detail}`.trim(), REASONS[body.error]);
  }

  const claims = decodeJwtPayload(body.id_token);
  if (!ISSUERS.has(claims.iss)) throw new GoogleAuthError('wrong issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.google.clientId)) throw new GoogleAuthError('wrong audience');
  if (!(claims.exp * 1000 > Date.now())) throw new GoogleAuthError('expired token');
  if (claims.nonce !== row.nonce) throw new GoogleAuthError('nonce mismatch');
  if (!claims.sub || !claims.email) throw new GoogleAuthError('missing claims');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new GoogleAuthError('email not verified', REASONS.unverified);

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

/** Setup diagnostics for the admin settings page. */
function status() {
  return {
    clientIdSet: Boolean(config.google.clientId),
    secretSet: Boolean(config.google.clientSecret),
    clientIdLooksRight: /\.apps\.googleusercontent\.com$/.test(config.google.clientId),
    enabled: enabled(),
    redirectUri: redirectUri(),
    origin: new URL(config.baseUrl).origin,
    lastError,
  };
}

/** Is this request on the BASE_URL address (the only one Google will send the user back to)? */
const onPublicHost = (req) =>
  `${req.protocol}://${req.get('x-forwarded-host') || req.get('host')}` === new URL(config.baseUrl).origin;

module.exports = {
  enabled, redirectUri, begin, complete, rememberSignup, pendingSignup, clearSignup, GoogleAuthError,
  recordError, status, onPublicHost,
};
