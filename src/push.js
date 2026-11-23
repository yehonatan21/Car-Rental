'use strict';
// Phone notifications (Web Push), next to the e-mails: a booking approved, rejected or cancelled, the pickup and
// return reminders, and for managers a new request or registration. Each device that allowed notifications is a row
// in push_subscriptions. Messages are encrypted for that device (the push service in between cannot read them) and
// carry no ID numbers or other personal details beyond what the e-mail's subject says.
//
// The site makes its own key pair (VAPID) once and keeps it in the database, so nothing needs configuring.
const webpush = require('web-push');
const { db } = require('./db');
const config = require('./config');
const time = require('./time');

let keys = null;
/** The site's key pair, made on first use. Two instances racing: the first one written wins, both read it back. */
function vapid() {
  if (keys) return keys;
  const get = () => Object.fromEntries(db.prepare("SELECT key, value FROM app_meta WHERE key IN ('vapid_public', 'vapid_private')").all().map((r) => [r.key, r.value]));
  let k = get();
  if (!k.vapid_public || !k.vapid_private) {
    const made = webpush.generateVAPIDKeys();
    db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('vapid_public', ?)").run(made.publicKey);
    db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('vapid_private', ?)").run(made.privateKey);
    k = get();
  }
  keys = { publicKey: k.vapid_public, privateKey: k.vapid_private };
  return keys;
}
const publicKey = () => vapid().publicKey;

// Push services only accept https endpoints from browsers; the tests use a local one.
const validEndpoint = (u) => /^https:\/\/[^\s/]+\//.test(u) || (!config.production && /^http:\/\/127\.0\.0\.1:\d+\//.test(u));

/** Saves this device for the user (a device used by someone else before is moved to this user). */
function subscribe(userId, sub, userAgent = '') {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || '');
  const auth = String(sub?.keys?.auth || '');
  if (!validEndpoint(endpoint) || endpoint.length > 1000 || !/^[\w-]{20,200}$/.test(p256dh) || !/^[\w-]{10,100}$/.test(auth)) return false;
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device`)
    .run(userId, endpoint, p256dh, auth, deviceName(userAgent), time.stamp());
  return true;
}

/** Removes one device (signing out, or "turn off" on that device), or all of the user's devices. */
function unsubscribe(userId, endpoint) {
  if (endpoint) return db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, String(endpoint)).changes > 0;
  return db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId).changes > 0;
}

const devices = (userId) => db.prepare('SELECT id, device, created_at, last_sent_at FROM push_subscriptions WHERE user_id = ? ORDER BY created_at').all(userId);

/** A short, readable name for the device ("Android · Chrome"), nothing that identifies it. */
function deviceName(ua) {
  const s = String(ua);
  const os = /iPhone|iPad/.test(s) ? 'iPhone' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : 'מכשיר';
  const browser = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  return browser ? `${os} · ${browser}` : os;
}

/** Sends to one device: true when delivered; a device the push service no longer knows is forgotten. */
async function deliver(row, payload) {
  const k = vapid();
  const details = webpush.generateRequestDetails({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify(payload), {
    vapidDetails: { subject: config.mailFrom && /@/.test(config.mailFrom) ? `mailto:${config.mailFrom}` : config.baseUrl, publicKey: k.publicKey, privateKey: k.privateKey },
    TTL: 6 * 3600, // undelivered after 6 hours (phone off): drop it, a late reminder misleads
    urgency: payload.urgent ? 'high' : 'normal',
    topic: payload.tag ? payload.tag.replace(/[^\w-]/g, '').slice(0, 32) : undefined,
  });
  try {
    const res = await fetch(details.endpoint, { method: details.method, headers: details.headers, body: details.body, signal: AbortSignal.timeout(8000) });
    if (res.status === 404 || res.status === 410) { db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id); return false; }
    if (!res.ok) { console.warn(`[push] ${res.status} from the push service`); return false; }
    db.prepare('UPDATE push_subscriptions SET last_sent_at = ? WHERE id = ?').run(time.stamp(), row.id);
    return true;
  } catch (err) {
    console.warn('[push] could not send:', err.message);
    return false;
  }
}

/**
 * Sends { title, body, url, tag } to every device of these users. Never throws; resolves to how many devices got it.
 * The address is a path on this site; the notification opens it when tapped.
 */
async function notify(userIds, { title, body, url = '/', tag, urgent = false }) {
  const ids = [...new Set([].concat(userIds).filter(Boolean))];
  if (!ids.length) return 0;
  let rows;
  try {
    rows = db.prepare(`SELECT * FROM push_subscriptions WHERE user_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  } catch (err) {
    console.error('[push]', err.message);
    return 0;
  }
  const payload = { title: String(title).slice(0, 80), body: String(body || '').slice(0, 240), url: String(url).startsWith('/') ? url : '/', tag, urgent };
  const sent = await Promise.all(rows.map((r) => deliver(r, payload)));
  return sent.filter(Boolean).length;
}

/** The active managers (who get the managers' notifications, as they get the e-mails). */
const adminIds = () => db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all().map((r) => r.id);

module.exports = { publicKey, subscribe, unsubscribe, devices, notify, adminIds, deviceName };
