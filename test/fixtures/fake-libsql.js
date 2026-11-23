'use strict';
// A stand-in for the `libsql` package in remote mode, backed by an in-memory node:sqlite database, so the hosted-database
// code paths (src/driver.js, src/storage.js, the "hosted" storage info) run without a sqld server. It answers like
// libsql: parameters as one array, and rows with the extra `_metadata` property the driver removes.
// Use: require this file before anything requires src/db.js (it replaces `libsql` in the require cache).
const { DatabaseSync } = require('node:sqlite');

const databases = new Map(); // url → database, so a reconnect (a new connection) sees the same data
const opened = [];

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
      get: (p = []) => { const r = s.get(...p); return r && { ...r, _metadata: { fake: true } }; },
      all: (p = []) => s.all(...p).map((r) => ({ ...r, _metadata: { fake: true } })),
      run: (p = []) => s.run(...p),
    };
  }
}
Database.opened = opened;

require.cache[require.resolve('libsql')] = { id: 'libsql', filename: require.resolve('libsql'), loaded: true, exports: Database };
module.exports = Database;
