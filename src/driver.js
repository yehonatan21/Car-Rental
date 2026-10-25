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

function wrapLibsql(conn) {
  return {
    remote: true,
    exec: (sql) => conn.exec(sql),
    prepare(sql) {
      const stmt = conn.prepare(sql);
      return {
        get: (...p) => cleanRow(stmt.get(normalize(p))),
        all: (...p) => stmt.all(normalize(p)).map(cleanRow),
        run: (...p) => {
          const r = stmt.run(normalize(p));
          return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
        },
      };
    },
  };
}

function wrapNodeSqlite(conn) {
  return {
    remote: false,
    exec: (sql) => conn.exec(sql),
    prepare(sql) {
      const stmt = conn.prepare(sql);
      return {
        get: (...p) => stmt.get(...normalize(p)),
        all: (...p) => stmt.all(...normalize(p)),
        run: (...p) => {
          const r = stmt.run(...normalize(p));
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        },
      };
    },
  };
}

function openDatabase() {
  const { url, authToken } = config.database;
  if (url) {
    const Database = require('libsql');
    // libsql:// is Turso's name for HTTPS; spell it out so the transport is unambiguous.
    const conn = new Database(url.replace(/^libsql:\/\//, 'https://'), authToken ? { authToken } : {});
    const db = wrapLibsql(conn);
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = wrapNodeSqlite(new DatabaseSync(config.dbFile));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

module.exports = { openDatabase, normalize, cleanRow };
