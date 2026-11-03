'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const config = require('./config');
const { db, storageInfo } = require('./db');
const auth = require('./auth');
const { layout, html, uploadLimitLabel } = require('./views/html');
const { BookingError } = require('./bookings');
const { startJobs, runJobs } = require('./jobs');
const { listenHttps, lanAddresses } = require('./tls');

// HSTS applies to a whole host name (all ports), so it is never sent for localhost or raw IP addresses:
// pinning them would force every other local/LAN dev server on that host onto HTTPS.
const pinnable = (hostname) => hostname !== 'localhost' && !net.isIP(hostname.replace(/^\[|\]$/g, ''));

require('./bootstrap').ensureAdminFromEnv();

const app = express();
app.set('trust proxy', 1); // in production HTTPS is terminated by the reverse proxy, which sets X-Forwarded-Proto
app.disable('x-powered-by');

// HTTPS only: redirect plain-HTTP requests that reach the app behind a proxy in production.
app.use((req, res, next) => {
  if (!config.forceHttps || req.secure || req.path === '/healthz') return next();
  res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
});

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  });
  if (req.secure && pinnable(req.hostname)) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});

app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
// Browsers ask for /favicon.ico on their own (e.g. when showing a PDF); the tab icon is an SVG.
app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/favicon.svg'));

// Liveness/readiness probe for Docker, CI smoke tests and the hosting platform.
// Also says which code version is running and where the data is kept (no secrets), e.g. to check after a new
// deployment that it still uses the same database (storage.id unchanged).
app.get('/healthz', (req, res) => {
  db.prepare('SELECT 1').get();
  const s = storageInfo();
  res.set('Cache-Control', 'no-store').json({
    status: 'ok', env: process.env.APP_ENV || process.env.NODE_ENV || 'development',
    version: { commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null, branch: process.env.VERCEL_GIT_COMMIT_REF || null,
      environment: process.env.VERCEL_ENV || null },
    storage: { kind: s.kind, id: s.id, createdAt: s.createdAt },
  });
});

// Scheduled jobs (reminders, license expiry, closing finished bookings). A normal server runs them on a timer
// (start() → startJobs). Serverless platforms only run code during requests, so there they run:
//   - from Vercel Cron, which calls /internal/cron with "Authorization: Bearer $CRON_SECRET" (see vercel.json), and
//   - at most every 15 minutes while the site is being used.
app.get('/internal/cron', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.get('authorization') !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });
  await runJobs();
  res.json({ status: 'ok' });
});
if (config.onVercel) {
  let lastJobsRun = 0;
  app.use(async (req, res, next) => {
    if (Date.now() - lastJobsRun > 15 * 60000) {
      lastJobsRun = Date.now();
      await runJobs().catch((err) => console.error('[jobs]', err));
    }
    next();
  });
}

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
      // Admin rights require an active account: a blocked/suspended admin is treated as a regular user everywhere.
      const effective = user.role === 'admin' && user.status !== 'active' ? { ...user, role: 'user' } : user;
      if (!session.needs_2fa) req.user = effective;
      else req.pendingUser = user;
    }
  }
  if (req.cookies.flash) {
    try { req.flash = JSON.parse(Buffer.from(req.cookies.flash, 'base64url').toString()); } catch { /* ignore */ }
    res.clearCookie('flash', { path: '/' });
  }
  res.flash = (type, text) => res.cookie('flash', Buffer.from(JSON.stringify({ type, text })).toString('base64url'),
    { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
  res.page = (title, body) => {
    // Signed-in pages carry personal data and forms bound to this session: never keep a copy (shared computers,
    // and the Back button would otherwise show a stale form whose token no longer works).
    if ((req.user || req.pendingUser) && !res.get('Cache-Control')) res.set('Cache-Control', 'no-store');
    return res.send(layout(req, title, body));
  };
  next();
});

const PUBLIC_ORIGIN = new URL(config.baseUrl).origin;

// Forms anyone may submit (signing in, registering, password reset) are protected by the Origin check alone: they
// are often rendered before any session exists (a login page left open while signing in on another tab), so they
// cannot carry a session's token.
const PUBLIC_POSTS = new Set(['/login', '/login/code', '/login/code/verify', '/register', '/password/forgot', '/password/reset']);

/** A path on this same site taken from the Referer header, or null. */
function sameSiteReferer(req) {
  try {
    const u = new URL(req.get('referer') || '');
    return u.host === req.get('host') ? u.pathname + u.search : null;
  } catch {
    return null;
  }
}

// CSRF: every POST must come from our own origin; logged-in POSTs must also carry the session token.
function verifyCsrf(req, res, next) {
  const origin = req.get('origin');
  // Our own origin as this request sees it, or the configured public URL (a tunnel/proxy may rewrite Host).
  if (origin && origin !== `${req.protocol}://${req.get('host')}` && origin !== PUBLIC_ORIGIN) return res.status(403).send('Forbidden');
  if (req.session && !PUBLIC_POSTS.has(req.path)) {
    const token = String(req.body?._csrf || '');
    const ok = token.length === req.session.csrf.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrf));
    if (!ok) {
      // A form from an older page: the person signed in again (another tab, after a new deployment) or the page came
      // back from the browser history. Nothing is done; the page is reloaded with a fresh token and a short message.
      if (req.file) fs.rmSync(req.file.path, { force: true });
      res.flash('warning', 'הדף היה ישן (למשל אחרי התחברות מחדש בלשונית אחרת), ולכן הפעולה לא בוצעה. הדף רוענן – נסו שוב.');
      return res.redirect(303, sameSiteReferer(req) || '/');
    }
  }
  next();
}
app.use((req, res, next) => {
  if (req.method !== 'POST' || req.is('multipart/form-data')) return next(); // multipart routes verify after parsing
  verifyCsrf(req, res, next);
});

// Private license uploads: random file names, images or PDF only, up to config.uploadMaxBytes.
const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'application/pdf': '.pdf' };
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadsDir,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + ALLOWED[file.mimetype]),
  }),
  limits: { fileSize: config.uploadMaxBytes, files: 1 },
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
  // A blocked/suspended admin keeps role=admin in the database but loses all admin access.
  if (req.user.role !== 'admin' || req.user.status !== 'active') {
    return res.status(403).page('אין הרשאה', html`<h1>אין הרשאה לעמוד זה</h1>`);
  }
  next();
};

const ctx = { app, requireLogin, requireAdmin, licenseUpload };
require('./routes/public')(ctx);
require('./routes/user')(ctx);
require('./routes/admin')(ctx);

// An unknown address (an old link, a typo) goes to the main page, which sends signed-in people on to their own home
// page. Files (images, styles, scripts) and form posts keep a plain 404, so a missing file never gets a whole page.
app.use((req, res) => {
  const isPage = req.method === 'GET' && !req.path.startsWith('/static/') && !/\.[a-z0-9]{1,5}$/i.test(req.path) && req.accepts('html');
  if (isPage) return res.redirect('/');
  res.status(404).type('text/plain').send('Not found');
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    res.flash('error', err.code === 'LIMIT_FILE_SIZE' ? `הקובץ גדול מדי (עד ${uploadLimitLabel()})` : 'שגיאה בהעלאת הקובץ');
    return res.redirect(req.get('referer') || '/');
  }
  console.error(err);
  res.status(500).page('שגיאה', html`<h1>אירעה שגיאה</h1><p>נסו שוב מאוחר יותר.</p>`);
});

/** Starts the web server (HTTPS or plain HTTP, see config.https) and the background jobs. */
async function start({ port = config.port, host, jobs = true } = {}) {
  const server = config.https.enabled
    ? await listenHttps(app, port, host)
    : await new Promise((resolve, reject) => { const s = app.listen(port, host, () => resolve(s)).once('error', reject); });
  const scheme = config.https.enabled ? 'https' : 'http';
  const p = server.address().port;
  const lines = [`${config.appName} is running`, `  Local:      ${scheme}://localhost:${p}`];
  if (!host || host === '0.0.0.0' || host === '::') {
    for (const ip of lanAddresses()) lines.push(`  Network:    ${scheme}://${ip}:${p}   (other devices on the same Wi-Fi)`);
  }
  lines.push(`  Public URL: ${config.baseUrl}   (BASE_URL, used in e-mail links)`);
  console.log(lines.join('\n'));
  if (jobs) {
    require('./mail').verifyTransport();
    startJobs();
  }
  return server;
}

module.exports = { app, start, BookingError };

if (require.main === module) {
  // A stray error from a background task (for example a mail server dropping the connection mid-send) must not
  // take the whole site down: log it loudly and keep serving. Requests have their own error handler above.
  process.on('uncaughtException', (err) => console.error('[error] Unexpected error; the server keeps running:', err));
  process.on('unhandledRejection', (err) => console.error('[error] Unhandled rejection; the server keeps running:', err));
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
