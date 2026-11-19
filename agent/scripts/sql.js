'use strict';
// node scripts/sql.js "SELECT …"   — one read-only query for questions the other scripts don't answer (max 200 rows).
// Refused: anything but a single SELECT, and the columns that hold ID numbers, phones or secrets.
const { all, run, scrub, SENSITIVE } = require('./lib/db');

run((a) => {
  const sql = a._.join(' ').trim();
  if (!sql) throw new Error('Usage: node scripts/sql.js "SELECT …"');
  const named = SENSITIVE.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(sql));
  if (named) throw new Error(`The column ${named} holds personal or secret data and can't be queried.`);
  const rows = all(sql).map(scrub); // also covers SELECT *
  return { rows: rows.slice(0, 200), count: rows.length, truncated: rows.length > 200 || undefined };
});
