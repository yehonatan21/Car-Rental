'use strict';
// Shared test helpers. Require this file FIRST in every test: it points DATA_DIR at a throwaway
// directory before the app's modules open the database. Each test file runs in its own process,
// so every file gets a fresh database.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-rental-test-'));
process.env.DATA_DIR = dataDir;
process.env.TZ = 'Asia/Jerusalem';
delete process.env.SMTP_HOST;

const { db, currentPolicy } = require('../src/db');
const auth = require('../src/auth');
const time = require('../src/time');

process.on('exit', () => fs.rmSync(dataDir, { recursive: true, force: true }));

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** Valid Israeli ID numbers, generated on demand so tests never collide. */
let idCounter = 100;
function nextIdNumber() {
  const body = String(idCounter++).padStart(8, '0');
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let n = Number(body[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return body + ((10 - (sum % 10)) % 10);
}

/** Inserts a user straight into the database. Active users get a verified license and accepted policy. */
function createUser(overrides = {}) {
  const u = {
    first_name: 'בדיקה', last_name: 'משתמש', id_number: nextIdNumber(), phone: '0501234567',
    email: `user${idCounter}@test.org`, password: 'Password1', role: 'user', status: 'active',
    license_expiry: time.addDays(time.today(), 365), license_verified: 1, license_file: null, ...overrides,
  };
  const id = Number(db.prepare(`INSERT INTO users (first_name, last_name, id_number, phone, email, password_hash, role, status,
      license_expiry, license_verified, license_file, privacy_accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`)
    .run(u.first_name, u.last_name, u.id_number, u.phone, u.email, auth.hashPassword(u.password), u.role, u.status,
      u.license_expiry, u.license_verified, u.license_file).lastInsertRowid);
  if (overrides.acceptPolicy !== false) {
    db.prepare('INSERT INTO policy_acceptances (user_id, policy_version) VALUES (?, ?)').run(id, currentPolicy().version);
  }
  return { ...db.prepare('SELECT * FROM users WHERE id = ?').get(id), password: u.password };
}

const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const getBooking = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);

/** Local datetime string N days from today at HH:MM. */
const inDays = (d, hhmm = '10:00') => `${time.addDays(time.today(), d)}T${hhmm}`;

function outbox() {
  const dir = path.join(dataDir, 'outbox');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map((f) => {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const headers = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' '); // unfold long header lines
    const subject = /^Subject: (.*)$/m.exec(headers)?.[1] ?? '';
    const to = /^To: (.*)$/m.exec(headers)?.[1] ?? '';
    // Subjects are RFC 2047 encoded; decode the UTF-8 base64/quoted-printable words.
    const decode = (s) => s.replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=\s*/gi, (_, enc, text) =>
      enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64').toString('utf8')
        : decodeURIComponent(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, '%$1')));
    return { file: f, subject: decode(subject), to, raw, body: decodeBody(raw) };
  });
}

/** Decoded text of all MIME parts (base64 and quoted-printable). */
function decodeBody(raw) {
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(raw)?.[1];
  const chunks = boundary ? raw.split('--' + boundary).slice(1, -1) : [raw];
  return chunks.map((chunk) => {
    const sep = chunk.search(/\r?\n\r?\n/);
    const headers = chunk.slice(0, sep);
    const body = chunk.slice(sep).trim();
    const enc = /Content-Transfer-Encoding:\s*(\S+)/i.exec(headers)?.[1]?.toLowerCase();
    if (enc === 'base64') return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8');
    if (enc === 'quoted-printable') {
      return Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
    }
    return body;
  }).join('\n');
}

function clearOutbox() {
  fs.rmSync(path.join(dataDir, 'outbox'), { recursive: true, force: true });
}

/** Starts the Express app on a random port. */
async function startServer() {
  const { app } = require('../src/server');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** Minimal browser-like HTTP client: keeps cookies, fetches CSRF tokens, never follows redirects. */
class Client {
  constructor(base) { this.base = base; this.cookies = {}; }

  async req(method, url, body, extraHeaders = {}) {
    const headers = { cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '), ...extraHeaders };
    let payload = body;
    if (body && !(body instanceof FormData)) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(body).toString();
    }
    const res = await fetch(this.base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (v === '' || /Expires=Thu, 01 Jan 1970/.test(c)) delete this.cookies[k]; else this.cookies[k] = v;
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text(), headers: res.headers };
  }

  get(url) { return this.req('GET', url); }

  async csrf(from = '/me') {
    const page = await this.get(from);
    return /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1];
  }

  /** POST a form; `from` is a page to read the CSRF token from (needed when logged in). */
  async post(url, body = {}, from = '/me') {
    if (body instanceof FormData) {
      const token = await this.csrf(from);
      if (token) body.set('_csrf', token);
      return this.req('POST', url, body);
    }
    const token = this.cookies.sid ? await this.csrf(from) : null;
    return this.req('POST', url, token ? { ...body, _csrf: token } : body);
  }

  async login(email, password = 'Password1') {
    const r = await this.post('/login', { email, password });
    if (r.status !== 302) throw new Error(`login failed for ${email}: ${r.status}`);
    return r;
  }

  flash() {
    const f = this.cookies.flash;
    return f ? JSON.parse(Buffer.from(decodeURIComponent(f), 'base64url').toString()) : null;
  }
}

/** Registration form with a license file attached. */
function registrationForm({ license, licenseBlob, licenseName, ...fields } = {}) {
  const fd = new FormData();
  const values = {
    first_name: 'ישראל', last_name: 'ישראלי', id_number: nextIdNumber(), phone: '050-1234567',
    email: `reg${idCounter}@test.org`, password: 'Password1', license_expiry: time.addDays(time.today(), 365),
    accept_policy: '1', accept_privacy: '1', policy_version: String(currentPolicy().version), ...fields,
  };
  for (const [k, v] of Object.entries(values)) if (v != null) fd.set(k, v);
  if (license !== null) {
    fd.set('license', licenseBlob || new Blob([PNG], { type: 'image/png' }), licenseName || 'license.png');
  }
  return fd;
}

module.exports = {
  dataDir, db, PNG, createUser, getUser, getBooking, inDays, outbox, clearOutbox, startServer, Client,
  registrationForm, nextIdNumber,
};
