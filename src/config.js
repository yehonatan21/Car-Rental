'use strict';
const os = require('node:os');
const path = require('node:path');

// All date math in the app assumes Israel local time. Set unconditionally: hosts such as Vercel (AWS Lambda) set
// TZ=:UTC themselves, which would shift every booking time and "now" check by two or three hours.
// APP_TIMEZONE overrides it for a deployment in another country.
process.env.TZ = process.env.APP_TIMEZONE || 'Asia/Jerusalem';

// Vercel (serverless): the code directory is read-only and only os.tmpdir() is writable. It is wiped whenever
// an instance is recycled, so data there is temporary (see `ephemeral` below and docs/vercel.md).
const onVercel = Boolean(process.env.VERCEL);
const dataDir = path.resolve(process.env.DATA_DIR
  || (onVercel ? path.join(os.tmpdir(), 'car-rental') : path.join(__dirname, '..', 'data')));
const production = process.env.NODE_ENV === 'production';
// The address people use: production deployments use the production domain; preview deployments (e.g. the dev
// branch) their stable branch address (car-rental-git-dev-<team>.vercel.app), so links and Google sign-in stay on dev.
const vercelUrl = process.env.VERCEL_ENV === 'preview'
  ? process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL
  : process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
const port = Number(process.env.PORT || 3000);
// Serve TLS from Node itself? Default: yes in development, no in production (a TLS proxy such as Caddy sits in front).
const httpsEnabled = process.env.HTTPS ? process.env.HTTPS === 'true' : !production;

function smtpConfig() {
  const host = process.env.SMTP_HOST.trim();
  const port = Number(process.env.SMTP_PORT || 587);
  let pass = process.env.SMTP_PASS;
  // Gmail shows app passwords as "abcd efgh ijkl mnop"; the spaces are not part of the password.
  if (pass && /(^|\.)(gmail|googlemail)\.com$/i.test(host)) pass = pass.replace(/\s+/g, '');
  return {
    host,
    port,
    // Port 465 always means TLS from the first byte; 587/25 upgrade with STARTTLS.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER.trim(), pass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  };
}

/** An environment value as people paste it into a dashboard: surrounding spaces and quotes removed. */
const clean = (v) => String(v ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();

/**
 * An address from an environment variable: cleaned, with the scheme added when it was left out
 * ("car-rental.vercel.app" → "https://car-rental.vercel.app"). A value that is still not an address stops the app
 * with a message naming the variable, instead of a bare "Invalid URL".
 */
function urlFromEnv(name, scheme) {
  let v = clean(process.env[name]);
  if (!v) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `${scheme}://${v}`;
  try {
    if (!new URL(v).hostname) throw new Error('no host');
  } catch {
    throw new Error(`${name} is not a valid address: "${clean(process.env[name])}". Use the full address, for example ${
      scheme === 'https' ? 'https://car-rental.vercel.app' : 'libsql://car-rental-<org>.turso.io'}.`);
  }
  return v.replace(/\/+$/, '');
}

/**
 * Which environment variables hold the hosted database (Turso/libSQL). Besides the standard names, the Vercel Turso
 * integration can add them under a custom prefix (e.g. STORAGE_TURSO_DATABASE_URL + STORAGE_TURSO_AUTH_TOKEN).
 */
function databaseEnv() {
  for (const [url, token] of [['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'], ['LIBSQL_URL', 'LIBSQL_AUTH_TOKEN']]) {
    if (clean(process.env[url])) return { url, token };
  }
  const url = Object.keys(process.env).sort()
    .find((k) => /_DATABASE_URL$/.test(k) && /^libsql:\/\/|\.turso\.io\b/i.test(clean(process.env[k])));
  return url ? { url, token: url.replace(/DATABASE_URL$/, 'AUTH_TOKEN') } : null;
}
const dbEnv = databaseEnv();
const database = {
  // Cleaned: values pasted into a hosting dashboard often carry spaces, a newline or quotes. A URL without its scheme
  // would otherwise be taken as a local file name, silently using a throwaway database.
  url: dbEnv ? urlFromEnv(dbEnv.url, 'libsql') : '',
  authToken: dbEnv ? clean(process.env[dbEnv.token]).replace(/^Bearer\s+/i, '') : '',
  from: dbEnv?.url || null,
};
// On Vercel the disk is temporary and separate for every instance: without a hosted database, accounts and logins
// would exist on one instance and not the next (redirect loops) and everything would vanish on each new version.
// So the app refuses to start there, unless a throwaway demo is wanted on purpose.
const temporaryData = onVercel && !process.env.DATA_DIR && !database.url;
const allowTemporaryData = clean(process.env.ALLOW_TEMPORARY_DATA) === 'true';

// Sender address. Most SMTP providers (Gmail, Outlook, SendGrid…) refuse or spam-flag mail "from" an address the
// account does not own, so without MAIL_FROM the SMTP login (when it is an e-mail address) is used.
function mailFrom() {
  if (process.env.MAIL_FROM) return process.env.MAIL_FROM.trim();
  const user = (process.env.SMTP_USER || '').trim();
  return process.env.SMTP_HOST && user.includes('@') ? user : 'car-booking@localhost';
}

module.exports = {
  port,
  baseUrl: urlFromEnv('BASE_URL', 'https')
    || (onVercel && vercelUrl ? `https://${vercelUrl}` : `${httpsEnabled ? 'https' : 'http'}://localhost:${port}`),
  production,
  https: {
    enabled: httpsEnabled,
    certFile: process.env.HTTPS_CERT_FILE || null,
    keyFile: process.env.HTTPS_KEY_FILE || null,
  },
  // In production, plain-HTTP requests (not forwarded as https by the proxy) are redirected to https.
  forceHttps: production && process.env.FORCE_HTTPS !== 'false',
  dataDir,
  onVercel,
  // Vercel Web Analytics (page views, no cookies): on by default on Vercel; enable it in the Vercel dashboard
  // (project → Analytics → Enable). VERCEL_ANALYTICS=false turns the script off.
  vercelAnalytics: onVercel && process.env.VERCEL_ANALYTICS !== 'false',
  // Data does not survive restarts (Vercel without DATA_DIR pointing at persistent storage): warn on every page.
  ephemeral: temporaryData,
  // Set when the app must not start: Vercel without a hosted database (and no ALLOW_TEMPORARY_DATA=true).
  missingDatabase: temporaryData && !allowTemporaryData,
  // Hosted libSQL / Turso database (data survives redeploys). Names match Vercel's Turso integration.
  database,
  dbFile: process.env.DB_FILE || path.join(dataDir, 'app.db'),
  // Private storage for license images: outside any static folder, served only through an admin-checked route.
  uploadsDir: path.join(dataDir, 'licenses'),
  outboxDir: path.join(dataDir, 'outbox'),
  appName: process.env.APP_NAME || 'הזמנת רכב',
  smtp: process.env.SMTP_HOST ? smtpConfig() : null,
  // Largest license upload. Vercel refuses request bodies over 4.5 MB before they reach the app, so stay below it.
  uploadMaxBytes: (onVercel ? 4 : 8) * 1024 * 1024,
  mailFrom: mailFrom(),
  // "Sign in with Google" is shown only when both are set (Google Cloud Console → APIs & Services → Credentials).
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    authUrl: process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  },
  sessionDays: 14,
};
