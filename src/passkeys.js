'use strict';
// Passkeys (WebAuthn): a second factor that does not go through e-mail. A manager or console admin adds one on
// "סיסמה ואבטחה" (their phone's fingerprint or face, a computer's Windows Hello / Touch ID, or a security key). From
// then on every sign-in of that account (password, e-mailed code or Google) also needs the passkey, so neither a
// stolen password nor a taken-over mailbox is enough. The server keeps only the public key.
const crypto = require('node:crypto');
const {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { db, audit } = require('./db');
const config = require('./config');
const time = require('./time');

const TTL_MS = 5 * 60000;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** The site as the browser sees it: passkeys belong to a host name (rpID) and are checked against the page's origin. */
const site = (req) => ({ rpID: req.hostname, origin: `${req.protocol}://${req.get('host')}` });

const list = (userId) => db.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at').all(userId);
const has = (userId) => Boolean(userId) && Boolean(db.prepare('SELECT 1 FROM passkeys WHERE user_id = ? LIMIT 1').get(userId));

/** Keeps a challenge for `purpose` and returns the token that names it (the token goes back with the answer). */
function keepChallenge(userId, purpose, challenge, next = null) {
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO webauthn_challenges (token_hash, user_id, purpose, challenge, next, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256(token), userId, purpose, challenge, next, Date.now() + TTL_MS);
  return token;
}

/** The challenge of `token` for `purpose`, used up (single use), or null. */
function takeChallenge(token, purpose) {
  if (typeof token !== 'string' || !token) return null;
  const row = db.prepare('SELECT * FROM webauthn_challenges WHERE token_hash = ?').get(sha256(token));
  if (!row) return null;
  db.prepare('DELETE FROM webauthn_challenges WHERE token_hash = ?').run(sha256(token));
  return row.purpose === purpose && row.expires_at > Date.now() ? row : null;
}

/** Options for adding a passkey to `user` (a signed-in session). */
async function registrationOptions(req, user) {
  const options = await generateRegistrationOptions({
    rpName: require('./brand').brand().name || 'הזמנת רכב',
    rpID: site(req).rpID,
    userName: user.email,
    userDisplayName: `${user.first_name} ${user.last_name}`.trim() || user.email,
    userID: new TextEncoder().encode(`u${user.id}`),
    attestationType: 'none',
    excludeCredentials: list(user.id).map((p) => ({ id: p.id, transports: p.transports ? JSON.parse(p.transports) : undefined })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  return { token: keepChallenge(user.id, 'register', options.challenge), options };
}

/** Checks the browser's answer and saves the passkey. Returns the saved row, or throws with a message to show. */
async function register(req, user, token, credentialJson, name) {
  const ch = takeChallenge(token, 'register');
  if (!ch || ch.user_id !== user.id) throw new Error('הבקשה פגה. נסו שוב.');
  let credential;
  try { credential = JSON.parse(credentialJson); } catch { throw new Error('התשובה מהמכשיר אינה תקינה.'); }
  const { rpID, origin } = site(req);
  let v;
  try {
    v = await verifyRegistrationResponse({ response: credential, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
  } catch (err) {
    throw new Error(`המפתח לא נשמר: ${err.message}`, { cause: err });
  }
  if (!v.verified || !v.registrationInfo) throw new Error('המפתח לא אומת.');
  const c = v.registrationInfo.credential;
  const label = String(name || '').trim().slice(0, 60) || `מפתח גישה ${list(user.id).length + 1}`;
  db.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(c.id, user.id, Buffer.from(c.publicKey).toString('base64url'), c.counter || 0, c.transports ? JSON.stringify(c.transports) : null, label, time.stamp());
  audit(user.id, 'user.passkey_add', 'user', user.id, label);
  return db.prepare('SELECT * FROM passkeys WHERE id = ?').get(c.id);
}

/** Options for proving `user`'s passkey (signing in, or confirming before a sensitive action). */
async function authenticationOptions(req, user, purpose, next = null) {
  const options = await generateAuthenticationOptions({
    rpID: site(req).rpID,
    allowCredentials: list(user.id).map((p) => ({ id: p.id, transports: p.transports ? JSON.parse(p.transports) : undefined })),
    userVerification: 'preferred',
  });
  return { token: keepChallenge(user.id, purpose, options.challenge, next), options };
}

/** Checks a passkey answer for `purpose`. Returns { userId, next }, or throws with a message to show. */
async function authenticate(req, token, credentialJson, purpose) {
  const ch = takeChallenge(token, purpose);
  if (!ch) throw new Error('הבקשה פגה. נסו שוב.');
  let credential;
  try { credential = JSON.parse(credentialJson); } catch { throw new Error('התשובה מהמכשיר אינה תקינה.'); }
  const key = db.prepare('SELECT * FROM passkeys WHERE id = ? AND user_id = ?').get(String(credential?.id || ''), ch.user_id);
  if (!key) throw new Error('המפתח הזה אינו שייך לחשבון.');
  const { rpID, origin } = site(req);
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: credential, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false,
      credential: { id: key.id, publicKey: Buffer.from(key.public_key, 'base64url'), counter: key.counter, transports: key.transports ? JSON.parse(key.transports) : undefined },
    });
  } catch (err) {
    throw new Error(`האימות נכשל: ${err.message}`, { cause: err });
  }
  if (!v.verified) throw new Error('האימות נכשל.');
  db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(v.authenticationInfo.newCounter, time.stamp(), key.id);
  return { userId: ch.user_id, next: ch.next };
}

function remove(userId, id, actorId) {
  const p = db.prepare('SELECT * FROM passkeys WHERE id = ? AND user_id = ?').get(String(id), userId);
  if (!p) return false;
  db.prepare('DELETE FROM passkeys WHERE id = ?').run(p.id);
  audit(actorId, 'user.passkey_remove', 'user', userId, p.name);
  return true;
}

function removeAll(userId, actorId) {
  const n = db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(userId).changes;
  if (n) audit(actorId, 'user.passkey_remove_all', 'user', userId, `${n}`);
  return n;
}

/**
 * The console requires its admins to have a passkey (CONSOLE_PASSKEY=required, the default in production;
 * CONSOLE_PASSKEY=optional turns it off).
 */
const consoleRequires = () => {
  const v = String(process.env.CONSOLE_PASSKEY || '').trim();
  return v ? v === 'required' : config.production;
};

/**
 * Losing every passkey of the console's main admin: PASSKEY_RESET=<their e-mail> in the console's Vercel variables,
 * then a redeploy, removes them once (the value is remembered, so it is not repeated at every start).
 */
function resetFromEnv() {
  const email = String(process.env.PASSKEY_RESET || '').trim().toLowerCase();
  if (!email) return;
  const done = db.prepare("SELECT value FROM app_meta WHERE key = 'passkey_reset_done'").get()?.value;
  if (done === email) return;
  const u = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email);
  if (u) {
    const n = removeAll(u.id, null);
    console.warn(`[passkeys] PASSKEY_RESET: removed ${n} passkey(s) of ${email}. Remove PASSKEY_RESET from the variables.`);
  }
  db.prepare("INSERT INTO app_meta (key, value) VALUES ('passkey_reset_done', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(email);
}

module.exports = {
  has, list, registrationOptions, register, authenticationOptions, authenticate, remove, removeAll, consoleRequires, resetFromEnv,
};
