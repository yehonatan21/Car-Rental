'use strict';
const os = require('node:os');
const path = require('node:path');

// All date math in the app assumes Israel local time.
process.env.TZ = process.env.TZ || 'Asia/Jerusalem';

// Vercel (serverless): the code directory is read-only and only os.tmpdir() is writable. It is wiped whenever
// an instance is recycled, so data there is temporary (see `ephemeral` below and docs/vercel.md).
const onVercel = Boolean(process.env.VERCEL);
const dataDir = path.resolve(process.env.DATA_DIR
  || (onVercel ? path.join(os.tmpdir(), 'car-rental') : path.join(__dirname, '..', 'data')));
const production = process.env.NODE_ENV === 'production';
const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
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

module.exports = {
  port,
  baseUrl: (process.env.BASE_URL || (onVercel && vercelUrl ? `https://${vercelUrl}` : `${httpsEnabled ? 'https' : 'http'}://localhost:${port}`))
    .replace(/\/$/, ''),
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
  // Data does not survive restarts (Vercel without DATA_DIR pointing at persistent storage): warn on every page.
  ephemeral: onVercel && !process.env.DATA_DIR,
  dbFile: process.env.DB_FILE || path.join(dataDir, 'app.db'),
  // Private storage for license images: outside any static folder, served only through an admin-checked route.
  uploadsDir: path.join(dataDir, 'licenses'),
  outboxDir: path.join(dataDir, 'outbox'),
  appName: process.env.APP_NAME || 'הזמנת רכב',
  smtp: process.env.SMTP_HOST ? smtpConfig() : null,
  mailFrom: process.env.MAIL_FROM || 'car-booking@localhost',
  // "Sign in with Google" is shown only when both are set (Google Cloud Console → APIs & Services → Credentials).
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    authUrl: process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  },
  sessionDays: 14,
};
