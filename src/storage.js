'use strict';
// Where uploaded license images live.
// - Local database: as files in DATA_DIR/licenses (the original layout).
// - Hosted database (Turso/libSQL): inside the database, in 1 MB chunks, so they survive redeploys together with
//   everything else. Hosted servers reject single values over ~5 MB, hence the chunks.
// Uploads always arrive as a temporary file in DATA_DIR/licenses first (multer); keep() finishes storing it.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { db } = require('./db');

const CHUNK = 1024 * 1024;
const inDatabase = () => db.remote;
const diskPath = (name) => path.join(config.uploadsDir, path.basename(name));

/** Finishes storing an uploaded file (multer's req.file) under its generated name. */
function keep(file) {
  if (!inDatabase()) return;
  const data = fs.readFileSync(file.path);
  db.prepare('DELETE FROM files WHERE name = ?').run(file.filename);
  const insert = db.prepare('INSERT INTO files (name, seq, data) VALUES (?, ?, ?)');
  for (let seq = 0, off = 0; off < data.length || seq === 0; seq++, off += CHUNK) {
    insert.run(file.filename, seq, data.subarray(off, off + CHUNK));
  }
  fs.rmSync(file.path, { force: true });
}

/** Contents of a stored file, or null. */
function read(name) {
  if (!name) return null;
  if (!inDatabase()) {
    const p = diskPath(name);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  const rows = db.prepare('SELECT data FROM files WHERE name = ? ORDER BY seq').all(name);
  return rows.length ? Buffer.concat(rows.map((r) => Buffer.from(r.data))) : null;
}

function remove(name) {
  if (!name) return;
  if (inDatabase()) db.prepare('DELETE FROM files WHERE name = ?').run(name);
  fs.rmSync(diskPath(name), { force: true });
}

/** Discards an upload that was not accepted (validation failed). */
function discard(file) {
  if (file) fs.rmSync(file.path, { force: true });
}

module.exports = { keep, read, remove, discard, inDatabase, CHUNK };
