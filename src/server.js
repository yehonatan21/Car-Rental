'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const config = require('./config');
const { db } = require('./db');
const auth = require('./auth');
const { layout, html } = require('./views/html');
const { BookingError } = require('./bookings');
const { startJobs } = require('./jobs');

const app = express();
app.set('trust proxy', 1); // HTTPS is terminated at the reverse proxy / hosting platform
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  });
  if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});

app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

// Liveness/readiness probe for Docker, CI smoke tests and the hosting platform.
app.get('/healthz', (req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ status: 'ok', env: process.env.APP_ENV || process.env.NODE_ENV || 'development' });
});
app.use(express.urlencoded({ extended: false, limit: '200kb' }));

// Session, user and flash message loading.
app.use((req, res, next) => {
  req.cookies = auth.parseCookies(req.headers.cookie);
  const session = auth.loadSession(req);
  if (session) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
    if (user) {
      req.session = session;
      // A session waiting for the 2FA code is not yet logged in.
      if (!session.needs_2fa) req.user = user;
      else req.pendingUser = user;
    }
  }
  if (req.cookies.flash) {
    try { req.flash = JSON.parse(Buffer.from(req.cookies.flash, 'base64url').toString()); } catch { /* ignore */ }
    res.clearCookie('flash', { path: '/' });
  }
  res.flash = (type, text) => res.cookie('flash', Buffer.from(JSON.stringify({ type, text })).toString('base64url'),
    { httpOnly: true, sameSite: 'lax', secure: config.production, path: '/' });
  res.page = (title, body) => res.send(layout(req, title, body));
  next();
});

// CSRF: every POST must come from our own origin; logged-in POSTs must also carry the session token.
function verifyCsrf(req, res, next) {
  const origin = req.get('origin');
  if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).send('Forbidden');
  if (req.session) {
    const token = String(req.body?._csrf || '');
    const ok = token.length === req.session.csrf.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrf));
    if (!ok) return res.status(403).send('פג תוקף הטופס. יש לרענן את הדף ולנסות שוב.');
  }
  next();
}
app.use((req, res, next) => {
  if (req.method !== 'POST' || req.is('multipart/form-data')) return next(); // multipart routes verify after parsing
  verifyCsrf(req, res, next);
});

// Private license uploads: random file names, images or PDF only, 8MB max.
const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'application/pdf': '.pdf' };
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadsDir,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + ALLOWED[file.mimetype]),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, Boolean(ALLOWED[file.mimetype])),
});
const licenseUpload = [upload.single('license'), verifyCsrf];

const requireLogin = (req, res, next) => {
  if (req.user) return next();
  if (req.pendingUser) return res.redirect('/login/2fa');
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
};
const requireAdmin = (req, res, next) => {
  if (!req.user) return requireLogin(req, res, next);
  if (req.user.role !== 'admin') return res.status(403).page('אין הרשאה', html`<h1>אין הרשאה לעמוד זה</h1>`);
  next();
};

const ctx = { app, requireLogin, requireAdmin, licenseUpload };
require('./routes/public')(ctx);
require('./routes/user')(ctx);
require('./routes/admin')(ctx);

app.use((req, res) => res.status(404).page('לא נמצא', html`<h1>העמוד לא נמצא</h1><p><a href="/">חזרה לדף הבית</a></p>`));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    res.flash('error', err.code === 'LIMIT_FILE_SIZE' ? 'הקובץ גדול מדי (עד 8MB)' : 'שגיאה בהעלאת הקובץ');
    return res.redirect(req.get('referer') || '/');
  }
  console.error(err);
  res.status(500).page('שגיאה', html`<h1>אירעה שגיאה</h1><p>נסו שוב מאוחר יותר.</p>`);
});

module.exports = { app, BookingError };

if (require.main === module) {
  app.listen(config.port, () => console.log(`${config.appName} listening on ${config.baseUrl} (port ${config.port})`));
  startJobs();
}
