'use strict';
// The app's icons (home screen, install, notifications) in each site's own colour, as PNG: painted from the templates
// scripts/make-icon-templates.js made of public/favicon.svg, resized, and kept in memory once made.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const T = 512;
const KINDS = ['any', 'maskable'];
const SIZES = [180, 192, 512];
const templates = {};
const template = (kind) => {
  if (!templates[kind]) templates[kind] = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'assets', `icon-${kind}.bin.gz`)));
  return templates[kind];
};

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** An RGBA PNG of size × size from raw pixels. */
function png(rgba, size) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0); head.writeUInt32BE(size, 4);
  head[8] = 8; head[9] = 6; // 8 bits per channel, RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const hex = (c) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || ''));
  const v = parseInt(m ? m[1] : '0b7a63', 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** The template painted in `color`, at 512 × 512. */
function paint(kind, color) {
  const t = template(kind);
  const [r, g, b] = hex(color);
  const out = Buffer.alloc(T * T * 4);
  for (let i = 0, o = 0; o < out.length; i += 5, o += 4) {
    const s = t[i + 4] / 255;
    out[o] = Math.round(t[i] + s * r); out[o + 1] = Math.round(t[i + 1] + s * g); out[o + 2] = Math.round(t[i + 2] + s * b); out[o + 3] = t[i + 3];
  }
  return out;
}

/** Box-filter resize (premultiplied, so transparent edges don't darken). */
function resize(src, size) {
  if (size === T) return src;
  const out = Buffer.alloc(size * size * 4);
  const f = T / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = x * f; const x1 = x0 + f; const y0 = y * f; const y1 = y0 + f;
      let r = 0; let g = 0; let b = 0; let a = 0; let w = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          const k = wx * wy; const i = (sy * T + sx) * 4; const al = src[i + 3] / 255;
          r += src[i] * al * k; g += src[i + 1] * al * k; b += src[i + 2] * al * k; a += al * k; w += k;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = a ? Math.round(r / a) : 0; out[o + 1] = a ? Math.round(g / a) : 0; out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / w) * 255);
    }
  }
  return out;
}

const made = new Map();
/** The PNG icon of `kind` ('any' or 'maskable') and `size` (180, 192 or 512) in `color`; null for anything else. */
function icon(kind, size, color) {
  if (!KINDS.includes(kind) || !SIZES.includes(size)) return null;
  const key = `${kind}:${size}:${hex(color).join(',')}`;
  if (!made.has(key)) {
    if (made.size > 60) made.clear(); // a site has one colour at a time; this only bounds a colour being tried out
    made.set(key, png(resize(paint(kind, color), size), size));
  }
  return made.get(key);
}

module.exports = { icon, KINDS, SIZES };
