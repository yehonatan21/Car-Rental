'use strict';
// Where uploaded license images live.
// - Local database: as files in DATA_DIR/licenses (the original layout).
// - Hosted database (Turso/libSQL): inside the database, in 1 MB chunks, so they survive redeploys together with
//   everything else. Hosted servers reject single values over ~5 MB, hence the chunks.
// Uploads always arrive as a temporary file in DATA_DIR/licenses first (multer); keep() finishes storing it.
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
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

/** Resolves when the response can take more, or when its connection closed (then 'drain' would never come). */
const drained = (res) => new Promise((ok) => {
  const done = () => { res.off('drain', done); res.off('close', done); ok(); };
  res.on('drain', done);
  res.on('close', done);
});

/** Sending a stored file went wrong midway: close the connection; report it unless the visitor just went away. */
function failed(res, name, err) {
  res.destroy();
  if (err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || res.req?.destroyed) return;
  console.error(`[storage] sending ${name} failed:`, err?.message || err);
  require('./errors').record(err, { where: 'request', req: res.req });
}

/**
 * A stored file, ready to be sent without holding all of it in memory: { size, pipe(res) }, or null when there is no
 * such file. From disk it is streamed; from the hosted database it goes one 1 MB chunk at a time, each read only once
 * the one before has left. The first query also brings the first chunk, so a file of one chunk (most license photos)
 * is still a single round trip. pipe() sets Content-Length and ends the response; the caller sets the type and the
 * other headers first. pipe() never rejects: once part of the file has gone out there is no error page to send, so a
 * failure closes the connection (the browser shows a broken download, never a wrong file) and is logged; a visitor who
 * closed the tab midway is no failure at all.
 */
async function open(name) {
  if (!name) return null;
  if (!inDatabase()) {
    const p = diskPath(name);
    const stat = await fs.promises.stat(p).catch(() => null);
    if (!stat?.isFile()) return null;
    return {
      size: stat.size,
      pipe: (res) => {
        res.setHeader('Content-Length', stat.size);
        return pipeline(fs.createReadStream(p), res).catch((err) => failed(res, name, err));
      },
    };
  }
  // length() of a chunk comes from its row header: the other chunks' contents are not read here.
  const rows = db.prepare('SELECT seq, length(data) AS size, CASE WHEN seq = 0 THEN data END AS data FROM files WHERE name = ? ORDER BY seq').all(name);
  if (!rows.length) return null;
  const size = rows.reduce((n, r) => n + Number(r.size), 0);
  const chunk = db.prepare('SELECT data FROM files WHERE name = ? AND seq = ?');
  return {
    size,
    async pipe(res) {
      res.setHeader('Content-Length', size);
      try {
        for (const [i, r] of rows.entries()) {
          // Chunks are numbered 0, 1, 2…: a gap would send a file with a piece cut out, as if it were whole.
          if (r.seq !== i) throw new Error(`stored file ${name}: chunk ${i} is missing`);
          const data = r.seq === 0 && r.data != null ? r.data : chunk.get(name, r.seq)?.data;
          if (data == null) throw new Error(`stored file ${name}: chunk ${r.seq} is missing`);
          // A view of the row's bytes, not a copy of them.
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
          if (!res.write(buf)) await drained(res);
          if (res.destroyed) return; // the visitor went away: stop reading
          r.data = null; // the first chunk too: never more than one in memory
        }
        res.end();
      } catch (err) {
        failed(res, name, err);
      }
    },
  };
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

module.exports = { keep, read, open, remove, discard, inDatabase, CHUNK };
