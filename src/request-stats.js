'use strict';
// How long visitors' requests take on this site, for the console's monitoring: the numbers that decide whether the
// hosted database driver is worth replacing (docs/PRE_RELEASE_REVIEW.md, item 1). timing.js counts every request into
// this process's totals; at most once a minute, after a response, they are added to the hour's row in request_stats,
// in one statement. On Vercel the jobs run in another process than the one that served the visitors, which is why each
// process saves its own. A process that ends loses its last minute of counts.
const { BOUNDS, takeTotals, restoreTotals } = require('./timing');

const SAVE_MS = 60000;
const COLS = BOUNDS.length + 1;
let lastSave = Date.now();
let saving = false;

const t = [...Array(COLS).keys()];

/** Adds this process's totals to the current hour. Never throws; returns how many requests it saved. */
function save() {
  const totals = takeTotals();
  lastSave = Date.now();
  if (!totals.requests) return 0;
  try {
    const { db } = require('./db');
    const hour = require('./time').stamp().slice(0, 13); // "2026-11-25 10"
    const names = [...t.map((i) => `t${i}`), ...t.map((i) => `d${i}`)];
    db.prepare(`INSERT INTO request_stats (hour, requests, total_ms, db_ms, queries, ${names.join(', ')})
      VALUES (?, ?, ?, ?, ?, ${names.map(() => '?').join(', ')})
      ON CONFLICT(hour) DO UPDATE SET requests = requests + excluded.requests, total_ms = total_ms + excluded.total_ms,
        db_ms = db_ms + excluded.db_ms, queries = queries + excluded.queries,
        ${names.map((n) => `${n} = ${n} + excluded.${n}`).join(', ')}`)
      .run(hour, totals.requests, totals.totalMs, totals.dbMs, totals.queries, ...totals.total, ...totals.db);
    return totals.requests;
  } catch (err) {
    restoreTotals(totals); // kept for the next save
    console.error('[stats] could not save the request times:', err.message);
    return 0;
  }
}

/** After a response: saves when the last save is a minute old, after the response (waitUntil on Vercel). */
function maybeSave() {
  if (saving || Date.now() - lastSave < SAVE_MS) return;
  saving = true;
  require('./later').inBackground(() => { try { save(); } finally { saving = false; } }, 'request times');
}

/** The value below which `share` of the counts in `buckets` fall: a bucket's upper bound, or null above the last. */
function percentile(buckets, share) {
  const n = buckets.reduce((a, b) => a + b, 0);
  if (!n) return null;
  let seen = 0;
  for (let i = 0; i < BOUNDS.length; i++) {
    seen += buckets[i];
    if (seen >= share * n) return BOUNDS[i];
  }
  return null; // in the last bucket: above the last bound
}

/** SQL for one column holding the last 24 hours as JSON (part of the status's single statement, routes/manage.js). */
const summarySql = `(SELECT json_object('requests', COALESCE(SUM(requests), 0), 'totalMs', COALESCE(SUM(total_ms), 0),
  'dbMs', COALESCE(SUM(db_ms), 0), 'queries', COALESCE(SUM(queries), 0),
  't', json_array(${t.map((i) => `COALESCE(SUM(t${i}), 0)`).join(', ')}),
  'd', json_array(${t.map((i) => `COALESCE(SUM(d${i}), 0)`).join(', ')})) FROM request_stats WHERE hour >= ?)`;

/** The first hour summarySql counts: the last 24 hours. */
const since = () => require('./time').stamp(new Date(Date.now() - 24 * 3600000)).slice(0, 13);

/**
 * The summary the status reports, from summarySql's JSON: requests, median and 95th percentile of the request time and
 * of the database time (upper bounds of their buckets; null means "above 5 s"), the database's share of the time, and
 * queries per request. null with no requests.
 */
function summarize(json) {
  let s;
  try { s = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  if (!s?.requests) return null;
  return {
    requests: s.requests,
    p50: percentile(s.t, 0.5),
    p95: percentile(s.t, 0.95),
    dbP95: percentile(s.d, 0.95),
    dbShare: s.totalMs > 0 ? Math.round((s.dbMs / s.totalMs) * 100) : 0,
    queries: Math.round((s.queries / s.requests) * 10) / 10,
  };
}

module.exports = { save, maybeSave, summarize, summarySql, since, percentile, SAVE_MS };
