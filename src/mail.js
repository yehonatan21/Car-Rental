'use strict';
// Outgoing e-mail. With SMTP_* configured mail is sent; otherwise each message is written to data/outbox
// so the flows can be tested locally.
const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');
const config = require('./config');
const { db, audit } = require('./db');
const { brand } = require('./brand');
const time = require('./time');

// Built from the current config (re-created if it changes, e.g. in tests).
let transport, transportFor;
function getTransport() {
  if (!transport || transportFor !== config.smtp) {
    transportFor = config.smtp;
    transport = config.smtp
      ? nodemailer.createTransport(config.smtp)
      : nodemailer.createTransport({ streamTransport: true, buffer: true });
  }
  return transport;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function wrap(title, paragraphs, link) {
  const b = brand();
  const color = esc(b.color);
  const body = paragraphs.map((p) => `<p style="margin:0 0 12px">${p}</p>`).join('');
  const button = link
    ? `<p><a href="${esc(config.baseUrl + link.href)}" style="display:inline-block;background:${color};color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${esc(link.label)}</a></p>`
    : '';
  const contact = [b.contactPhone, b.contactEmail].filter(Boolean).map(esc).join(' · ');
  return `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
<h2 style="color:${color}">${esc(title)}</h2>${body}${button}
<p style="color:#888;font-size:12px;margin-top:24px">${esc(b.name)} – הודעה אוטומטית${contact ? ` · ליצירת קשר: ${contact}` : ''}</p></div>`;
}

// Delivery status for the admin settings page. Kept in memory per process; failures are also written to the
// audit log, because on Vercel the settings page is often served by a different instance than the one that failed.
const state = { lastError: null, lastSentAt: null, verified: null };
const startedAt = new Date();

// ---------- The outbox: e-mails that failed are retried, and reminders are sent once ----------
/** Minutes to wait before each retry; after the last one the message is "failed" (shown on the settings page). */
const RETRY_MINUTES = [1, 5, 15, 60, 180];
const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;

/** Delivers one composed message (or, without SMTP, saves it to data/outbox). Throws on failure. */
/** Counts what went out over SMTP today (mail_daily), for the console's monitoring. Never fails a send. */
function countMail(recipients, ok) {
  if (!config.smtp) return;
  try {
    db.prepare(`INSERT INTO mail_daily (day, recipients, messages, failed) VALUES (?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET recipients = recipients + excluded.recipients, messages = messages + excluded.messages,
      failed = failed + excluded.failed`).run(time.today(), ok ? recipients : 0, ok ? 1 : 0, ok ? 0 : 1);
  } catch (err) {
    console.error('[mail] could not count the message:', err.message);
  }
}

async function deliver(recipients, subject, { html, text, attachments }) {
  const from = { name: brand().mailFromName, address: config.mailFrom }; // inboxes show the name, not the bare address
  let info;
  try {
    info = await getTransport().sendMail({ from, to: recipients.join(', '), subject, html, text, attachments });
  } catch (err) {
    countMail(recipients.length, false);
    throw err;
  }
  countMail(recipients.length, true);
  if (!config.smtp) {
    fs.mkdirSync(config.outboxDir, { recursive: true });
    const file = path.join(config.outboxDir, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.eml`);
    fs.writeFileSync(file, info.message);
    console.log(`[mail] ${subject} → ${recipients.join(', ')} (saved to ${path.basename(file)})`);
  }
  state.lastSentAt = new Date();
}

function noteFailure(recipients, subject, err) {
  console.error(`[mail] FAILED to send "${subject}" to ${recipients.join(', ')}: ${err.message}`);
  state.lastError = { at: new Date(), message: err.message };
  try {
    audit(null, 'mail.failed', null, null, `${subject} → ${recipients.join(', ')}: ${err.message}`.slice(0, 500));
  } catch { /* the database may be the problem; the console line above is enough */ }
}

/**
 * Sends (or, without SMTP, saves to data/outbox). Resolves to true on success, false on failure; never throws.
 * opts.key: an idempotency key (e.g. "pickup:12"): a message with a key already in the outbox is not sent again.
 * opts.retry (default true): when sending fails, the message waits in the outbox and is retried by the jobs. Messages
 * with a one-time code or a password link pass retry: false: they are never stored, and expire anyway.
 */
async function send(to, subject, paragraphs, link, { attachments, key, retry = true } = {}) {
  const recipients = [].concat(to).filter(Boolean);
  if (!recipients.length) return true;
  const message = {
    html: wrap(subject, paragraphs, link),
    text: paragraphs.map((p) => p.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).join('\n\n') + (link ? `\n\n${config.baseUrl}${link.href}` : ''),
    attachments,
  };
  const keep = (status, err) => {
    if (!config.smtp || (!key && (!retry || status === 'sent'))) return; // nothing to remember
    try {
      db.prepare(`INSERT INTO mail_outbox (key, recipients, subject, message, status, attempts, next_attempt_at, last_error, created_at, sent_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`).run(key ?? null, JSON.stringify(recipients), subject,
        status === 'sent' || !retry ? '{}' : JSON.stringify(message), status, Date.now() + RETRY_MINUTES[0] * 60000,
        err ? String(err.message).slice(0, 500) : null, time.stamp(), status === 'sent' ? time.stamp() : null);
    } catch (e) {
      console.error('[mail] could not record the message in the outbox:', e.message);
    }
  };
  if (key && config.smtp && db.prepare('SELECT 1 FROM mail_outbox WHERE key = ?').get(key)) return true; // already sent or queued
  try {
    await deliver(recipients, subject, message);
    keep('sent');
    return true;
  } catch (err) {
    noteFailure(recipients, subject, err);
    keep(retry ? 'pending' : 'failed', err);
    return false;
  }
}

/**
 * Sends the outbox messages that are due (the jobs call it). Several instances may run it at once: a message is
 * taken by the run whose UPDATE changed it. A run that died while sending leaves "sending"; after 10 minutes it is due
 * again. Returns { sent, failed, waiting }.
 */
async function drainOutbox({ limit = 25 } = {}) {
  if (!config.smtp) return { sent: 0, failed: 0, waiting: 0 };
  const now = Date.now();
  db.prepare("UPDATE mail_outbox SET status = 'pending' WHERE status = 'sending' AND next_attempt_at < ?").run(now - 10 * 60000);
  const due = db.prepare("SELECT * FROM mail_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?").all(now, limit);
  let sent = 0;
  let failed = 0;
  for (const m of due) {
    if (db.prepare("UPDATE mail_outbox SET status = 'sending', next_attempt_at = ? WHERE id = ? AND status = 'pending'").run(now, m.id).changes !== 1) continue;
    const recipients = JSON.parse(m.recipients);
    try {
      await deliver(recipients, m.subject, JSON.parse(m.message));
      db.prepare("UPDATE mail_outbox SET status = 'sent', sent_at = ?, message = '{}', last_error = NULL WHERE id = ?").run(time.stamp(), m.id);
      sent += 1;
    } catch (err) {
      noteFailure(recipients, m.subject, err);
      const attempts = m.attempts + 1;
      const done = attempts >= MAX_ATTEMPTS;
      db.prepare('UPDATE mail_outbox SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?')
        .run(done ? 'failed' : 'pending', attempts, Date.now() + (RETRY_MINUTES[attempts - 1] || 0) * 60000, String(err.message).slice(0, 500), m.id);
      if (done) failed += 1;
    }
  }
  // Keep the outbox small: sent ones (their keys) for 60 days, failed ones for 90.
  db.prepare("DELETE FROM mail_outbox WHERE (status = 'sent' AND sent_at < ?) OR (status = 'failed' AND created_at < ?)")
    .run(time.stamp(new Date(now - 60 * 86400000)), time.stamp(new Date(now - 90 * 86400000)));
  return { sent, failed, waiting: db.prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE status IN ('pending','sending')").get().n };
}

/** For the settings page: how many wait, the failed ones, and when the jobs last ran. */
function outboxStatus() {
  const n = (sql) => db.prepare(sql).get().n;
  return {
    waiting: n("SELECT COUNT(*) AS n FROM mail_outbox WHERE status IN ('pending','sending')"),
    failed: db.prepare("SELECT id, recipients, subject, attempts, last_error, created_at FROM mail_outbox WHERE status = 'failed' AND message != '{}' ORDER BY id DESC LIMIT 20").all(),
  };
}

/** "Retry now": failed messages (still holding their content) go back to the queue, due at once. */
function retryFailed() {
  return db.prepare("UPDATE mail_outbox SET status = 'pending', attempts = 0, next_attempt_at = 0 WHERE status = 'failed' AND message != '{}'").run().changes;
}

/** Checks the SMTP login once at startup, so configuration problems show up in the server window. */
async function verifyTransport() {
  if (!config.smtp) {
    console.log('[mail] No SMTP_HOST set: e-mails are saved in data/outbox and login codes are printed here.');
    return;
  }
  try {
    await getTransport().verify();
    state.verified = true;
    console.log(`[mail] SMTP OK: ${config.smtp.host}:${config.smtp.port} as ${config.smtp.auth?.user || '(no login)'}`);
  } catch (err) {
    state.verified = false;
    state.lastError = { at: new Date(), message: err.message };
    console.error(`[mail] SMTP check FAILED (${config.smtp.host}:${config.smtp.port}): ${err.message}`);
  }
}

/** The newest failure: this process's, else the newest one in the audit log (another instance may have hit it). */
function lastFailure() {
  if (state.lastError) return state.lastError;
  try {
    const r = db.prepare("SELECT at, details FROM audit_log WHERE action = 'mail.failed' ORDER BY id DESC LIMIT 1").get();
    if (!r) return null;
    const at = new Date(r.at.replace(' ', 'T'));
    // An old failure from before this instance started, whose SMTP login has since checked out, is fixed.
    if (state.verified && at < startedAt) return null;
    return { at, message: r.details };
  } catch {
    return null;
  }
}

function status() {
  return {
    configured: Boolean(config.smtp),
    host: config.smtp?.host, port: config.smtp?.port, secure: config.smtp?.secure, user: config.smtp?.auth?.user,
    from: config.mailFrom, fromName: brand().mailFromName, ...state, lastError: lastFailure(),
  };
}

/**
 * What happened to a booking notification, so the screen can say so instead of assuming success.
 * `user` / `admins`: true = sent, false = sending failed, null = nobody to send to. `delivered`: false means no
 * mail server is configured, so "sent" only means saved to data/outbox.
 */
async function outcome(toUser, toAdmins) {
  const attempted = (x) => (x instanceof Promise ? x : null); // `false && send(…)` means "not sent", not "failed"
  const [user, admins] = await Promise.all([attempted(toUser), attempted(toAdmins)]);
  return { delivered: Boolean(config.smtp), user, admins };
}

/** Admin recipients for a notification; warns when there is nobody to notify. */
function adminRecipients(what) {
  const list = adminEmails();
  if (!list.length) console.warn(`[mail] No active admin to notify about ${what}`);
  return list;
}

// ---------- Calendar invite (.ics) for confirmed bookings ----------
const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsUtc = (local) => time.parse(local).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** RFC 5545 line folding: lines longer than 75 octets continue on the next line after a space. */
function icsFold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function bookingIcs(b) {
  const host = new URL(config.baseUrl).hostname;
  const car = [b.make, b.model].filter(Boolean).join(' ');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${icsText(brand().name)}//car-rental//HE`, 'METHOD:PUBLISH', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:booking-${b.id}@${host}`,
    `DTSTAMP:${icsUtc(time.now())}`,
    `DTSTART:${icsUtc(b.start_at)}`,
    `DTEND:${icsUtc(b.end_at)}`,
    `SUMMARY:${icsText(`הזמנת רכב: ${car} (${b.plate})`)}`,
    `DESCRIPTION:${icsText([b.purpose && `מטרה: ${b.purpose}`, b.instructions && `הנחיות: ${b.instructions}`, `${config.baseUrl}/me/bookings`].filter(Boolean).join('\n'))}`,
    'STATUS:CONFIRMED',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return { filename: `booking-${b.id}.ics`, content: lines.map(icsFold).join('\r\n') + '\r\n', contentType: 'text/calendar; charset=utf-8; method=PUBLISH' };
}

const adminEmails = () =>
  db.prepare("SELECT email FROM users WHERE role = 'admin' AND status = 'active'").all().map((r) => r.email);

const fullName = (u) => `${u.first_name} ${u.last_name}`;
const range = (b) => `<b>איסוף:</b> ${esc(time.fmtLong(b.start_at))}<br><b>החזרה:</b> ${esc(time.fmtLong(b.end_at))}`;
const vehicleLine = (b) => `<b>רכב:</b> ${esc([b.make, b.model].filter(Boolean).join(' '))} (${esc(b.plate)})`;

/**
 * Can an e-mail reach a person? With SMTP, yes. Without it, development still works (codes and links are printed
 * in the server window), but on a production site nobody would ever receive the message.
 */
const canDeliver = () => Boolean(config.smtp) || !config.production;

module.exports = {
  send,
  canDeliver,
  adminEmails,
  bookingIcs,
  drainOutbox,
  outboxStatus,
  retryFailed,
  verifyTransport,
  status,
  test: (to) => send(to, 'בדיקת שליחת מייל', ['זהו מייל בדיקה ממערכת הזמנת הרכב. אם קיבלת אותו, שליחת המיילים עובדת.'], null, { retry: false }),
  loginCode: (u, code) => {
    // Without a mail server nobody would ever see the code; in development print it for the operator.
    if (!config.smtp && !config.production) console.log(`\n  >>> Login code for ${u.email}: ${code}  (valid 10 minutes)\n`);
    return send(u.email, `קוד התחברות: ${code}`, [
      `קוד ההתחברות שלך: <b style="font-size:20px;letter-spacing:3px">${esc(code)}</b>`, 'הקוד תקף ל־10 דקות.',
      'אם לא ביקשת להתחבר, אפשר להתעלם מהודעה זו.',
    ], null, { retry: false });
  },
  passwordReset: (u, token) => {
    const href = `/password/reset?token=${encodeURIComponent(token)}`;
    if (!config.smtp && !config.production) console.log(`\n  >>> Password reset link for ${u.email}: ${config.baseUrl}${href}  (valid 1 hour)\n`);
    return send(u.email, 'איפוס סיסמה', [
      `שלום ${esc(u.first_name)},`, 'התקבלה בקשה לאיפוס הסיסמה שלך. הקישור תקף לשעה ולשימוש אחד בלבד.',
      'אם לא ביקשת לאפס את הסיסמה, אפשר להתעלם מהודעה זו: הסיסמה הנוכחית לא תשתנה.',
    ], { href, label: 'בחירת סיסמה חדשה' }, { retry: false });
  },
  /** An admin created the account: link to choose a password (valid 7 days). */
  invitation: (u, token, invitedBy) => {
    const href = `/password/reset?token=${encodeURIComponent(token)}`;
    if (!config.smtp && !config.production) console.log(`\n  >>> Invitation link for ${u.email}: ${config.baseUrl}${href}  (valid 7 days)\n`);
    return send(u.email, 'נפתח עבורך חשבון במערכת הזמנת הרכב', [
      `שלום ${esc(u.first_name)},`, `${esc(invitedBy)} פתח/ה עבורך חשבון במערכת הזמנת הרכב של ${esc(brand().name)}.`,
      'כדי להתחבר, בחרו סיסמה בקישור הבא. הקישור תקף ל־7 ימים ולשימוש אחד.',
      `שם המשתמש שלך הוא כתובת הדואר האלקטרוני הזו: <b dir="ltr">${esc(u.email)}</b>.`,
    ], { href, label: 'בחירת סיסמה' }, { retry: false }); // a password link: never stored in the outbox
  },
  /** A client's manager, invited from the master console: with a link to choose a password, or (an account that has
   * one already) to sign in. */
  managerInvitation: (u, token, invitedBy) => {
    const href = token ? `/password/reset?token=${encodeURIComponent(token)}` : '/login';
    if (token && !config.smtp && !config.production) console.log(`\n  >>> Manager invitation link for ${u.email}: ${config.baseUrl}${href}  (valid 7 days)\n`);
    return send(u.email, `הוזמנת לנהל את מערכת הזמנת הרכב של ${brand().name}`, [
      `שלום ${esc(u.first_name)},`, `${esc(invitedBy)} הזמין/ה אותך לנהל את מערכת הזמנת הרכב של ${esc(brand().name)}: אישור משתמשים והזמנות, הרכב, הנהלים וההגדרות.`,
      token ? 'כדי להתחבר, בחרו סיסמה בקישור הבא. הקישור תקף ל־7 ימים ולשימוש אחד.' : 'החשבון הקיים שלך קיבל הרשאות ניהול. אפשר להתחבר כרגיל.',
      `שם המשתמש שלך הוא כתובת הדואר האלקטרוני הזו: <b dir="ltr">${esc(u.email)}</b>.`,
    ], { href, label: token ? 'בחירת סיסמה' : 'כניסה למערכת' }, { retry: !token }); // with a password link: never stored
  },
  /** An admin set a new password for the account (the password itself is never e-mailed). */
  passwordSetByAdmin: (u) => send(u.email, 'נקבעה לחשבון שלך סיסמה חדשה', [
    `שלום ${esc(u.first_name)},`, `מנהל/ת המערכת קבע/ה סיסמה חדשה לחשבון שלך ב${esc(brand().name)}, וכל החיבורים הפעילים נותקו.`,
    'את הסיסמה החדשה תקבל/י ממנו/ממנה ישירות. אחרי ההתחברות מומלץ להחליף אותה בסיסמה משלך.',
    'אם לא ביקשת זאת, פנה/י למנהל/ת המערכת.',
  ], { href: '/login', label: 'להתחברות' }),
  passwordChanged: (u) => send(u.email, 'הסיסמה שלך שונתה', [
    `שלום ${esc(u.first_name)},`, 'הסיסמה לחשבון שלך שונתה, וכל החיבורים הפעילים נותקו.',
    'אם לא אתה שינית אותה, פנה מיד למנהל המערכת.',
  ], { href: '/login', label: 'להתחברות' }),
  newRegistration: (u) => send(adminEmails(), 'משתמש חדש ממתין לאישור', [
    `${esc(fullName(u))} נרשם/ה למערכת וממתין/ה לבדיקת פרטים ורישיון נהיגה.`,
  ], { href: `/admin/users/${u.id}`, label: 'לבדיקת המשתמש' }),
  newLicenseUploaded: (u) => send(adminEmails(), 'רישיון נהיגה חדש ממתין לבדיקה', [
    `${esc(fullName(u))} העלה/תה רישיון נהיגה חדש.`,
  ], { href: `/admin/users/${u.id}`, label: 'לבדיקת הרישיון' }),
  userApproved: (u) => send(u.email, 'החשבון שלך אושר', [
    `שלום ${esc(u.first_name)},`, 'החשבון שלך אושר ומעכשיו ניתן להזמין את הרכב דרך המערכת.',
  ], { href: '/calendar', label: 'ליומן הרכב' }),
  userRejected: (u, note) => send(u.email, 'עדכון לגבי בקשת ההרשמה', [
    `שלום ${esc(u.first_name)},`, 'לצערנו בקשת ההרשמה שלך לא אושרה.', note ? `הערת המנהל: ${esc(note)}` : '',
  ].filter(Boolean)),
  userBlocked: (u, note) => send(u.email, 'החשבון שלך הושהה', [
    `שלום ${esc(u.first_name)},`, 'החשבון שלך הושהה ולא ניתן לבצע הזמנות חדשות. לפרטים ניתן לפנות למנהל.',
    note ? `הערת המנהל: ${esc(note)}` : '',
  ].filter(Boolean)),
  roleChanged: (u, isAdmin) => send(u.email, isAdmin ? 'קיבלת הרשאות מנהל' : 'הרשאות המנהל שלך הוסרו', [
    `שלום ${esc(u.first_name)},`,
    isAdmin
      ? 'מעכשיו יש לך גישה לממשק הניהול: אישור משתמשים והזמנות, ניהול הרכב, הנהלים וההגדרות.'
      : 'החשבון שלך חזר להיות חשבון משתמש רגיל, ללא גישה לממשק הניהול.',
  ], isAdmin ? { href: '/admin', label: 'לממשק הניהול' } : null),
  licenseRequested: (u, note) => send(u.email, 'נדרש עדכון רישיון נהיגה', [
    `שלום ${esc(u.first_name)},`, 'יש להעלות צילום עדכני של רישיון הנהיגה כדי להמשיך להזמין את הרכב.',
    note ? `הערת המנהל: ${esc(note)}` : '',
  ].filter(Boolean), { href: '/me/license', label: 'להעלאת רישיון' }),
  licenseExpiring: (u) => send(u.email, 'רישיון הנהיגה שלך עומד לפוג', [
    `שלום ${esc(u.first_name)},`, `תוקף רישיון הנהיגה שלך יפוג ב־${esc(time.fmt(u.license_expiry))}.`,
    'לאחר חידוש הרישיון יש להעלות צילום עדכני כדי להמשיך להזמין את הרכב.',
  ], { href: '/me/license', label: 'להעלאת רישיון' }),
  licensesExpiredAdmin: (users) => send(adminEmails(), 'רישיונות נהיגה שפג תוקפם', [
    'תוקף הרישיונות של המשתמשים הבאים פג והם הועברו לסטטוס "ממתין לעדכון רישיון":',
    users.map((u) => `${esc(fullName(u))} – ${esc(time.fmt(u.license_expiry))}`).join('<br>'),
  ], { href: '/admin/users?status=license_update', label: 'לרשימת המשתמשים' }),
  /** Receipt to the user and a pending-approval notice to all active admins. Resolves to an outcome(). */
  bookingRequested: (b) => {
    const admins = adminRecipients(`booking request #${b.id}`);
    return outcome(send(b.email, 'בקשת ההזמנה התקבלה', [
      `שלום ${esc(b.first_name)},`, 'בקשת ההזמנה התקבלה וממתינה לאישור המנהל. <b>ההזמנה אינה סופית עד לקבלת אישור.</b>', range(b),
    ], { href: '/me/bookings', label: 'להזמנות שלי' }),
    admins.length && send(admins, 'בקשת הזמנה חדשה ממתינה לאישור', [
      `${esc(fullName(b))} ביקש/ה את הרכב. הבקשה ממתינה לאישור מנהל:`, vehicleLine(b), range(b),
      b.purpose ? `<b>מטרה:</b> ${esc(b.purpose)}` : '',
    ].filter(Boolean), { href: `/admin/bookings/${b.id}`, label: 'לטיפול בבקשה' }));
  },
  /**
   * Final confirmation: to the user (unless notifyUser is false) and to all admins, each with a calendar invite.
   * Resolves to an outcome().
   */
  bookingApproved: (b, { approvedBy, notifyUser = true } = {}) => {
    const admins = adminRecipients(`approved booking #${b.id}`);
    return outcome(notifyUser && b.email && send(b.email, 'ההזמנה אושרה', [
      `שלום ${esc(b.first_name)},`, 'הזמנת הרכב שלך <b>אושרה סופית</b>.', vehicleLine(b), range(b),
      b.purpose ? `<b>מטרה:</b> ${esc(b.purpose)}` : '',
      b.instructions ? `<b>הנחיות:</b><br>${esc(b.instructions).replace(/\n/g, '<br>')}` : '',
      'יש להחזיר את הרכב בזמן ובהתאם לנהלי ההשאלה. מצורף זימון ליומן.',
    ].filter(Boolean), { href: '/me/bookings', label: 'להזמנות שלי' }, { attachments: [bookingIcs(b)] }),
    admins.length && send(admins, `אישור הזמנה: ${fullName(b)}`, [
      `ההזמנה של <b>${esc(fullName(b))}</b> אושרה${approvedBy ? ` על ידי ${esc(approvedBy)}` : ''}.`,
      vehicleLine(b), range(b),
      `<b>טלפון:</b> ${esc(b.phone)} · <b>דוא"ל:</b> ${esc(b.email)}`,
      b.purpose ? `<b>מטרה:</b> ${esc(b.purpose)}` : '',
      notifyUser ? 'נשלח מייל אישור למשתמש.' : 'לא נשלח מייל למשתמש.',
    ].filter(Boolean), { href: `/admin/bookings/${b.id}`, label: 'לפרטי ההזמנה' }, { attachments: [bookingIcs(b)] }));
  },
  bookingRejected: (b, note) => send(b.email, 'בקשת ההזמנה לא אושרה', [
    `שלום ${esc(b.first_name)},`, 'בקשת ההזמנה הבאה לא אושרה:', range(b), note ? `הערת המנהל: ${esc(note)}` : '',
  ].filter(Boolean), { href: '/calendar', label: 'לבחירת מועד אחר' }),
  bookingCancelled: (b, byAdmin, note) => Promise.all([
    b.email && send(b.email, 'הזמנה בוטלה', [
      `שלום ${esc(b.first_name)},`, byAdmin ? 'ההזמנה הבאה בוטלה על ידי המנהל:' : 'ההזמנה הבאה בוטלה לבקשתך:', range(b),
      note ? `הערה: ${esc(note)}` : '',
    ].filter(Boolean)),
    send(adminEmails(), 'הזמנה בוטלה', [
      `ההזמנה של ${esc(fullName(b))} בוטלה${byAdmin ? ' על ידי מנהל' : ' על ידי המשתמש'}.`, range(b),
    ], { href: `/admin/bookings/${b.id}`, label: 'לפרטי ההזמנה' }),
  ]),
  // Reminders carry a key: sent once per booking (and time), even if two job runs overlap or one is retried.
  pickupReminder: (b) => send(b.email, 'תזכורת: איסוף הרכב מתקרב', [
    `שלום ${esc(b.first_name)},`, 'תזכורת להזמנת הרכב שלך:', vehicleLine(b), range(b),
  ], { href: '/me/bookings', label: 'להזמנות שלי' }, { key: `pickup:${b.id}:${b.start_at}` }),
  returnReminder: (b) => send(b.email, 'תזכורת: מועד החזרת הרכב מתקרב', [
    `שלום ${esc(b.first_name)},`, `יש להחזיר את הרכב עד <b>${esc(time.fmtLong(b.end_at))}</b>.`,
  ], null, { key: `return:${b.id}:${b.end_at}` }),
  pendingTooLong: (list, { again = false } = {}) => send(adminEmails(), again ? 'תזכורת: בקשות הזמנה עדיין לא טופלו' : 'בקשות הזמנה ממתינות זמן רב', [
    again ? 'הבקשות הבאות עדיין ממתינות, גם אחרי התזכורת הקודמת. המבקשים לא יודעים אם יקבלו את הרכב:' : 'הבקשות הבאות ממתינות לאישור זמן רב:',
    list.map((b) => `${esc(fullName(b))} – ${esc(time.fmt(b.start_at))}`).join('<br>'),
  ], { href: '/admin/bookings?status=pending', label: 'לבקשות הממתינות' }),
};

// ---------- Phone notifications next to the e-mails (src/push.js) ----------
// The same moments, a shorter text. Sent alongside, never instead: a phone without notifications still gets the e-mail.
const push = require('./push');
const when = (b) => `${time.fmt(b.start_at)} – ${time.fmt(b.end_at)}`;
const PUSH = {
  userApproved: (u) => push.notify(u.id, { title: 'החשבון שלך אושר', body: 'מעכשיו אפשר להזמין את הרכב.', url: '/calendar', tag: 'account' }),
  licenseRequested: (u) => push.notify(u.id, { title: 'נדרש רישיון נהיגה עדכני', body: 'יש להעלות צילום עדכני כדי להמשיך להזמין.', url: '/me/license', tag: 'license' }),
  newRegistration: (u) => push.notify(push.adminIds(), { title: 'משתמש חדש ממתין לאישור', body: fullName(u), url: `/admin/users/${u.id}`, tag: `user-${u.id}` }),
  bookingRequested: (b) => push.notify(push.adminIds(), { title: 'בקשת הזמנה חדשה', body: `${fullName(b)} · ${when(b)}`, url: `/admin/bookings/${b.id}`, tag: `booking-${b.id}` }),
  bookingApproved: (b, { notifyUser = true } = {}) => notifyUser
    && push.notify(b.user_id, { title: 'ההזמנה אושרה ✓', body: when(b), url: '/me/bookings', tag: `booking-${b.id}` }),
  bookingRejected: (b) => push.notify(b.user_id, { title: 'בקשת ההזמנה לא אושרה', body: when(b), url: '/calendar', tag: `booking-${b.id}` }),
  bookingCancelled: (b, byAdmin) => byAdmin
    && push.notify(b.user_id, { title: 'ההזמנה בוטלה על ידי המנהל', body: when(b), url: '/me/bookings', tag: `booking-${b.id}` }),
  pickupReminder: (b) => push.notify(b.user_id, { title: 'תזכורת: איסוף הרכב מתקרב', body: when(b), url: '/me/bookings', tag: `pickup-${b.id}`, urgent: true }),
  returnReminder: (b) => push.notify(b.user_id, { title: 'תזכורת: החזרת הרכב', body: `יש להחזיר את הרכב עד ${time.fmtLong(b.end_at)}`, url: '/me/bookings', tag: `return-${b.id}`, urgent: true }),
  pendingTooLong: (list, { again = false } = {}) => push.notify(push.adminIds(), {
    title: again ? 'בקשות הזמנה עדיין לא טופלו' : 'בקשות הזמנה ממתינות זמן רב', body: `${list.length} בקשות ממתינות לאישור`, url: '/admin/bookings?status=pending', tag: 'pending',
  }),
};
for (const [name, fn] of Object.entries(PUSH)) {
  const mailFn = module.exports[name];
  // The e-mail's result is what callers use; the notification goes alongside and never fails the e-mail.
  module.exports[name] = (...args) => Promise.all([mailFn(...args), Promise.resolve().then(() => fn(...args)).catch((err) => console.error(`[push] ${name}:`, err.message))])
    .then(([mailResult]) => mailResult);
}
