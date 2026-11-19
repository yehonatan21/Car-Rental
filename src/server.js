'use strict';
require('./quiet-warnings');
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
const { startJobs, runJobs, lastRun } = require('./jobs');
const { listenHttps, lanAddresses } = require('./tls');
const redirectGuard = require('./redirect-guard');

// Identifies this server process in log lines (Vercel runs several instances side by side).
const INSTANCE = crypto.randomBytes(3).toString('hex');

// HSTS applies to a whole host name (all ports), so it is never sent for localhost or raw IP addresses:
// pinning them would force every other local/LAN dev server on that host onto HTTPS.
const pinnable = (hostname) => hostname !== 'localhost' && !net.isIP(hostname.replace(/^\[|\]$/g, ''));

require('./bootstrap').ensureAdminFromEnv();

const app = express();
app.set('trust proxy', 1); // in production HTTPS is terminated by the reverse proxy, which sets X-Forwarded-Proto
app.disable('x-powered-by');

app.use(require('./timing').middleware); // Server-Timing header + a log line for slow requests

// HTTPS only: redirect plain-HTTP requests that reach the app behind a proxy in production.
app.use((req, res, next) => {
  if (!config.forceHttps || req.secure || req.path === '/healthz') return next();
  // To the configured address when there is one, not to whatever Host the request named (SEC-011).
  res.redirect(301, `https://${process.env.BASE_URL ? new URL(config.baseUrl).host : req.get('host')}${req.originalUrl}`);
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

// Liveness probe for the hosting platform, CI and the console.
// Also says which code version is running and where the data is kept (no secrets), e.g. to check after a new
// deployment that it still uses the same database (storage.id unchanged).
/** Compares two secrets in constant time (SEC-012). */
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

app.get('/healthz', (req, res) => {
  db.prepare('SELECT 1').get();
  // In production the details (version, where the data lives) only with the cron secret; anyone else gets "ok" (SEC-014).
  const secret = process.env.CRON_SECRET;
  if (config.production && !(secret && sameSecret(req.get('authorization') || '', `Bearer ${secret}`))) {
    return res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  }
  const s = storageInfo();
  res.set('Cache-Control', 'no-store').json({
    status: 'ok', env: process.env.APP_ENV || process.env.NODE_ENV || 'development',
    version: { commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null, branch: process.env.VERCEL_GIT_COMMIT_REF || null,
      environment: process.env.VERCEL_ENV || null },
    storage: { kind: s.kind, id: s.id, createdAt: s.createdAt, perDeployment: s.perDeployment },
  });
});

// Scheduled jobs (reminders, license expiry, closing finished bookings, retrying failed e-mails). A normal server runs
// them on a timer (start() → startJobs). On Vercel code only runs during requests, so there:
//   - a GitHub Actions schedule calls the console's /internal/cron every 10 minutes
//     (.github/workflows/jobs.yml), and the console runs the jobs of every client site (master.runAllJobs);
//   - Vercel Cron also calls /internal/cron once a day (vercel.json), as a backup;
//   - a visit runs them only when no scheduled run happened for 30 minutes (the schedule is broken).
app.get('/internal/cron', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || !sameSecret(req.get('authorization') || '', `Bearer ${secret}`)) return res.status(401).json({ error: 'unauthorized' });
  const own = await runJobs({ by: 'cron' });
  const sites = config.master || config.masterConsole ? await require('./master').runAllJobs() : undefined;
  if (sites) console.log(`[jobs] cron: ${sites.filter((s) => s.ok).length}/${sites.length} sites ran their jobs`);
  res.json({ status: 'ok', ...own, sites });
});
// A client's site suspended from the master console shows only a notice (routes/manage.js).
app.use(require('./routes/manage').suspendedGate);

if (config.onVercel) {
  let lastCheck = 0;
  app.use(async (req, res, next) => {
    if (Date.now() - lastCheck > 15 * 60000) { // at most one look every 15 minutes per server instance
      lastCheck = Date.now();
      try {
        const last = lastRun();
        const age = last ? Date.now() - new Date(last.at.replace(' ', 'T')).getTime() : Infinity;
        if (age > 30 * 60000) {
          console.warn(`[jobs] no scheduled run for ${last ? Math.round(age / 60000) + ' minutes' : 'ever'}: running them on this visit`);
          await runJobs({ by: 'visit' });
        }
      } catch (err) {
        console.error('[jobs]', err);
      }
    }
    next();
  });
}

app.use(express.urlencoded({ extended: false, limit: '200kb' }));

// Session, user and flash message loading.
app.use((req, res, next) => {
  req.cookies = auth.parseCookies(req.headers.cookie);
  const { state, session, user } = auth.loadSessionAndUser(req);
  req.sessionState = state;
  if (req.cookies[auth.COOKIE] && !user) {
    // Rare (after logging out elsewhere or a long absence): logged, so a login that is lost unexpectedly can be traced.
    console.warn(`[session] login cookie not recognised (${req.sessionState}) on ${req.method} ${req.path}; `
      + `deployment ${process.env.VERCEL_DEPLOYMENT_ID || '-'}, instance ${INSTANCE}`);
    // A login cookie this database does not know (expired, logged out elsewhere, or made by another deployment with
    // its own database): forget it. Otherwise pages served by two deployments at once during a new release could
    // send the browser back and forth between "/login" and the page forever (ERR_TOO_MANY_REDIRECTS).
    res.clearCookie(auth.COOKIE, { path: '/', secure: req.secure });
    delete req.cookies[auth.COOKIE];
  }
  if (session) {
    if (user) {
      req.session = session;
      // Admin rights require an active account: a blocked/suspended admin is treated as a regular user everywhere.
      req.user = user.role === 'admin' && user.status !== 'active' ? { ...user, role: 'user' } : user;
    }
  }
  if (req.cookies.flash) {
    try { req.flash = JSON.parse(Buffer.from(req.cookies.flash, 'base64url').toString()); } catch { /* ignore */ }
    res.clearCookie('flash', { path: '/' });
  }
  res.flash = (type, text) => res.cookie('flash', Buffer.from(JSON.stringify({ type, text })).toString('base64url'),
    { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
  res.page = (title, body) => {
    redirectGuard.reset(req, res);
    // Signed-in pages carry personal data and forms bound to this session: never keep a copy (shared computers,
    // and the Back button would otherwise show a stale form whose token no longer works).
    if (req.user && !res.get('Cache-Control')) res.set('Cache-Control', 'no-store');
    return res.send(layout(req, title, body));
  };
  next();
});

// Counts redirects in a row and stops a loop before the browser gives up (see redirect-guard.js).
app.use(redirectGuard.guard);

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

/**
 * A request another site made the browser send: its Origin is not ours (as this request sees it, or the configured
 * public URL, since a tunnel or proxy may rewrite Host). Browsers send Origin with every POST; without one, the
 * Fetch Metadata header still says when it came from another site.
 */
function foreignRequest(req) {
  const origin = req.get('origin');
  if (origin) return origin !== `${req.protocol}://${req.get('host')}` && origin !== PUBLIC_ORIGIN;
  return req.get('sec-fetch-site') === 'cross-site';
}
const discardUpload = (req) => { if (req.file) fs.rmSync(req.file.path, { force: true }); };

// CSRF: every POST must come from our own origin; logged-in POSTs must also carry the session token.
function verifyCsrf(req, res, next) {
  if (foreignRequest(req)) {
    discardUpload(req);
    return res.status(403).send('Forbidden');
  }
  if (req.session && !PUBLIC_POSTS.has(req.path)) {
    const token = String(req.body?._csrf || '');
    const ok = token.length === req.session.csrf.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrf));
    if (!ok) {
      // A form from an older page: the person signed in again (another tab, after a new deployment) or the page came
      // back from the browser history. Nothing is done; the page is reloaded with a fresh token and a short message.
      discardUpload(req);
      res.flash('warning', 'הדף היה ישן (למשל אחרי התחברות מחדש בלשונית אחרת), ולכן הפעולה לא בוצעה. הדף רוענן – נסו שוב.');
      return res.redirect(303, sameSiteReferer(req) || '/');
    }
  }
  next();
}
// The forms that upload a file (multipart): they check the token after the upload is parsed (licenseUpload & co.
// below). A multipart request to any other address is refused: it used to skip the token check (SEC-004).
const UPLOAD_POSTS = [/^\/register$/, /^\/me\/license$/, /^\/admin\/users\/new$/, /^\/admin\/settings\/branding$/,
  /^\/admin\/vehicle\/documents$/, /^\/master\/clients\/[^/]+\/branding$/];
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // The management API is called by the master console's server with a token, never by a browser with cookies.
  if (req.path.startsWith('/api/manage/')) return next();
  if (req.is('multipart/form-data')) {
    if (foreignRequest(req)) return res.status(403).send('Forbidden'); // before anything is written to disk
    if (!UPLOAD_POSTS.some((re) => re.test(req.path))) return res.status(415).send('Unsupported Media Type');
    return next();
  }
  verifyCsrf(req, res, next);
});

// Private uploads (driving licenses, vehicle documents): random file names, images or PDF only, up to config.uploadMaxBytes.
const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'application/pdf': '.pdf' };
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadsDir,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + ALLOWED[file.mimetype]),
  }),
  limits: { fileSize: config.uploadMaxBytes, files: 1 },
  fileFilter: (req, file, cb) => cb(null, Boolean(ALLOWED[file.mimetype])),
});
/**
 * The file really is what it says (SEC-008): its first bytes match its declared type. A renamed program or page is
 * deleted at once and the form is shown again with a message.
 */
const SIGNATURES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/heic': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
};
function checkUploadType(req, res, next) {
  if (!req.file) return next();
  let head = Buffer.alloc(0);
  try {
    const fd = fs.openSync(req.file.path, 'r');
    head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    fs.closeSync(fd);
  } catch { /* unreadable: refused below */ }
  if (SIGNATURES[req.file.mimetype]?.(head)) return next();
  discardUpload(req);
  res.flash('error', 'הקובץ אינו תמונה או PDF תקינים. בחרו צילום (JPG/PNG) או קובץ PDF.');
  return res.redirect(303, sameSiteReferer(req) || '/');
}
const licenseUpload = [upload.single('license'), checkUploadType, verifyCsrf];
const documentUpload = [upload.single('document'), checkUploadType, verifyCsrf];
const logoUpload = [upload.single('logo'), checkUploadType, verifyCsrf];

const requireLogin = (req, res, next) => {
  if (req.user) return next();
  // Not signed in: the login form is shown right here, at this address, and signing in continues to it. There is no
  // redirect to /login, so no chain of redirects (stale cookies, two deployments, a cached response) can loop.
  // A form post has nothing to continue to: it goes to the login page.
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.redirect(303, '/login');
  res.status(401).page('התחברות', require('./routes/public').loginPage(req, { next: req.originalUrl }));
};
const requireAdmin = (req, res, next) => {
  if (!req.user) return requireLogin(req, res, next);
  // A blocked/suspended admin keeps role=admin in the database but loses all admin access.
  if (req.user.role !== 'admin' || req.user.status !== 'active') {
    return res.status(403).page('אין הרשאה', html`<h1>אין הרשאה לעמוד זה</h1>`);
  }
  next();
};

// The master console (APP_MODE=master) is only the console: signing in and /master. Everything else, the booking
// pages included, leads to it.
if (config.master) {
  const OPEN = /^\/(login|logout|password\/|auth\/google|static\/|favicon\.ico$|healthz$|brand\/logo$|accessibility$|master(\/|$))/;
  app.use((req, res, next) => {
    if (OPEN.test(req.path)) return next();
    res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 302 : 303, '/master');
  });
}

const ctx = { app, requireLogin, requireAdmin, licenseUpload, documentUpload, logoUpload };
if (config.master || config.masterConsole) require('./routes/master')(ctx);
require('./routes/manage')(ctx);
require('./routes/public')(ctx);
require('./routes/user')(ctx);
require('./routes/admin')(ctx);
require('./routes/documents')(ctx);

// Anything unknown (an old link, a typo, a form re-sent to the wrong address) goes to the main page, which sends
// signed-in people on to their own home page; never a bare "not found". Only a missing file (image, style, script)
// gets a plain 404, so a browser asking for a file never receives a whole page instead.
app.use((req, res) => {
  const isFile = req.path.startsWith('/static/') || /\.[a-z0-9]{1,5}$/i.test(req.path);
  if (isFile) return res.status(404).type('text/plain').send('Not found');
  res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 302 : 303, '/'); // 303: a POST continues as a GET
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    res.flash('error', err.code === 'LIMIT_FILE_SIZE' ? `הקובץ גדול מדי (עד ${uploadLimitLabel()})` : 'שגיאה בהעלאת הקובץ');
    return res.redirect(sameSiteReferer(req) || '/'); // only back to our own pages (SEC-011)
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
