'use strict';
// Outgoing e-mail. With SMTP_* configured mail is sent; otherwise each message is written to data/outbox
// so the flows can be tested locally.
const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');
const config = require('./config');
const { db } = require('./db');
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
  const body = paragraphs.map((p) => `<p style="margin:0 0 12px">${p}</p>`).join('');
  const button = link
    ? `<p><a href="${esc(config.baseUrl + link.href)}" style="display:inline-block;background:#1f5f8b;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${esc(link.label)}</a></p>`
    : '';
  return `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
<h2 style="color:#1f5f8b">${esc(title)}</h2>${body}${button}
<p style="color:#888;font-size:12px;margin-top:24px">${esc(config.appName)} – הודעה אוטומטית</p></div>`;
}

// Delivery status for the admin settings page.
const state = { lastError: null, lastSentAt: null, verified: null };

/** Sends (or, without SMTP, saves to data/outbox). Resolves to true on success, false on failure; never throws. */
async function send(to, subject, paragraphs, link, { attachments } = {}) {
  const recipients = [].concat(to).filter(Boolean);
  if (!recipients.length) return true;
  const html = wrap(subject, paragraphs, link);
  const text = paragraphs.map((p) => p.replace(/<[^>]+>/g, '')).join('\n\n') + (link ? `\n\n${config.baseUrl}${link.href}` : '');
  try {
    const info = await getTransport().sendMail({ from: config.mailFrom, to: recipients.join(', '), subject, html, text, attachments });
    if (!config.smtp) {
      fs.mkdirSync(config.outboxDir, { recursive: true });
      const file = path.join(config.outboxDir, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.eml`);
      fs.writeFileSync(file, info.message);
      console.log(`[mail] ${subject} → ${recipients.join(', ')} (saved to ${path.basename(file)})`);
    }
    state.lastSentAt = new Date();
    return true;
  } catch (err) {
    console.error(`[mail] FAILED to send "${subject}" to ${recipients.join(', ')}: ${err.message}`);
    state.lastError = { at: new Date(), message: err.message };
    return false;
  }
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

function status() {
  return {
    configured: Boolean(config.smtp),
    host: config.smtp?.host, port: config.smtp?.port, secure: config.smtp?.secure, user: config.smtp?.auth?.user,
    from: config.mailFrom, ...state,
  };
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
    'BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${icsText(config.appName)}//car-rental//HE`, 'METHOD:PUBLISH', 'CALSCALE:GREGORIAN',
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

module.exports = {
  send,
  bookingIcs,
  verifyTransport,
  status,
  test: (to) => send(to, 'בדיקת שליחת מייל', ['זהו מייל בדיקה ממערכת הזמנת הרכב. אם קיבלת אותו, שליחת המיילים עובדת.']),
  loginCode: (u, code) => {
    // Without a mail server nobody would ever see the code; in development print it for the operator.
    if (!config.smtp && !config.production) console.log(`\n  >>> Login code for ${u.email}: ${code}  (valid 10 minutes)\n`);
    return send(u.email, `קוד התחברות: ${code}`, [
      `קוד ההתחברות שלך: <b style="font-size:20px;letter-spacing:3px">${esc(code)}</b>`, 'הקוד תקף ל־10 דקות.',
      'אם לא ביקשת להתחבר, אפשר להתעלם מהודעה זו.',
    ]);
  },
  passwordReset: (u, token) => {
    const href = `/password/reset?token=${encodeURIComponent(token)}`;
    if (!config.smtp && !config.production) console.log(`\n  >>> Password reset link for ${u.email}: ${config.baseUrl}${href}  (valid 1 hour)\n`);
    return send(u.email, 'איפוס סיסמה', [
      `שלום ${esc(u.first_name)},`, 'התקבלה בקשה לאיפוס הסיסמה שלך. הקישור תקף לשעה ולשימוש אחד בלבד.',
      'אם לא ביקשת לאפס את הסיסמה, אפשר להתעלם מהודעה זו: הסיסמה הנוכחית לא תשתנה.',
    ], { href, label: 'בחירת סיסמה חדשה' });
  },
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
      ? 'מעכשיו יש לך גישה לממשק הניהול: אישור משתמשים והזמנות, ניהול הרכב, הנהלים וההגדרות. מומלץ להפעיל אימות דו־שלבי לחשבון.'
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
  bookingRequested: (b) => Promise.all([
    send(b.email, 'בקשת ההזמנה התקבלה', [
      `שלום ${esc(b.first_name)},`, 'בקשת ההזמנה התקבלה וממתינה לאישור המנהל. <b>ההזמנה אינה סופית עד לקבלת אישור.</b>', range(b),
    ], { href: '/me/bookings', label: 'להזמנות שלי' }),
    send(adminEmails(), 'בקשת הזמנה חדשה ממתינה לאישור', [
      `${esc(fullName(b))} ביקש/ה את הרכב:`, range(b), b.purpose ? `<b>מטרה:</b> ${esc(b.purpose)}` : '',
    ].filter(Boolean), { href: `/admin/bookings/${b.id}`, label: 'לטיפול בבקשה' }),
  ]),
  /** Final confirmation: to the user (unless notifyUser is false) and to all admins, each with a calendar invite. */
  bookingApproved: (b, { approvedBy, notifyUser = true } = {}) => Promise.all([
    notifyUser && send(b.email, 'ההזמנה אושרה', [
      `שלום ${esc(b.first_name)},`, 'הזמנת הרכב שלך <b>אושרה סופית</b>.', vehicleLine(b), range(b),
      b.purpose ? `<b>מטרה:</b> ${esc(b.purpose)}` : '',
      b.instructions ? `<b>הנחיות:</b><br>${esc(b.instructions).replace(/\n/g, '<br>')}` : '',
      'יש להחזיר את הרכב בזמן ובהתאם לנהלי ההשאלה. מצורף זימון ליומן.',
    ].filter(Boolean), { href: '/me/bookings', label: 'להזמנות שלי' }, { attachments: [bookingIcs(b)] }),
    send(adminEmails(), `אישור הזמנה: ${fullName(b)}`, [
      `ההזמנה של <b>${esc(fullName(b))}</b> אושרה${approvedBy ? ` על ידי ${esc(approvedBy)}` : ''}.`,
      vehicleLine(b), range(b),
      `<b>טלפון:</b> ${esc(b.phone)} · <b>דוא"ל:</b> ${esc(b.email)}`,
      b.purpose ? `<b>מטרה:</b> ${esc(b.purpose)}` : '',
      notifyUser ? 'נשלח מייל אישור למשתמש.' : 'לא נשלח מייל למשתמש.',
    ].filter(Boolean), { href: `/admin/bookings/${b.id}`, label: 'לפרטי ההזמנה' }, { attachments: [bookingIcs(b)] }),
  ]),
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
  pickupReminder: (b) => send(b.email, 'תזכורת: איסוף הרכב מתקרב', [
    `שלום ${esc(b.first_name)},`, 'תזכורת להזמנת הרכב שלך:', vehicleLine(b), range(b),
  ], { href: '/me/bookings', label: 'להזמנות שלי' }),
  returnReminder: (b) => send(b.email, 'תזכורת: מועד החזרת הרכב מתקרב', [
    `שלום ${esc(b.first_name)},`, `יש להחזיר את הרכב עד <b>${esc(time.fmtLong(b.end_at))}</b>.`,
  ]),
  pendingTooLong: (list) => send(adminEmails(), 'בקשות הזמנה ממתינות זמן רב', [
    'הבקשות הבאות ממתינות לאישור זמן רב:',
    list.map((b) => `${esc(fullName(b))} – ${esc(time.fmt(b.start_at))}`).join('<br>'),
  ], { href: '/admin/bookings?status=pending', label: 'לבקשות הממתינות' }),
};
