'use strict';
// A stand-in for the `libsql` package in remote mode, backed by an in-memory node:sqlite database, so the hosted-database
// code paths (src/driver.js, src/storage.js, the "hosted" storage info) run without a sqld server. It answers like
// libsql: parameters as one array, BLOBs as ArrayBuffer, and rows with the extra `_metadata` property the driver removes.
// Use: require this file before anything requires src/db.js (it replaces `libsql` in the require cache).
const { DatabaseSync } = require('node:sqlite');

const databases = new Map(); // url → database, so a reconnect (a new connection) sees the same data
const opened = [];

/** A row as libsql gives it: BLOBs as ArrayBuffer (node:sqlite gives Uint8Array), plus its `_metadata`. */
function asLibsql(row) {
  const out = { _metadata: { fake: true } };
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v;
  }
  return out;
}

class Database {
  constructor(url, options = {}) {
    if (!databases.has(url)) databases.set(url, new DatabaseSync(':memory:'));
    this.db = databases.get(url);
    opened.push({ url, options });
  }

  exec(sql) { return this.db.exec(sql); }

  prepare(sql) {
    const s = this.db.prepare(sql);
    return {
      get: (p = []) => { const r = s.get(...p); return r && asLibsql(r); },
      all: (p = []) => s.all(...p).map(asLibsql),
      run: (p = []) => s.run(...p),
    };
  }
}
Database.opened = opened;

require.cache[require.resolve('libsql')] = { id: 'libsql', filename: require.resolve('libsql'), loaded: true, exports: Database };
module.exports = Database;
