'use strict';
const path = require('node:path');

// All date math in the app assumes Israel local time.
process.env.TZ = process.env.TZ || 'Asia/Jerusalem';

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

module.exports = {
  port: Number(process.env.PORT || 3000),
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  production: process.env.NODE_ENV === 'production',
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
