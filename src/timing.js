'use strict';
// Where a request's time goes: every database call made while handling it is timed (driver.js calls track()), and the
// response carries a Server-Timing header, which the browser shows in DevTools → Network → Timing:
//   Server-Timing: db;dur=12.4;desc="5 queries", total;dur=31.0
// Requests slower than SLOW_MS are also logged with the same numbers, so they can be found in the Vercel logs.
const { AsyncLocalStorage } = require('node:async_hooks');

const SLOW_MS = 1000;
const als = new AsyncLocalStorage();
const ms = (since) => Number(process.hrtime.bigint() - since) / 1e6;

/** Runs one database call, counted against the current request (if any). */
function track(fn) {
  const store = als.getStore();
  if (!store) return fn();
  const t = process.hrtime.bigint();
  try {
    return fn();
  } finally {
    store.queries += 1;
    store.dbMs += ms(t);
  }
}

// ---------- This process's totals, for the console (src/request-stats.js saves them) ----------
// Request time and database time are counted into buckets (upper bounds in ms; the last bucket is everything above),
// so the console can show the median and the 95th percentile without keeping every request.
const BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const fresh = () => ({ requests: 0, totalMs: 0, dbMs: 0, queries: 0, total: Array(BOUNDS.length + 1).fill(0), db: Array(BOUNDS.length + 1).fill(0) });
let totals = fresh();
const bucket = (v) => { let i = 0; while (i < BOUNDS.length && v > BOUNDS[i]) i += 1; return i; };
// Not what a visitor waits for: files, the health check, the console asking for the status, the scheduled run.
const NOT_COUNTED = /^\/(static\/|healthz$|favicon\.ico$|api\/manage\/|internal\/)/;

function count(totalMs, dbMs, queries) {
  totals.requests += 1;
  totals.totalMs += totalMs;
  totals.dbMs += dbMs;
  totals.queries += queries;
  totals.total[bucket(totalMs)] += 1;
  totals.db[bucket(dbMs)] += 1;
}

/** The totals counted since the last call, and a fresh start. */
function takeTotals() {
  const t = totals;
  totals = fresh();
  return t;
}

/** Puts totals that could not be saved back, so they go with the next save. */
function restoreTotals(t) {
  totals.requests += t.requests;
  totals.totalMs += t.totalMs;
  totals.dbMs += t.dbMs;
  totals.queries += t.queries;
  t.total.forEach((n, i) => { totals.total[i] += n; });
  t.db.forEach((n, i) => { totals.db[i] += n; });
}

/** Express middleware: measures the request and adds the Server-Timing header just before the headers go out. */
function middleware(req, res, next) {
  const store = { queries: 0, dbMs: 0, start: process.hrtime.bigint() };
  // Decided now: by the time the headers go out, a mounted handler (express.static under /static) has rewritten the path.
  const counted = !NOT_COUNTED.test(req.path);
  const writeHead = res.writeHead;
  res.writeHead = function timedWriteHead(...args) {
    const total = ms(store.start);
    if (counted) count(total, store.dbMs, store.queries);
    if (!res.headersSent) {
      res.setHeader('Server-Timing', `db;dur=${store.dbMs.toFixed(1)};desc="${store.queries} ${store.queries === 1 ? 'query' : 'queries'}", total;dur=${total.toFixed(1)}`);
    }
    if (total > SLOW_MS) {
      console.warn(`[slow] ${req.method} ${req.path} ${Math.round(total)} ms (database ${Math.round(store.dbMs)} ms, ${store.queries} queries)`);
    }
    return writeHead.apply(this, args);
  };
  als.run(store, next);
}

module.exports = { track, middleware, SLOW_MS, BOUNDS, takeTotals, restoreTotals };
