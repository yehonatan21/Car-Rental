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

/** Express middleware: measures the request and adds the Server-Timing header just before the headers go out. */
function middleware(req, res, next) {
  const store = { queries: 0, dbMs: 0, start: process.hrtime.bigint() };
  const writeHead = res.writeHead;
  res.writeHead = function timedWriteHead(...args) {
    const total = ms(store.start);
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

module.exports = { track, middleware, SLOW_MS };
