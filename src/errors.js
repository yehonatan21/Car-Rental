'use strict';
// Error reporting: server errors are kept in the site's own database, grouped by kind (the same error from the same
// place counts once, with how many times and when). The site's status carries a short summary to the console, which
// lists them on the monitoring page and e-mails an alert for each new kind (src/alerts.js). Nothing leaves the site
// but the error's name, a shortened message and where in the code it happened: no request data, no user, no query string.
const crypto = require('node:crypto');
const path = require('node:path');
const time = require('./time');

const ROOT = path.join(__dirname, '..');

/** A message without what can identify a person or a secret: e-mails, tokens, long numbers, quoted values. */
const clean = (msg) => String(msg ?? '')
  .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]')
  .replace(/\/\/[^/@\s]+@/g, '//[credentials]@')
  .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
  .replace(/'([^']{0,200})'/g, (q, inner) => (/^[A-Za-z_$][\w$.]{0,60}$/.test(inner) ? q : "'…'")) // names in code stay; values go
  .replace(/\d{5,}/g, '#')
  .slice(0, 300);

/** The first line of the stack in the app's own code (not in node_modules), as file:line. */
function frame(err) {
  for (const line of String(err?.stack || '').split('\n').slice(1)) {
    const m = /\(?([^()\s]+):(\d+):\d+\)?$/.exec(line.trim());
    if (!m || m[1].includes('node_modules') || m[1].startsWith('node:')) continue;
    return `${path.relative(ROOT, m[1]).replace(/\\/g, '/')}:${m[2]}`;
  }
  return null;
}

/** The app's own lines of the stack, shortened (for whoever fixes it). */
const stack = (err) => String(err?.stack || '').split('\n').slice(1)
  .filter((l) => !l.includes('node_modules') && !l.includes('node:'))
  .slice(0, 8).map((l) => l.trim().replace(ROOT + path.sep, '')).join('\n');

/**
 * The same error again within WINDOW_MS of its last write is counted here, in this process, instead of written: during
 * an error storm (often the database itself being slow or down) every failing request would otherwise add a write. The
 * first occurrence of a kind is written at once, so the console sees every new kind. The occurrences held back are
 * added on that kind's next write, or by flush() (the scheduled jobs call it). A process that ends before then loses
 * its held-back occurrences: during a storm the counts can come out a little low, never a kind of error.
 */
const WINDOW_MS = 10000;
const pending = new Map(); // fp → { writtenAt, held, firstAt, lastAt, name, message, at, stack, where, route }

function write(e, count) {
  const { db } = require('./db');
  db.prepare(`INSERT INTO error_log (fp, name, message, frame, stack, where_, route, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fp) DO UPDATE SET count = count + excluded.count, last_at = excluded.last_at, route = COALESCE(excluded.route, route)`)
    .run(e.fp, e.name, e.message, e.at, e.stack, e.where, e.route, count, e.firstAt, e.lastAt);
}

/**
 * Records an error. `where` says what was running ('request', 'jobs', 'background'); `req` adds the method and the
 * path (without the query string). Never throws: reporting an error must not cause another.
 */
function record(err, { where = 'request', req } = {}) {
  try {
    const name = String(err?.name || 'Error').slice(0, 60);
    const message = clean(err?.message ?? err);
    const at = frame(err);
    // Numbers in messages (ids, sizes) vary; the kind is the same.
    const fp = crypto.createHash('sha1').update(`${name}|${message.replace(/\d+/g, '#')}|${at}`).digest('hex').slice(0, 12);
    const route = req ? `${req.method} ${String(req.baseUrl || '') + String(req.path || '')}`.slice(0, 120).replace(/\/\d+(?=\/|$)/g, '/:id') : null;
    const now = time.stamp();
    const nowMs = Date.now();
    const e = pending.get(fp);
    if (e && nowMs - e.writtenAt < WINDOW_MS) {
      e.held += 1;
      e.lastAt = now;
      if (route) e.route = route;
      return;
    }
    const entry = { fp, name, message, at, stack: stack(err), where, route: route ?? e?.route ?? null, firstAt: e?.firstAt || now, lastAt: now };
    const count = 1 + (e?.held || 0);
    // Counted as written even when the write fails: a failing database is not asked again by every failing request.
    pending.set(fp, { ...entry, writtenAt: nowMs, held: 0 });
    if (pending.size > 500) for (const [k, v] of pending) if (!v.held && nowMs - v.writtenAt >= WINDOW_MS) pending.delete(k);
    try {
      write(entry, count);
    } catch (err2) {
      pending.get(fp).held = count; // kept for the next write or flush()
      throw err2;
    }
  } catch (e) {
    console.error('[errors] could not record the error:', e.message);
  }
}

/** Writes the occurrences held back since each kind's last write. Never throws. Returns how many it wrote. */
function flush() {
  let written = 0;
  for (const e of pending.values()) {
    if (!e.held) continue;
    try {
      write(e, e.held);
      written += e.held;
      e.held = 0;
      e.writtenAt = Date.now();
    } catch (err) {
      console.error('[errors] could not record held-back errors:', err.message);
      return written; // the database is the problem: try again at the next flush
    }
  }
  return written;
}

const since24h = () => time.stamp(new Date(Date.now() - 24 * 3600000));

/** The kinds seen in the last 24 hours, the newest first (the site's status carries them to the console). */
function recent({ limit = 5 } = {}) {
  const { db } = require('./db');
  return db.prepare('SELECT fp, name, message, frame, stack, where_ AS "where", route, count, first_at, last_at FROM error_log WHERE last_at >= ? ORDER BY last_at DESC LIMIT ?')
    .all(since24h(), limit);
}

/** recent() and the totals: kinds seen in the last 24 hours, and how many of them are new. */
function summary({ limit = 5 } = {}) {
  const { db } = require('./db');
  const since = since24h();
  const n = db.prepare(`SELECT (SELECT COUNT(*) FROM error_log WHERE last_at >= ?) AS kinds,
    (SELECT COUNT(*) FROM error_log WHERE first_at >= ?) AS fresh`).get(since, since);
  return { kinds24h: n.kinds, new24h: n.fresh, recent: recent({ limit }) };
}

module.exports = { record, flush, summary, recent, clean, frame, WINDOW_MS };
