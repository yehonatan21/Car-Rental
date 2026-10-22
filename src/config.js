'use strict';
const path = require('node:path');

// All date math in the app assumes Israel local time.
process.env.TZ = process.env.TZ || 'Asia/Jerusalem';

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3000);
// Serve TLS from Node itself? Default: yes in development, no in production (a TLS proxy such as Caddy sits in front).
const httpsEnabled = process.env.HTTPS ? process.env.HTTPS === 'true' : !production;

module.exports = {
  port,
  baseUrl: (process.env.BASE_URL || `${httpsEnabled ? 'https' : 'http'}://localhost:${port}`).replace(/\/$/, ''),
  production,
  https: {
    enabled: httpsEnabled,
    certFile: process.env.HTTPS_CERT_FILE || null,
    keyFile: process.env.HTTPS_KEY_FILE || null,
  },
  // In production, plain-HTTP requests (not forwarded as https by the proxy) are redirected to https.
  forceHttps: production && process.env.FORCE_HTTPS !== 'false',
  dataDir,
  dbFile: process.env.DB_FILE || path.join(dataDir, 'app.db'),
  // Private storage for license images: outside any static folder, served only through an admin-checked route.
  uploadsDir: path.join(dataDir, 'licenses'),
  outboxDir: path.join(dataDir, 'outbox'),
  appName: process.env.APP_NAME || 'הזמנת רכב',
  smtp: process.env.SMTP_HOST ? {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  } : null,
  mailFrom: process.env.MAIL_FROM || 'car-booking@localhost',
  sessionDays: 14,
};
