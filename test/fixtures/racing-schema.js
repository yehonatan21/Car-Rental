'use strict';
// Preloaded (node -r) before src/db.js: pretends another server instance is upgrading the same database at the same
// moment. The table check says `users.google_sub` is missing (the other instance has just added it) and that the old
// `users.totp_secret` column is still there (the other instance has just dropped it), so this instance's own ALTER
// TABLE meets "duplicate column" / "no such column" and must carry on.
const driver = require('../../src/driver');

const open = driver.openDatabase;
driver.openDatabase = () => {
  const db = open();
  const prepare = db.prepare;
  db.prepare = (sql) => {
    const stmt = prepare(sql);
    if (sql !== 'PRAGMA table_info(users)') return stmt;
    return { ...stmt, all: () => stmt.all().filter((c) => c.name !== 'google_sub').concat([{ name: 'totp_secret' }]) };
  };
  return db;
};
