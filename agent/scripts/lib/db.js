'use strict';
// Read-only access to a Car-Rental site's database for the agent's scripts.
// The database is chosen exactly as the app chooses it (src/config.js):
//   - TURSO_DATABASE_URL / LIBSQL_URL (+ TURSO_AUTH_TOKEN / LIBSQL_AUTH_TOKEN): a site's hosted database. Use a
//     read-only token (turso db tokens create <database> --read-only), so nothing can change even by mistake.
//   - otherwise DATA_DIR (default ./data of the repository): the local SQLite file, opened read-only.
// Every statement must be a single SELECT (or WITH … SELECT); anything else is refused before it reaches the database.
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
if (!process.env.HTTPS) process.env.HTTPS = 'false'; // config's local default; nothing is served here
if (!process.env.DATA_DIR) process.env.DATA_DIR = path.join(ROOT, 'data');
const config = require(path.join(ROOT, 'src/config'));
const time = require(path.join(ROOT, 'src/time'));

const WRITE = /\b(insert|update|delete|replace|upsert|drop|alter|create|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release)\b/i;

/** Throws unless `sql` is one read-only statement. */
function assertReadOnly(sql) {
  const s = String(sql).trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(s)) throw new Error('Only SELECT statements are allowed (read-only).');
  if (s.includes(';')) throw new Error('Only one statement at a time.');
  if (WRITE.test(s.replace(/'(?:[^']|'')*'/g, "''"))) throw new Error('This statement could change data, so it is refused (read-only).');
  return s;
}

let db = null;
function open() {
  if (db) return db;
  const { url, authToken } = config.database;
  if (url) {
    const Database = require(path.join(ROOT, 'node_modules/libsql'));
    const conn = new Database(url.replace(/^libsql:\/\//, 'https://'), authToken ? { authToken } : {});
    const { cleanRow, normalize } = require(path.join(ROOT, 'src/driver'));
    db = { kind: 'hosted', all: (sql, ...p) => conn.prepare(assertReadOnly(sql)).all(normalize(p)).map(cleanRow) };
  } else {
    const fs = require('node:fs');
    if (!fs.existsSync(config.dbFile)) throw new Error(`No database at ${config.dbFile}. Set DATA_DIR, or TURSO_DATABASE_URL and TURSO_AUTH_TOKEN for a site's hosted database.`);
    const { DatabaseSync } = require('node:sqlite');
    const conn = new DatabaseSync(config.dbFile, { readOnly: true });
    db = { kind: 'file', all: (sql, ...p) => conn.prepare(assertReadOnly(sql)).all(...p) };
  }
  return db;
}

const all = (sql, ...params) => open().all(sql, ...params);
const one = (sql, ...params) => all(sql, ...params)[0];

/** Columns that never leave the database: identity numbers, phones, secrets, file names of license photos. */
const SENSITIVE = ['id_number', 'phone', 'password_hash', 'totp_secret', 'token_hash', 'code_hash', 'csrf', 'license_file', 'pending_license_file', 'google_sub'];
const scrub = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !SENSITIVE.includes(k.toLowerCase())));

/** --name value / --flag from the command line. */
function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else out._.push(a);
  }
  return out;
}

/** Prints the result as JSON (what the agent reads), or the error as JSON with exit code 1. */
function run(fn) {
  try {
    process.stdout.write(JSON.stringify(fn(args()), null, 2) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }) + '\n');
    process.exitCode = 1;
  }
}

/** A date range from --from/--to (YYYY-MM-DD, `to` inclusive) or --days (ending today). */
function range(a, defaultDays = 30) {
  const to = time.isValidDate(a.to) ? a.to : time.today();
  const days = Math.max(1, Math.min(3660, Number(a.days) || defaultDays));
  const from = time.isValidDate(a.from) ? a.from : time.addDays(to, -(days - 1));
  if (from > to) throw new Error('--from must be before --to');
  return { from, to, start: `${from}T00:00`, end: `${time.addDays(to, 1)}T00:00` };
}

/** Hours of [s, e) that fall inside [from, to). */
function overlapHours(s, e, from, to) {
  const a = s > from ? s : from;
  const b = e < to ? e : to;
  return b > a ? time.hoursBetween(a, b) : 0;
}

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

module.exports = { all, one, scrub, args, run, range, overlapHours, round, time, assertReadOnly, SENSITIVE, config };
