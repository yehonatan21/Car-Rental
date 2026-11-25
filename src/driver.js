'use strict';
// Opens the database and gives both drivers the same small synchronous interface the app uses:
//   db.exec(sql), db.prepare(sql).get/all/run(...params) → run returns { changes, lastInsertRowid }
//
// - Local file (default): Node's built-in node:sqlite.
// - Hosted libSQL / Turso (TURSO_DATABASE_URL or LIBSQL_URL): the `libsql` package in remote mode, so data
//   lives outside the app and survives redeploys (needed on Vercel, whose functions have no lasting disk).
//
// The `libsql` package needs some care, verified against libsql-server (sqld) 0.24:
//   - a single null parameter fails ("failed to downcast any to object") unless parameters are passed as an array;
//   - a boolean parameter aborts the whole process (native panic), so booleans are converted to 1/0;
//   - rows carry an extra `_metadata` property (removed) and keyword column names come back upper-case (lowered);
//   - numbers are sent as REAL; SQLite compares 1.0 = 1, so lookups still match;
//   - PRAGMAs for local files (journal_mode, busy_timeout) are rejected by the server.
const config = require('./config');
const { track } = require('./timing'); // per-request database time (Server-Timing)

/** SQLite has no booleans and the drivers disagree on undefined; normalize before binding. */
function normalize(params) {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

/**
 * libsql rows: drop the extra `_metadata` property and lowercase column names. sqld returns columns that are SQL
 * keywords in upper case (`key` → KEY, `action` → ACTION); the app only uses lowercase snake_case names.
 */
function cleanRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) if (k !== '_metadata') out[k.toLowerCase()] = v;
  return out;
}

// A connection that went stale: the server (Turso) or a proxy closed it while the function sat idle between requests
// (a warm Vercel instance keeps it for minutes), or the server dropped the stream. Nothing reached the database, so
// the step can be tried again on a new connection.
const STALE = /connection closed before message completed|STREAM_EXPIRED|stream not found|stream has expired|connection reset|ECONNRESET|broken pipe|error sending request/i;
// Statements that change data. Preparing one can be retried; running it can't (it may have reached the database).
const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|UPSERT)\b/i;
// Idle longer than this: start a new connection instead of reusing one the other side has likely closed.
const IDLE_MS = 60 * 1000;

/**
 * open() makes a connection. Steps that are safe to repeat (preparing a statement, reading) are tried once more on a
 * new connection when the old one turns out to be stale. A write (run, exec) is not repeated: it may have reached the
 * database before the connection broke, so it fails as before rather than risk doing it twice.
 */
function wrapLibsql(open) {
  let conn = open();
  let lastUsed = Date.now();
  // Inside BEGIN … COMMIT the connection is never changed: the transaction lives on it, and a statement moved to a
  // new connection would be saved outside the transaction. A stale connection there fails the transaction instead.
  let inTransaction = false;
  const fresh = () => {
    if (!inTransaction && Date.now() - lastUsed > IDLE_MS) conn = open();
    lastUsed = Date.now();
    return conn;
  };
  const retry = (fn) => {
    try {
      return fn(fresh());
    } catch (err) {
      if (inTransaction || !STALE.test(String(err?.message || err))) throw err;
      console.warn('[db] stale connection, trying again on a new one:', String(err.message).slice(0, 120));
      conn = open();
      lastUsed = Date.now();
      return fn(conn);
    }
  };
  return {
    remote: true,
    exec: (sql) => {
      const c = fresh();
      const ends = /^\s*(COMMIT|END|ROLLBACK)\b/i.test(sql);
      try {
        const r = track(() => c.exec(sql));
        if (/^\s*BEGIN\b/i.test(sql)) inTransaction = true;
        return r;
      } finally {
        if (ends) inTransaction = false; // over either way, even when COMMIT itself failed
      }
    },
    prepare(sql) {
      const stmt = retry((c) => c.prepare(sql));
      // A write read back through get()/all() (INSERT … RETURNING) is still a write: never repeated, like run().
      const writes = WRITE.test(sql);
      const read = (method, p) => {
        try {
          return stmt[method](normalize(p));
        } catch (err) {
          if (inTransaction || writes || !STALE.test(String(err?.message || err))) throw err;
          console.warn('[db] stale connection on a read, trying again on a new one');
          return retry((c) => c.prepare(sql))[method](normalize(p));
        }
      };
      return {
        get: (...p) => track(() => cleanRow(read('get', p))),
        all: (...p) => track(() => read('all', p).map(cleanRow)),
        run: (...p) => {
          const r = track(() => stmt.run(normalize(p)));
          return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
        },
      };
    },
  };
}

function wrapNodeSqlite(conn) {
  return {
    remote: false,
    exec: (sql) => track(() => conn.exec(sql)),
    prepare(sql) {
      const stmt = conn.prepare(sql);
      return {
        get: (...p) => track(() => stmt.get(...normalize(p))),
        all: (...p) => track(() => stmt.all(...normalize(p))),
        run: (...p) => {
          const r = track(() => stmt.run(...normalize(p)));
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        },
      };
    },
  };
}

function openDatabase() {
  const { url, authToken } = config.database;
  if (config.missingDatabase) {
    throw new Error(`No database is connected to this ${process.env.VERCEL_ENV || 'Vercel'} deployment: TURSO_DATABASE_URL is not set, `
      + 'so every new version (and every server instance) would start with empty data.');
  }
  if (url) {
    const Database = require('libsql');
    // libsql:// is Turso's name for HTTPS; spell it out so the transport is unambiguous.
    const open = () => {
      const conn = new Database(url.replace(/^libsql:\/\//, 'https://'), authToken ? { authToken } : {});
      conn.exec('PRAGMA foreign_keys = ON');
      return conn;
    };
    return wrapLibsql(open);
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = wrapNodeSqlite(new DatabaseSync(config.dbFile));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

module.exports = { openDatabase, normalize, cleanRow, wrapLibsql, STALE };
