'use strict';
// Preloaded (node -r) before src/db.js: the database interrupts setup statements, the way the hosted database (sqld)
// sometimes answers while other instances start on it ("SQLite error: interrupted"). INTERRUPT says how:
//   once     every ALTER TABLE, CREATE and INSERT … app_meta fails its first time, then works (it was rolled back)
//   always   the first ALTER TABLE never works
//   other    the first ALTER TABLE fails with an error that is not an interruption
const driver = require('../../src/driver');

const how = process.env.INTERRUPT || 'once';
const seen = new Set();
const fails = (sql) => {
  if (!/^\s*(ALTER TABLE|CREATE|INSERT INTO app_meta)/i.test(sql)) return false;
  if (how === 'once') return !seen.has(sql) && seen.add(sql);
  return /^\s*ALTER TABLE/i.test(sql);
};
const error = () => new Error(how === 'other' ? 'SQLite error: no such table: nowhere' : 'Hrana(Api("SQLite error: interrupted"))');

const open = driver.openDatabase;
driver.openDatabase = () => {
  const db = open();
  const exec = db.exec;
  const prepare = db.prepare;
  db.exec = (sql) => {
    if (fails(sql)) throw error();
    return exec(sql);
  };
  db.prepare = (sql) => {
    const stmt = prepare(sql);
    return { ...stmt, run: (...p) => { if (fails(sql)) throw error(); return stmt.run(...p); } };
  };
  return db;
};
