'use strict';
const { db, audit, currentPolicy, userAcceptedPolicy, getSettings, defaultVehicle } = require('../db');
const auth = require('../auth');
const { passwordProblem } = require('../passwords');
const mail = require('../mail');
const time = require('../time');
const bookings = require('../bookings');
const storage = require('../storage');
const { renderCalendar, windowFor } = require('../views/calendar');
const { later } = require('../later');
const { html, markdown, postForm, actionButton, decisionButtons, field, fieldError, errorSummary, badge, icon, pageHead, licenseInput, uploadLimitLabel, USER_STATUS } = require('../views/html');
const { normalizePhone, validPhone, safeNext, passkeyPage } = require('./public');
const passkeys = require('../passkeys');
const config = require('../config');

const STATUS_HELP = {
  pending: 'החשבון ממתין לבדיקת המנהל. תישלח הודעה בדואר האלקטרוני לאחר האישור.',
  active: 'החשבון פעיל וניתן להזמין את הרכב.',
  license_update: 'יש להעלות צילום עדכני של רישיון הנהיגה. לאחר אישור המנהל ניתן יהיה להזמין שוב.',
  blocked: 'החשבון חסום להזמנות. לפרטים יש לפנות למנהל.',
  rejected: 'בקשת ההרשמה לא אושרה. לפרטים יש לפנות למנהל.',
};

const bookingBadge = (status) => badge(status, bookings.STATUS_LABELS[status]);

function bookingRow(req, b, { showCancel }) {
  const s = getSettings();
  const lateApproved = b.status === 'approved' && time.hoursBetween(time.now(), b.start_at) < s.cancel_hours_before;
  return html`<tr id="b-${b.id}">
    <td data-label="איסוף">${time.fmt(b.start_at)}</td>
    <td data-label="החזרה">${time.fmt(b.end_at)}</td>
    <td data-label="מטרה">${b.purpose || '—'}</td>
    <td data-label="סטטוס">${bookingBadge(b.status)}</td>
    <td data-label="">${showCancel && ['pending', 'approved'].includes(b.status)
      ? (lateApproved
        ? html`<small class="muted">ביטול דרך המנהל בלבד</small>`
        : actionButton(req, `/me/bookings/${b.id}/cancel`, 'ביטול ההזמנה', { cls: 'btn-danger btn-sm', confirm: `לבטל את ההזמנה של ${time.fmt(b.start_at)}?` }))
      : ''}</td>
  </tr>`;
}

const bookingTable = (req, list, opts) => list.length
  ? html`<table class="table"><thead><tr><th>איסוף</th><th>החזרה</th><th>מטרה</th><th>סטטוס</th><th><span class="sr-only">פעולות</span></th></tr></thead>
      <tbody>${list.map((b) => bookingRow(req, b, opts))}</tbody></table>`
  : html`<p class="empty">${icon('calendar', 28)}<span>אין הזמנות להצגה.</span></p>`;

function upcomingFor(userId) {
  return db.prepare(`SELECT * FROM bookings WHERE user_id = ? AND kind = 'booking' AND end_at > ?
    AND status IN ('pending','approved') ORDER BY start_at`).all(userId, time.now());
}

/** Is this person one of the console's admins (the console requires them to have a passkey)? */
const consoleAdmin = (u) => u.role === 'admin' && (config.master
  || (config.masterConsole && String(u.email).toLowerCase() === require('../bootstrap').mainAdminEmail()));

module.exports = ({ app, requireLogin, requireRecentAuth, licenseUpload }) => {
  app.get('/me', requireLogin, (req, res) => {
    const u = req.user;
    const upcoming = upcomingFor(u.id);
    const needsPolicy = !userAcceptedPolicy(u.id);
    // The next booking comes first, with what can be done about it (U-9).
    const next = upcoming[0];
    const cancellable = next && (next.status === 'pending'
      || (next.status === 'approved' && time.hoursBetween(time.now(), next.start_at) >= getSettings().cancel_hours_before));
    res.page('אזור אישי', html`
${pageHead(`שלום ${u.first_name}`, { iconName: 'user', sub: 'האזור האישי שלך: סטטוס החשבון, ההזמנות והפרטים.' })}
<div class="card status-card status-${u.status}">
  <div>סטטוס החשבון: ${badge(u.status, USER_STATUS[u.status])}</div>
  <p>${STATUS_HELP[u.status]}</p>
  ${u.pending_license_file ? (u.role === 'admin'
    ? html`<p class="note-line">${icon('id', 18)} העלית רישיון חדש. <a href="/admin/users/${u.id}#license">לאישור הרישיון שלך</a></p>`
    : html`<p class="note-line">${icon('clock', 18)} רישיון חדש שהעלית ממתין לבדיקת המנהל.</p>`) : ''}
  ${u.role === 'admin' && !u.license_verified && !u.pending_license_file
    ? html`<p class="note-line">${icon('car', 18)} כדי להזמין את הרכב גם מנהל צריך רישיון נהיגה מאושר: <a href="/me/license">העלאת רישיון</a> ואז אישור בכרטיס שלך.</p>` : ''}
  ${needsPolicy ? html`<p class="note-line">${icon('alert', 18)} נהלי השאלת הרכב עודכנו. <a href="/policy/accept">יש לקרוא ולאשר אותם</a> לפני הזמנה נוספת.</p>` : ''}
  ${u.status === 'license_update' && !u.pending_license_file ? html`<a class="btn btn-primary" href="/me/license">${icon('id')} העלאת רישיון</a>` : ''}
</div>

${next ? html`<section class="card next-booking">
  <h2 class="section-title">${icon('calendar')} ההזמנה הבאה שלך</h2>
  <div class="next-when"><span class="date-chip"><b>${time.fmt(next.start_at).slice(0, 5)}</b><small>${time.HE_DAYS[time.parse(next.start_at).getDay()]}</small></span>
    <div><b class="next-time">${time.fmt(next.start_at).slice(11)} – ${next.end_at.slice(0, 10) === next.start_at.slice(0, 10) ? time.fmt(next.end_at).slice(11) : time.fmt(next.end_at)}</b>
      <div class="muted small">${next.purpose || 'ללא מטרה'}</div></div>
    ${bookingBadge(next.status)}</div>
  ${next.status === 'pending' ? html`<p class="muted small">הבקשה ממתינה לאישור המנהל. תישלח הודעה במייל כשתאושר.</p>` : ''}
  <div class="kv-inline"><a class="btn btn-light btn-sm" href="/me/bookings#b-${next.id}">פרטים</a>
    ${cancellable ? postForm(req, `/me/bookings/${next.id}/cancel`, html`<button class="btn btn-danger btn-sm" data-confirm="לבטל את ההזמנה של ${time.fmt(next.start_at)}?">ביטול ההזמנה</button>`, 'class="inline"') : ''}</div>
</section>` : ''}

<nav class="quick" aria-label="פעולות מהירות">
  ${u.status === 'active' && !needsPolicy ? html`<a class="in-tabbar" href="/bookings/new">${icon('plus')}הזמנה חדשה<small>בחירת מועד ושליחת בקשה</small></a>` : ''}
  <a class="in-tabbar" href="/calendar">${icon('calendar')}יומן הרכב<small>מתי הרכב פנוי</small></a>
  <a class="in-tabbar" href="/me/bookings">${icon('list')}ההזמנות שלי<small>עתידיות והיסטוריה</small></a>
  <a href="/me/license">${icon('id')}רישיון נהיגה<small>תוקף והעלאת רישיון חדש</small></a>
  <a href="/me/security">${icon('lock')}סיסמה ואבטחה<small>שינוי סיסמה</small></a>
  ${u.status === 'active' && require('./documents').visibleDocumentCount(defaultVehicle().id)
    ? html`<a href="/vehicle/documents">${icon('file')}מסמכי הרכב<small>רישיון רכב וביטוח</small></a>` : ''}
</nav>

<div class="grid2">
  <section class="card">
    <h2 class="section-title">${icon('clock')} ${next ? 'הזמנות נוספות' : 'ההזמנות הקרובות'}</h2>
    ${upcoming.length > 1 || (!next && upcoming.length) ? html`<ul class="plain upcoming">${upcoming.slice(next ? 1 : 0).map((b) => html`<li>
      <span class="date-chip"><b>${time.fmt(b.start_at).slice(0, 5)}</b><small>${time.HE_DAYS[time.parse(b.start_at).getDay()]}</small></span>
      <span class="when">${time.fmt(b.start_at).slice(11)} – ${time.fmt(b.end_at)}<br><small class="muted">${b.purpose || 'ללא מטרה'}</small></span>
      ${bookingBadge(b.status)}</li>`)}</ul>`
      : html`<p class="empty">${icon('calendar', 28)}<span>${next ? 'אין הזמנות נוספות.' : 'אין הזמנות קרובות.'}</span></p>`}
    <a href="/me/bookings">לכל ההזמנות</a>
  </section>
  <section class="card">
    <h2 class="section-title">${icon('id')} הפרטים שלי</h2>
    <dl class="dl">
      <dt>שם</dt><dd>${u.first_name} ${u.last_name}</dd>
      <dt>ת"ז</dt><dd>${u.id_number}</dd>
      <dt>דואר אלקטרוני</dt><dd>${u.email}</dd>
      <dt>תוקף רישיון</dt><dd>${time.fmt(u.license_expiry)} ${u.license_verified ? badge('active', 'אומת') : badge('pending', 'טרם אומת')}</dd>
    </dl>
    ${postForm(req, '/me/profile', html`
      ${field('טלפון נייד', html`<input type="tel" name="phone" value="${u.phone}" required autocomplete="tel">`)}
      <button class="btn btn-light">עדכון טלפון</button>`)}
    <p class="muted small">לשינוי שם, תעודת זהות או דואר אלקטרוני יש לפנות למנהל.</p>
    <p class="small"><a href="/me/license">עדכון רישיון נהיגה</a> · <a href="/me/security">סיסמה ואבטחה</a> · <a href="/policy">נהלי השאלה</a></p>
  </section>
</div>`);
  });

  app.post('/me/profile', requireLogin, (req, res) => {
    const phone = normalizePhone(req.body.phone);
    if (!validPhone(phone)) {
      res.flash('error', 'מספר הטלפון אינו תקין');
    } else {
      db.prepare('UPDATE users SET phone = ?, updated_at = ? WHERE id = ?').run(phone, time.stamp(), req.user.id);
      res.flash('success', 'הפרטים עודכנו');
    }
    res.redirect('/me');
  });

  app.get('/me/license', requireLogin, (req, res) => {
    const u = req.user;
    res.page('רישיון נהיגה', html`
<div class="narrow">
  ${pageHead('רישיון נהיגה', { iconName: 'id', sub: 'רישיון בתוקף ומאושר נדרש כדי להזמין את הרכב.' })}
  <div class="card status-card status-${u.license_verified ? 'active' : 'pending'}">
    <p class="kv-inline">תוקף הרישיון הנוכחי: <b>${time.fmt(u.license_expiry) || '—'}</b>
      ${u.license_verified ? badge('active', 'אומת') : badge('pending', 'טרם אומת')}</p>
    ${u.pending_license_file ? html`<p class="note-line">${icon('clock', 18)} רישיון חדש (בתוקף עד ${time.fmt(u.pending_license_expiry)}) ממתין לבדיקת המנהל. העלאה נוספת תחליף אותו.</p>` : ''}
  </div>
  ${postForm(req, '/me/license', html`
    <h2 class="section-title">${icon('file')} העלאת רישיון חדש</h2>
    ${field('צילום רישיון נהיגה', licenseInput(), `תמונה או PDF, עד ${uploadLimitLabel()} (תמונה גדולה מוקטנת אוטומטית)`)}
    ${field('תאריך פקיעת תוקף', html`<input type="date" name="license_expiry" required min="${time.today()}">`)}
    <button class="btn btn-primary btn-block">שליחה לבדיקה</button>
    <p class="muted small">הרישיון הקיים ימשיך לשמש עד לאישור החדש.</p>`, 'enctype="multipart/form-data" class="card"')}
</div>`);
  });

  app.post('/me/license', requireLogin, licenseUpload, async (req, res) => {
    const expiry = String(req.body.license_expiry || '');
    if (!req.file || !time.isValidDate(expiry) || expiry < time.today()) {
      storage.discard(req.file);
      res.flash('error', 'יש להעלות קובץ תמונה או PDF ולהזין תאריך תוקף עתידי');
      return res.redirect('/me/license');
    }
    const u = req.user;
    storage.remove(u.pending_license_file);
    storage.keep(req.file);
    db.prepare('UPDATE users SET pending_license_file = ?, pending_license_expiry = ?, updated_at = ? WHERE id = ?')
      .run(req.file.filename, expiry, time.stamp(), u.id);
    audit(u.id, 'user.license_upload', 'user', u.id, expiry);
    await mail.newLicenseUploaded(u);
    if (u.role === 'admin') {
      res.flash('success', 'הרישיון הועלה. כמנהל, אפשר לאשר אותו כאן.');
      return res.redirect(`/admin/users/${u.id}#license`);
    }
    res.flash('success', 'הרישיון נשלח לבדיקת המנהל');
    res.redirect('/me');
  });

  app.get('/me/bookings', requireLogin, (req, res) => {
    const now = time.now();
    const all = db.prepare("SELECT * FROM bookings WHERE user_id = ? AND kind = 'booking' ORDER BY start_at DESC").all(req.user.id);
    const future = all.filter((b) => b.end_at > now && ['pending', 'approved'].includes(b.status)).reverse();
    const past = all.filter((b) => !future.includes(b));
    const s = getSettings();
    res.page('ההזמנות שלי', html`
${pageHead('ההזמנות שלי', {
    iconName: 'list', sub: 'בקשות פעילות, הזמנות מאושרות והיסטוריה.',
    actions: html`<a class="btn btn-primary" href="/bookings/new">${icon('plus')} הזמנה חדשה</a>`,
  })}
<section class="card">
  <h2 class="section-title">${icon('calendar')} הזמנות עתידיות</h2>
  ${bookingTable(req, future, { showCancel: true })}
  <p class="muted small">ניתן לבטל בקשה שממתינה לאישור בכל עת, והזמנה מאושרת עד ${s.cancel_hours_before} שעות לפני תחילתה.</p>
</section>
<section class="card">
  <h2 class="section-title">${icon('clock')} היסטוריית הזמנות</h2>
  ${bookingTable(req, past, { showCancel: false })}
</section>`);
  });

  app.post('/me/bookings/:id/cancel', requireLogin, async (req, res) => {
    try {
      const b = bookings.cancel(Number(req.params.id), req.user);
      await later(() => mail.bookingCancelled(b, false), 'cancellation e-mails');
      res.flash('success', 'ההזמנה בוטלה');
    } catch (err) {
      if (!(err instanceof bookings.BookingError)) throw err;
      res.flash('error', err.message);
    }
    res.redirect('/me/bookings');
  });

  app.get('/calendar', requireLogin, (req, res) => {
    const u = req.user;
    const isAdmin = u.role === 'admin';
    // A phone (app.js remembers it in the "narrow" cookie) opens on the day, a wider screen on the week. A day view
    // opened in the evening (from 20:00) without a date shows tomorrow: today is mostly over.
    const view = ['day', 'week', 'month'].includes(req.query.view) ? req.query.view : req.cookies.narrow === '1' ? 'day' : 'week';
    const evening = Number(time.now().slice(11, 13)) >= 20;
    const date = time.isValidDate(req.query.date) ? req.query.date : view === 'day' && evening ? time.addDays(time.today(), 1) : time.today();
    const vehicle = defaultVehicle();
    const win = windowFor(view, date);
    const items = bookings.inRange(vehicle.id, win.from + 'T00:00', win.to + 'T00:00', ['approved', 'completed', 'pending'])
      .filter((b) => isAdmin || b.status !== 'pending' || b.user_id === u.id);
    // Privacy: regular users see "busy" for other people's bookings, never who booked.
    const entries = items.map((b) => {
      if (b.kind === 'block') return { ...b, label: isAdmin ? '🔧 ' + b.block_reason : 'לא זמין', cls: 'block' };
      if (isAdmin) {
        // Only a request waiting for a decision opens a window (approve / reject) over the calendar; any other booking
        // links to its page. Rendering a window for every booking made a busy month ~1 MB.
        return { ...b, label: `${b.first_name} ${b.last_name}${b.status === 'pending' ? ' (ממתינה)' : ''}`, cls: b.status === 'pending' ? 'pending' : 'busy',
          dialog: b.status === 'pending' ? `bk-${b.id}` : undefined };
      }
      if (b.user_id === u.id) return { ...b, label: `שלי · ${bookings.STATUS_LABELS[b.status]}`, cls: b.status === 'pending' ? 'mine pending' : 'mine' };
      return { ...b, label: 'תפוס', cls: 'busy' };
    });
    const ready = bookings.vehicleReady(vehicle);
    const canBook = u.status === 'active' && ready && vehicle.status === 'available';
    res.page('יומן הרכב', html`
${pageHead('יומן הרכב', {
    iconName: 'calendar', sub: ready ? `${[vehicle.make, vehicle.model].filter(Boolean).join(' ')} · ${vehicle.plate}` : 'פרטי הרכב עדיין לא הוזנו',
    actions: canBook ? html`<a class="btn btn-primary" href="${isAdmin ? '/admin/bookings/new' : '/bookings/new'}">${icon('plus')} הזמנה חדשה</a>` : '',
  })}
${!ready ? html`<div class="flash flash-warning">אי אפשר להזמין עדיין: פרטי הרכב לא הוזנו.${isAdmin ? html` <a href="/admin/vehicle">להזנת פרטי הרכב</a>` : ' המנהל יעדכן אותם בקרוב.'}</div>`
  : vehicle.status !== 'available' ? html`<div class="flash flash-warning">הרכב כרגע ${vehicle.status === 'service' ? 'בטיפול' : 'מושבת'}, ולכן אי אפשר להזמין אותו עכשיו.</div>` : ''}
${!isAdmin && u.status !== 'active' ? html`<div class="flash flash-warning">${STATUS_HELP[u.status]}</div>` : ''}
<div class="legend">
  <span><i class="sw free"></i>פנוי</span><span><i class="sw busy"></i>תפוס</span><span><i class="sw block"></i>לא זמין / תחזוקה</span>
  ${isAdmin ? html`<span><i class="sw pending"></i>בקשה ממתינה</span>` : html`<span><i class="sw mine"></i>ההזמנות שלי</span>`}
</div>
${renderCalendar(entries, {
  view, date,
  linkFor: (e) => (isAdmin ? `/admin/bookings/${e.id}` : e.user_id === u.id ? `/me/bookings#b-${e.id}` : null),
  slotLink: canBook ? (slot) => `${isAdmin ? '/admin/bookings/new' : '/bookings/new'}?start=${slot}` : null,
})}
${canBook ? html`<p class="muted small">לחיצה על משבצת פנויה ביומן פותחת בקשת הזמנה מאותה שעה.${isAdmin ? ' לחיצה על הזמנה מציגה את פרטיה, ובקשה ממתינה אפשר לאשר או לדחות ישר מכאן.' : ''}</p>` : ''}
${isAdmin ? entries.filter((e) => e.dialogShown).map((e) => bookingDialog(req, e, req.originalUrl)) : ''}`);
  });

  /** "2 ימים ו־4 שעות", "3 שעות ו־30 דקות". */
  function spanLabel(hours) {
    const mins = Math.round(hours * 60);
    const d = Math.floor(mins / 1440); const h = Math.floor((mins % 1440) / 60); const m = mins % 60;
    return [d && (d === 1 ? 'יום' : `${d} ימים`), h && (h === 1 ? 'שעה' : `${h} שעות`), m && `${m} דקות`].filter(Boolean).join(' ו־') || '—';
  }

  /** The details of a booking in a window over the calendar (admins), with approve / reject for a pending request. */
  function bookingDialog(req, b, back) {
    const hours = time.hoursBetween(b.start_at, b.end_at);
    return html`<dialog class="ev-dialog" id="${b.dialog}" aria-labelledby="${b.dialog}-t">
  <div class="ev-dialog-head">
    <div><h2 id="${b.dialog}-t">${b.first_name} ${b.last_name}</h2>${bookingBadge(b.status)}</div>
    <form method="dialog"><button class="icon-btn" aria-label="סגירה">${icon('x')}</button></form>
  </div>
  <dl class="ev-times">
    <div><dt>איסוף</dt><dd>${time.fmtLong(b.start_at)}</dd></div>
    <div><dt>החזרה</dt><dd>${time.fmtLong(b.end_at)}</dd></div>
    <div><dt>משך</dt><dd>${spanLabel(hours)}</dd></div>
  </dl>
  ${b.purpose ? html`<p><b>מטרה:</b> ${b.purpose}</p>` : ''}
  ${b.notes ? html`<p><b>הערות:</b> ${b.notes}</p>` : ''}
  <div class="ev-dialog-actions">
    ${b.status === 'pending' ? decisionButtons(req, b, back, { note: true, size: '' }) : ''}
    <a class="btn btn-light" href="/admin/bookings/${b.id}">פרטים מלאים</a>
  </div>
</dialog>`;
  }

  function newBookingPage(req, { error, v = {} } = {}) {
    const s = getSettings();
    const start = time.isValidLocal(v.start) ? v.start : '';
    const end = time.isValidLocal(v.end) ? v.end : start ? time.addMinutes(start, 120) : '';
    return html`
<div class="narrow">
  ${pageHead('בקשת הזמנה חדשה', { iconName: 'plus', sub: 'בוחרים מתי לאסוף ומתי להחזיר, והבקשה נשלחת לאישור המנהל.' })}
  ${errorSummary(error)}
  ${postForm(req, '/bookings/new', html`
    <h2 class="section-title">${icon('clock')} מתי?</h2>
    <div class="grid2">
      ${field('איסוף הרכב', html`<input type="datetime-local" name="start" value="${start}" required min="${time.now()}">`)}
      ${field('החזרת הרכב', html`<input type="datetime-local" name="end" value="${end}" required min="${time.now()}">`)}
    </div>
    <div class="duration-chips" role="group" aria-label="משך מהיר" hidden>
      <span class="muted small">משך:</span><button type="button" class="chip" data-dur="120">שעתיים</button><button type="button" class="chip" data-dur="300">חצי יום</button><button type="button" class="chip" data-dur="1440">יום שלם</button></div>
    <div id="duration" class="duration" aria-live="polite"></div>
    <div id="availability" class="availability" aria-live="polite"></div>
    <h2 class="section-title">${icon('file')} פרטים נוספים</h2>
    ${field('מטרת הנסיעה (אופציונלי)', html`<input name="purpose" value="${v.purpose}" maxlength="200">`)}
    ${field('הערות מיוחדות (אופציונלי)', html`<textarea name="notes" rows="3" maxlength="1000">${v.notes}</textarea>`)}
    <label class="check"><input type="checkbox" name="accept_rules" value="1" required> <span>אני מתחייב/ת לפעול לפי <a href="/policy" target="_blank">נהלי השאלת הרכב</a></span></label>
    <button class="btn btn-primary btn-block">שליחת בקשה</button>
    <p class="muted small">${s.max_booking_hours ? `משך הזמנה מקסימלי: ${bookings.durationLabel(s.max_booking_hours)}. ` : ''}${s.buffer_minutes ? `נדרשות ${s.buffer_minutes} דקות התארגנות בין הזמנות. ` : ''}הבקשה תישלח לאישור המנהל.</p>
  `, 'class="card" data-times data-availability="/api/availability"')}
</div>`;
  }

  /** Middleware for the booking form: user must be active and have accepted the current policy. */
  function canRequest(req, res, next) {
    const u = req.user;
    const v = defaultVehicle();
    if (!bookings.vehicleReady(v) || v.status !== 'available') {
      res.flash('warning', !bookings.vehicleReady(v) ? 'אי אפשר להזמין עדיין: פרטי הרכב לא הוזנו.'
        : `הרכב כרגע ${v.status === 'service' ? 'בטיפול' : 'מושבת'}, ולכן אי אפשר להזמין אותו עכשיו.`);
      return res.redirect('/calendar');
    }
    if (u.status !== 'active') {
      res.flash('warning', STATUS_HELP[u.status]);
      return res.redirect('/me');
    }
    if (!userAcceptedPolicy(u.id)) {
      res.flash('warning', 'יש לאשר את נהלי השאלת הרכב לפני ביצוע הזמנה');
      return res.redirect('/policy/accept?next=/bookings/new');
    }
    next();
  }

  app.get('/bookings/new', requireLogin, canRequest, (req, res) => {
    res.page('הזמנה חדשה', newBookingPage(req, { v: { start: req.query.start } }));
  });

  app.post('/bookings/new', requireLogin, canRequest, async (req, res) => {
    const v = {
      start: String(req.body.start || ''), end: String(req.body.end || ''),
      purpose: String(req.body.purpose || '').trim().slice(0, 200), notes: String(req.body.notes || '').trim().slice(0, 1000),
    };
    if (req.body.accept_rules !== '1') return res.status(400).page('הזמנה חדשה', newBookingPage(req, { error: fieldError('accept_rules', 'יש לאשר את נהלי השימוש'), v }));
    try {
      let b = bookings.createRequest(req.user, { vehicleId: defaultVehicle().id, ...v });
      const approved = bookings.autoApprove(b);
      if (approved) b = approved;
      await later(() => (approved ? mail.bookingApproved(b, { approvedBy: 'המערכת (אישור אוטומטי)' }) : mail.bookingRequested(b)), 'request e-mails');
      res.page(approved ? 'ההזמנה אושרה' : 'הבקשה נשלחה', html`
<div class="narrow card success-card">
  <span class="success-mark">${icon('check', 34)}</span>
  <h1>${approved ? 'ההזמנה אושרה' : 'הבקשה נשלחה'}</h1>
  <p><b>${approved ? 'המועד היה פנוי וההזמנה אושרה מיד. נשלח אליך מייל אישור עם זימון ליומן.'
    : 'בקשת ההזמנה התקבלה וממתינה לאישור המנהל. ההזמנה אינה סופית עד לקבלת אישור.'}</b></p>
  <p>איסוף: ${time.fmtLong(b.start_at)}<br>החזרה: ${time.fmtLong(b.end_at)}</p>
  <p><a class="btn btn-primary" href="/me/bookings">להזמנות שלי</a> <a class="btn btn-light" href="/calendar">ליומן</a></p>
</div>`);
    } catch (err) {
      if (!(err instanceof bookings.BookingError)) throw err;
      res.status(400).page('הזמנה חדשה', newBookingPage(req, { error: fieldError(['start', 'end'], err.message), v }));
    }
  });

  // Live availability check for the booking form (no personal details returned).
  app.get('/api/availability', requireLogin, (req, res) => {
    const { start, end } = req.query;
    if (!time.isValidLocal(start) || !time.isValidLocal(end)) return res.json({ ok: false, message: '' });
    try {
      bookings.validateRequestRange(start, end);
    } catch (err) {
      if (!(err instanceof bookings.BookingError)) throw err;
      return res.json({ ok: false, message: err.message });
    }
    const conflicts = bookings.findConflicts(defaultVehicle().id, start, end);
    if (conflicts.length) {
      return res.json({ ok: false, message: `הרכב תפוס בחלק מהזמן (${time.fmt(conflicts[0].start_at)}–${time.fmt(conflicts[0].end_at)})` });
    }
    res.json({ ok: true, message: 'הרכב פנוי במועד זה' });
  });

  app.get('/policy/accept', requireLogin, (req, res) => {
    const policy = currentPolicy();
    const accepted = db.prepare('SELECT * FROM policy_acceptances WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(req.user.id);
    res.page('אישור נהלים', html`
${pageHead('נהלי השאלת הרכב', { iconName: 'shield', sub: 'יש לקרוא ולאשר את הנהלים לפני הזמנת הרכב.' })}
${accepted ? html`<p class="muted">אישרת לאחרונה את גרסה ${accepted.policy_version} בתאריך ${time.fmt(accepted.accepted_at)}.</p>` : ''}
<article class="card prose">${markdown(policy.content)}</article>
${accepted?.policy_version === policy.version ? html`<p class="note-line">${icon('check', 18)} הגרסה הנוכחית כבר אושרה.</p>` : postForm(req, '/policy/accept', html`
  <input type="hidden" name="version" value="${policy.version}">
  <input type="hidden" name="next" value="${req.query.next || ''}">
  <label class="check"><input type="checkbox" name="agree" value="1" required> <span>קראתי ואני מסכים/ה לנהלי השאלת הרכב (גרסה ${policy.version})</span></label>
  <button class="btn btn-primary">אישור</button>`, 'class="card"')}`);
  });

  app.post('/policy/accept', requireLogin, (req, res) => {
    const version = Number(req.body.version);
    if (req.body.agree !== '1' || version !== currentPolicy().version) {
      res.flash('error', 'יש לסמן את תיבת האישור');
      return res.redirect('/policy/accept');
    }
    db.prepare('INSERT INTO policy_acceptances (user_id, policy_version, ip, accepted_at) VALUES (?, ?, ?, ?)').run(req.user.id, version, req.ip, time.stamp());
    res.flash('success', 'הנהלים אושרו');
    res.redirect(safeNext(req.body.next) || '/me');
  });

  app.get('/me/security', requireLogin, (req, res) => {
    const u = req.user;
    res.page('סיסמה ואבטחה', html`
<div class="narrow">
  ${pageHead('סיסמה ואבטחה', { iconName: 'lock', sub: 'שמירה על החשבון שלך.' })}
  ${postForm(req, '/me/password', html`
    <h2 class="section-title">${icon('lock')} ${u.password_hash ? 'שינוי סיסמה' : 'הגדרת סיסמה'}</h2>
    ${u.password_hash ? field('סיסמה נוכחית', html`<input type="password" name="current" required autocomplete="current-password">`) : ''}
    ${field('סיסמה חדשה', html`<input type="password" name="password" minlength="8" required autocomplete="new-password">`, 'לפחות 8 תווים, לא סיסמה נפוצה ולא השם או המייל')}
    <button class="btn btn-primary">שמירה</button>`, 'class="card"')}
  ${u.google_sub ? html`<section class="card"><h2 class="section-title">${icon('user')} חשבון Google</h2><p>${badge('active', 'מקושר')} ניתן להתחבר עם חשבון Google של ${u.email}.</p></section>` : ''}
  ${u.role === 'admin' && passkeys.enabled() ? passkeysCard(req, u) : ''}
</div>`);
  });

  // ---------- Passkeys (src/passkeys.js) ----------
  function passkeysCard(req, u) {
    const keys = passkeys.list(u.id);
    const required = consoleAdmin(u) && passkeys.consoleRequires();
    return html`<section class="card" id="passkeys">
  <h2 class="section-title">${icon('lock')} מפתחות גישה (Passkeys)</h2>
  ${required && !keys.length ? html`<div class="flash flash-warning"><b>נדרש מפתח גישה.</b> כדי להיכנס למרכז הניהול, הוסיפו מפתח גישה למכשיר שלכם.</div>` : ''}
  <p>מפתח גישה הוא אימות נוסף שאינו עובר במייל: טביעת אצבע או זיהוי פנים בטלפון, Windows Hello או Touch ID במחשב, או מפתח אבטחה.
    ${keys.length ? 'כל כניסה לחשבון הזה (בסיסמה, בקוד במייל או עם Google) מבקשת גם אותו.' : 'אחרי שתוסיפו מפתח, כל כניסה לחשבון תבקש גם אותו, כך שגם סיסמה גנובה או תיבת מייל פרוצה לא יספיקו.'}</p>
  ${keys.length ? html`<ul class="plain">${keys.map((k) => html`<li>
    <b>${k.name}</b> <span class="muted small">נוסף ${time.fmt(k.created_at)}${k.last_used_at ? ` · שימוש אחרון ${time.fmt(k.last_used_at)}` : ''}</span>
    ${postForm(req, `/me/passkeys/${encodeURIComponent(k.id)}/remove`, html`<button class="btn btn-light btn-sm" data-confirm="להסיר את מפתח הגישה ${k.name}?">הסרה</button>`, 'class="inline"')}</li>`)}</ul>` : ''}
  ${postForm(req, '/me/passkeys', html`
    ${field('שם למפתח (לא חובה)', html`<input name="name" maxlength="60" placeholder="למשל: הטלפון שלי">`)}
    <input type="hidden" name="token" value="">
    <input type="hidden" name="credential" value="">
    <button type="button" class="btn btn-primary" data-passkey="create" data-options-url="/me/passkeys/options">${icon('plus')} הוספת מפתח גישה</button>
    <p class="muted small" data-passkey-error role="alert"></p>`, 'data-passkey-form')}
  <noscript><p class="flash flash-warning small">הוספת מפתח גישה דורשת JavaScript בדפדפן.</p></noscript>
</section>`;
  }

  // The device's options for a new passkey (JSON for app.js).
  app.post('/me/passkeys/options', requireLogin, async (req, res) => {
    if (req.user.role !== 'admin' || !passkeys.enabled()) return res.status(403).json({ error: 'not available' });
    res.set('Cache-Control', 'no-store').json(await passkeys.registrationOptions(req, req.user));
  });

  app.post('/me/passkeys', requireLogin, async (req, res) => {
    if (req.user.role !== 'admin' || !passkeys.enabled()) return res.redirect(303, '/me/security');
    try {
      const k = await passkeys.register(req, req.user, String(req.body.token || ''), String(req.body.credential || ''), req.body.name);
      res.flash('success', `מפתח הגישה "${k.name}" נוסף. מעכשיו כל כניסה לחשבון תבקש גם אותו.`);
    } catch (err) {
      res.flash('error', err.message);
    }
    res.redirect(303, '/me/security#passkeys');
  });

  app.post('/me/passkeys/:id/remove', requireLogin, requireRecentAuth, (req, res) => {
    const u = req.user;
    if (consoleAdmin(u) && passkeys.consoleRequires() && passkeys.list(u.id).length <= 1) {
      res.flash('error', 'זה מפתח הגישה האחרון, ובלעדיו אי אפשר להיכנס למרכז הניהול. הוסיפו מפתח אחר לפני שתסירו אותו.');
    } else if (passkeys.remove(u.id, req.params.id, u.id)) {
      res.flash('success', 'מפתח הגישה הוסר');
    }
    res.redirect(303, '/me/security#passkeys');
  });

  // ---------- Confirming again before a sensitive action (requireRecentAuth) ----------
  const backFrom = (req) => safeNext(req.query.back || req.body?.back) || '/';

  app.get('/reauth', requireLogin, async (req, res) => {
    const u = req.user;
    const back = backFrom(req);
    if (passkeys.has(u.id)) {
      const { token, options } = await passkeys.authenticationOptions(req, u, 'reauth', back);
      return res.page('אישור זהות', passkeyPage(req, {
        action: '/reauth/passkey', token, options, title: 'אישור זהות', intro: 'לפני פעולה רגישה: אשרו במכשיר שלכם שזה אתם.',
        extra: html`<p><a href="${back}">ביטול</a></p>`,
      }));
    }
    res.page('אישור זהות', html`
<div class="narrow">
  ${pageHead('אישור זהות', { iconName: 'lock', sub: 'לפני פעולה רגישה יש לאשר שוב שזה אתם.' })}
  ${u.password_hash ? postForm(req, '/reauth', html`
    <input type="hidden" name="back" value="${back}">
    ${field('הסיסמה שלך', html`<input type="password" name="password" required autocomplete="current-password" autofocus>`)}
    <button class="btn btn-primary btn-block">אישור</button>`, 'class="card"')
    : postForm(req, '/reauth/code', html`
    <input type="hidden" name="back" value="${back}">
    <p>לחשבון אין סיסמה: נשלח קוד לכתובת <b dir="ltr">${u.email}</b>.</p>
    <button class="btn btn-primary btn-block">שליחת קוד</button>`, 'class="card"')}
  <p><a href="${back}">ביטול</a></p>
</div>`);
  });

  const confirmed = (req, res, back, how) => {
    auth.confirmIdentity(req);
    audit(req.user.id, 'user.reauth', 'user', req.user.id, how);
    res.flash('success', 'אושר. אפשר לבצע את הפעולה.');
    res.redirect(303, back);
  };

  app.post('/reauth', requireLogin, async (req, res) => {
    const back = backFrom(req);
    if (passkeys.has(req.user.id)) return res.redirect(303, `/reauth?back=${encodeURIComponent(back)}`); // the passkey, not a password
    if (auth.throttled(`reauth:${req.user.id}`, 10)) { res.flash('error', 'יותר מדי ניסיונות. נסו שוב בעוד מספר דקות.'); return res.redirect(303, back); }
    if (req.body.code != null) {
      if (!auth.consumeLoginCode(req.user.id, req.body.code)) { res.flash('error', 'הקוד שגוי או שפג תוקפו'); return res.redirect(303, `/reauth?back=${encodeURIComponent(back)}`); }
      return confirmed(req, res, back, 'code');
    }
    if (!(await auth.verifyPasswordAsync(String(req.body.password || ''), req.user.password_hash))) {
      res.flash('error', 'הסיסמה שגויה');
      return res.redirect(303, `/reauth?back=${encodeURIComponent(back)}`);
    }
    confirmed(req, res, back, 'password');
  });

  app.post('/reauth/code', requireLogin, async (req, res) => {
    const back = backFrom(req);
    const u = req.user;
    const sent = !auth.throttled(`code:acct:${u.id}`, 5, 3600000) && await mail.loginCode(u, auth.createLoginCode(u.id));
    if (!sent) { res.flash('error', 'לא ניתן לשלוח קוד כרגע. נסו שוב בעוד כמה דקות.'); return res.redirect(303, back); }
    res.page('אישור זהות', html`
<div class="narrow">
  ${pageHead('אישור זהות', { iconName: 'lock', sub: html`שלחנו קוד בן 6 ספרות לכתובת <b dir="ltr">${u.email}</b>.` })}
  ${postForm(req, '/reauth', html`
    <input type="hidden" name="back" value="${back}">
    ${field('קוד', html`<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required autofocus>`)}
    <button class="btn btn-primary btn-block">אישור</button>`, 'class="card"')}
  <p><a href="${back}">ביטול</a></p>
</div>`);
  });

  app.post('/reauth/passkey', requireLogin, async (req, res) => {
    let r;
    try {
      r = await passkeys.authenticate(req, String(req.body.token || ''), String(req.body.credential || ''), 'reauth');
    } catch (err) {
      res.flash('error', err.message);
      return res.redirect(303, '/reauth');
    }
    if (r.userId !== req.user.id) return res.redirect(303, '/reauth');
    confirmed(req, res, safeNext(r.next) || '/', 'passkey');
  });

  app.post('/me/password', requireLogin, async (req, res) => {
    const u = req.user;
    if (u.password_hash && !(await auth.verifyPasswordAsync(String(req.body.current || ''), u.password_hash))) {
      res.flash('error', 'הסיסמה הנוכחית שגויה');
    } else if (passwordProblem(req.body.password, u)) {
      res.flash('error', passwordProblem(req.body.password, u));
    } else {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await auth.hashPasswordAsync(String(req.body.password)), u.id);
      // Log out other devices, keep this session.
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(u.id, req.session.token_hash);
      audit(u.id, 'user.password_change', 'user', u.id);
      res.flash('success', 'הסיסמה עודכנה');
    }
    res.redirect('/me/security');
  });
};
