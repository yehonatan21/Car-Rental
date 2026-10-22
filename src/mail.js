'use strict';
// Outgoing e-mail. With SMTP_* configured mail is sent; otherwise each message is written to data/outbox
// so the flows can be tested locally.
const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');
const config = require('./config');
const { db } = require('./db');
const time = require('./time');

const transport = config.smtp
  ? nodemailer.createTransport(config.smtp)
  : nodemailer.createTransport({ streamTransport: true, buffer: true });

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

async function send(to, subject, paragraphs, link) {
  const recipients = [].concat(to).filter(Boolean);
  if (!recipients.length) return;
  const html = wrap(subject, paragraphs, link);
  const text = paragraphs.map((p) => p.replace(/<[^>]+>/g, '')).join('\n\n') + (link ? `\n\n${config.baseUrl}${link.href}` : '');
  try {
    const info = await transport.sendMail({ from: config.mailFrom, to: recipients.join(', '), subject, html, text });
    if (!config.smtp) {
      fs.mkdirSync(config.outboxDir, { recursive: true });
      const file = path.join(config.outboxDir, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.eml`);
      fs.writeFileSync(file, info.message);
      console.log(`[mail] ${subject} → ${recipients.join(', ')} (saved to ${path.basename(file)})`);
    }
  } catch (err) {
    console.error('[mail] failed to send', subject, err.message);
  }
}

const adminEmails = () =>
  db.prepare("SELECT email FROM users WHERE role = 'admin' AND status = 'active'").all().map((r) => r.email);

const fullName = (u) => `${u.first_name} ${u.last_name}`;
const range = (b) => `<b>איסוף:</b> ${esc(time.fmtLong(b.start_at))}<br><b>החזרה:</b> ${esc(time.fmtLong(b.end_at))}`;
const vehicleLine = (b) => `<b>רכב:</b> ${esc([b.make, b.model].filter(Boolean).join(' '))} (${esc(b.plate)})`;

module.exports = {
  send,
  loginCode: (u, code) => send(u.email, 'קוד התחברות', [
    `קוד ההתחברות שלך: <b style="font-size:20px;letter-spacing:3px">${esc(code)}</b>`, 'הקוד תקף ל־10 דקות.',
  ]),
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
  bookingApproved: (b) => send(b.email, 'ההזמנה אושרה', [
    `שלום ${esc(b.first_name)},`, 'הזמנת הרכב שלך <b>אושרה סופית</b>.', vehicleLine(b), range(b),
    b.instructions ? `<b>הנחיות:</b><br>${esc(b.instructions).replace(/\n/g, '<br>')}` : '',
    'יש להחזיר את הרכב בזמן ובהתאם לנהלי ההשאלה.',
  ].filter(Boolean), { href: '/me/bookings', label: 'להזמנות שלי' }),
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
