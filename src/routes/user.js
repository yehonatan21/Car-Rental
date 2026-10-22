'use strict';
const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');
const { db, audit, currentPolicy, userAcceptedPolicy, getSettings, defaultVehicle } = require('../db');
const auth = require('../auth');
const mail = require('../mail');
const time = require('../time');
const config = require('../config');
const bookings = require('../bookings');
const { renderCalendar, windowFor } = require('../views/calendar');
const { html, markdown, postForm, actionButton, field, badge, USER_STATUS } = require('../views/html');
const { normalizePhone, validPhone, safeNext } = require('./public');

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
        : actionButton(req, `/me/bookings/${b.id}/cancel`, 'ביטול', { cls: 'btn-danger btn-sm', confirm: 'לבטל את ההזמנה?' }))
      : ''}</td>
  </tr>`;
}

const bookingTable = (req, list, opts) => list.length
  ? html`<table class="table"><thead><tr><th>איסוף</th><th>החזרה</th><th>מטרה</th><th>סטטוס</th><th></th></tr></thead>
      <tbody>${list.map((b) => bookingRow(req, b, opts))}</tbody></table>`
  : html`<p class="muted">אין הזמנות להצגה.</p>`;

function upcomingFor(userId) {
  return db.prepare(`SELECT * FROM bookings WHERE user_id = ? AND kind = 'booking' AND end_at > ?
    AND status IN ('pending','approved') ORDER BY start_at`).all(userId, time.now());
}

module.exports = ({ app, requireLogin, licenseUpload }) => {
  app.get('/me', requireLogin, (req, res) => {
    const u = req.user;
    const upcoming = upcomingFor(u.id);
    const needsPolicy = !userAcceptedPolicy(u.id);
    res.page('אזור אישי', html`
<h1>שלום ${u.first_name}</h1>
<div class="card status-card status-${u.status}">
  <div>סטטוס החשבון: ${badge(u.status, USER_STATUS[u.status])}</div>
  <p>${STATUS_HELP[u.status]}</p>
  ${u.pending_license_file ? html`<p>📄 רישיון חדש שהעלית ממתין לבדיקת המנהל.</p>` : ''}
  ${needsPolicy ? html`<p>⚠️ נהלי השאלת הרכב עודכנו. <a href="/policy/accept">יש לקרוא ולאשר אותם</a> לפני הזמנה נוספת.</p>` : ''}
  ${u.status === 'license_update' && !u.pending_license_file ? html`<a class="btn btn-primary" href="/me/license">העלאת רישיון</a>` : ''}
  ${u.status === 'active' && !needsPolicy ? html`<a class="btn btn-primary" href="/bookings/new">הזמנה חדשה</a>` : ''}
</div>

<div class="grid2">
  <section class="card">
    <h2>ההזמנות הקרובות</h2>
    ${upcoming.length ? html`<ul class="plain">${upcoming.map((b) => html`<li>
      ${time.fmtLong(b.start_at)} ← ${time.fmt(b.end_at)} ${bookingBadge(b.status)}</li>`)}</ul>`
      : html`<p class="muted">אין הזמנות קרובות.</p>`}
    <a href="/me/bookings">לכל ההזמנות</a>
  </section>
  <section class="card">
    <h2>הפרטים שלי</h2>
    <dl class="dl">
      <dt>שם</dt><dd>${u.first_name} ${u.last_name}</dd>
      <dt>ת"ז</dt><dd>${u.id_number}</dd>
      <dt>דואר אלקטרוני</dt><dd>${u.email}</dd>
      <dt>תוקף רישיון</dt><dd>${time.fmt(u.license_expiry)} ${u.license_verified ? badge('active', 'אומת') : badge('pending', 'טרם אומת')}</dd>
    </dl>
    ${postForm(req, '/me/profile', html`
      ${field('טלפון נייד', html`<input type="tel" name="phone" value="${u.phone}" required>`)}
      <button class="btn btn-light">עדכון טלפון</button>`)}
    <p class="muted small">לשינוי שם, תעודת זהות או דואר אלקטרוני יש לפנות למנהל.</p>
    <p><a href="/me/license">עדכון רישיון נהיגה</a> · <a href="/me/security">סיסמה ואבטחה</a> · <a href="/policy">נהלי השאלה</a></p>
  </section>
</div>`);
  });

  app.post('/me/profile', requireLogin, (req, res) => {
    const phone = normalizePhone(req.body.phone);
    if (!validPhone(phone)) {
      res.flash('error', 'מספר הטלפון אינו תקין');
    } else {
      db.prepare("UPDATE users SET phone = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(phone, req.user.id);
      res.flash('success', 'הפרטים עודכנו');
    }
    res.redirect('/me');
  });

  app.get('/me/license', requireLogin, (req, res) => {
    const u = req.user;
    res.page('רישיון נהיגה', html`
<div class="narrow">
  <h1>רישיון נהיגה</h1>
  <div class="card">
    <p>תוקף הרישיון הנוכחי: <b>${time.fmt(u.license_expiry) || '—'}</b>
      ${u.license_verified ? badge('active', 'אומת') : badge('pending', 'טרם אומת')}</p>
    ${u.pending_license_file ? html`<p>רישיון חדש (בתוקף עד ${time.fmt(u.pending_license_expiry)}) ממתין לבדיקת המנהל. העלאה נוספת תחליף אותו.</p>` : ''}
  </div>
  ${postForm(req, '/me/license', html`
    <h2>העלאת רישיון חדש</h2>
    ${field('צילום רישיון נהיגה', html`<input type="file" name="license" accept="image/*,application/pdf" required>`, 'תמונה או PDF, עד 8MB')}
    ${field('תאריך פקיעת תוקף', html`<input type="date" name="license_expiry" required min="${time.today()}">`)}
    <button class="btn btn-primary btn-block">שליחה לבדיקה</button>
    <p class="muted small">הרישיון הקיים ימשיך לשמש עד לאישור החדש.</p>`, 'enctype="multipart/form-data" class="card"')}
</div>`);
  });

  app.post('/me/license', requireLogin, licenseUpload, async (req, res) => {
    const expiry = String(req.body.license_expiry || '');
    if (!req.file || !time.isValidDate(expiry) || expiry < time.today()) {
      if (req.file) fs.rmSync(req.file.path, { force: true });
      res.flash('error', 'יש להעלות קובץ תמונה או PDF ולהזין תאריך תוקף עתידי');
      return res.redirect('/me/license');
    }
    const u = req.user;
    if (u.pending_license_file) fs.rmSync(path.join(config.uploadsDir, u.pending_license_file), { force: true });
    db.prepare("UPDATE users SET pending_license_file = ?, pending_license_expiry = ?, updated_at = datetime('now','localtime') WHERE id = ?")
      .run(req.file.filename, expiry, u.id);
    audit(u.id, 'user.license_upload', 'user', u.id, expiry);
    await mail.newLicenseUploaded(u);
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
<div class="page-head"><h1>ההזמנות שלי</h1><a class="btn btn-primary" href="/bookings/new">הזמנה חדשה</a></div>
<section class="card">
  <h2>הזמנות עתידיות</h2>
  ${bookingTable(req, future, { showCancel: true })}
  <p class="muted small">ניתן לבטל בקשה שממתינה לאישור בכל עת, והזמנה מאושרת עד ${s.cancel_hours_before} שעות לפני תחילתה.</p>
</section>
<section class="card">
  <h2>היסטוריית הזמנות</h2>
  ${bookingTable(req, past, { showCancel: false })}
</section>`);
  });

  app.post('/me/bookings/:id/cancel', requireLogin, async (req, res) => {
    try {
      const b = bookings.cancel(Number(req.params.id), req.user);
      await mail.bookingCancelled(b, false);
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
    const view = ['day', 'week', 'month'].includes(req.query.view) ? req.query.view : 'week';
    const date = time.isValidDate(req.query.date) ? req.query.date : time.today();
    const vehicle = defaultVehicle();
    const win = windowFor(view, date);
    const items = bookings.inRange(vehicle.id, win.from + 'T00:00', win.to + 'T00:00', ['approved', 'completed', 'pending'])
      .filter((b) => isAdmin || b.status !== 'pending' || b.user_id === u.id);
    // Privacy: regular users see "busy" for other people's bookings, never who booked.
    const entries = items.map((b) => {
      if (b.kind === 'block') return { ...b, label: isAdmin ? '🔧 ' + b.block_reason : 'לא זמין', cls: 'block' };
      if (isAdmin) {
        return { ...b, label: `${b.first_name} ${b.last_name}${b.status === 'pending' ? ' (ממתינה)' : ''}`, cls: b.status === 'pending' ? 'pending' : 'busy' };
      }
      if (b.user_id === u.id) return { ...b, label: `שלי · ${bookings.STATUS_LABELS[b.status]}`, cls: b.status === 'pending' ? 'mine pending' : 'mine' };
      return { ...b, label: 'תפוס', cls: 'busy' };
    });
    const canBook = u.status === 'active' && vehicle.status !== 'disabled';
    res.page('יומן הרכב', html`
<div class="page-head">
  <h1>יומן הרכב <small class="muted">${vehicle.make} ${vehicle.model} · ${vehicle.plate}</small></h1>
  ${canBook ? html`<a class="btn btn-primary" href="${isAdmin ? '/admin/bookings/new' : '/bookings/new'}">הזמנה חדשה</a>` : ''}
</div>
${vehicle.status !== 'available' ? html`<div class="flash flash-warning">הרכב כרגע ${vehicle.status === 'service' ? 'בטיפול' : 'מושבת'}.</div>` : ''}
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
${canBook ? html`<p class="muted small">לחיצה על משבצת פנויה ביומן פותחת בקשת הזמנה מאותה שעה.</p>` : ''}`);
  });

  function newBookingPage(req, { error, v = {} } = {}) {
    const s = getSettings();
    const start = time.isValidLocal(v.start) ? v.start : '';
    const end = time.isValidLocal(v.end) ? v.end : start ? time.addMinutes(start, 120) : '';
    return html`
<div class="narrow">
  <h1>בקשת הזמנה חדשה</h1>
  ${error ? html`<div class="flash flash-error">${error}</div>` : ''}
  ${postForm(req, '/bookings/new', html`
    <div class="grid2">
      ${field('איסוף הרכב', html`<input type="datetime-local" name="start" value="${start}" required step="900" min="${time.now()}">`)}
      ${field('החזרת הרכב', html`<input type="datetime-local" name="end" value="${end}" required step="900" min="${time.now()}">`)}
    </div>
    <div id="availability" class="availability" aria-live="polite"></div>
    ${field('מטרת הנסיעה (אופציונלי)', html`<input name="purpose" value="${v.purpose}" maxlength="200">`)}
    ${field('הערות מיוחדות (אופציונלי)', html`<textarea name="notes" rows="3" maxlength="1000">${v.notes}</textarea>`)}
    <label class="check"><input type="checkbox" name="accept_rules" value="1" required> <span>אני מתחייב/ת לפעול לפי <a href="/policy" target="_blank">נהלי השאלת הרכב</a></span></label>
    <button class="btn btn-primary btn-block">שליחת בקשה</button>
    <p class="muted small">${s.max_booking_hours ? `משך הזמנה מקסימלי: ${s.max_booking_hours} שעות. ` : ''}${s.buffer_minutes ? `נדרשות ${s.buffer_minutes} דקות התארגנות בין הזמנות. ` : ''}הבקשה תישלח לאישור המנהל.</p>
  `, 'class="card" data-availability="/api/availability"')}
</div>`;
  }

  /** Middleware for the booking form: user must be active and have accepted the current policy. */
  function canRequest(req, res, next) {
    const u = req.user;
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
    if (req.body.accept_rules !== '1') return res.status(400).page('הזמנה חדשה', newBookingPage(req, { error: 'יש לאשר את נהלי השימוש', v }));
    try {
      const b = bookings.createRequest(req.user, { vehicleId: defaultVehicle().id, ...v });
      await mail.bookingRequested(b);
      res.page('הבקשה נשלחה', html`
<div class="narrow card success-card">
  <h1>✓ הבקשה נשלחה</h1>
  <p><b>בקשת ההזמנה התקבלה וממתינה לאישור המנהל. ההזמנה אינה סופית עד לקבלת אישור.</b></p>
  <p>איסוף: ${time.fmtLong(b.start_at)}<br>החזרה: ${time.fmtLong(b.end_at)}</p>
  <p><a class="btn btn-primary" href="/me/bookings">להזמנות שלי</a> <a class="btn btn-light" href="/calendar">ליומן</a></p>
</div>`);
    } catch (err) {
      if (!(err instanceof bookings.BookingError)) throw err;
      res.status(400).page('הזמנה חדשה', newBookingPage(req, { error: err.message, v }));
    }
  });

  // Live availability check for the booking form (no personal details returned).
  app.get('/api/availability', requireLogin, (req, res) => {
    const { start, end } = req.query;
    if (!time.isValidLocal(start) || !time.isValidLocal(end) || end <= start) return res.json({ ok: false, message: '' });
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
<h1>נהלי השאלת הרכב</h1>
${accepted ? html`<p class="muted">אישרת לאחרונה את גרסה ${accepted.policy_version} בתאריך ${time.fmt(accepted.accepted_at)}.</p>` : ''}
<article class="card prose">${markdown(policy.content)}</article>
${accepted?.policy_version === policy.version ? html`<p>✓ הגרסה הנוכחית כבר אושרה.</p>` : postForm(req, '/policy/accept', html`
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
    db.prepare('INSERT INTO policy_acceptances (user_id, policy_version, ip) VALUES (?, ?, ?)').run(req.user.id, version, req.ip);
    res.flash('success', 'הנהלים אושרו');
    res.redirect(safeNext(req.body.next) || '/me');
  });

  app.get('/me/security', requireLogin, async (req, res) => {
    const u = req.user;
    let setup = '';
    if (!u.totp_enabled && u.totp_secret) {
      const uri = `otpauth://totp/${encodeURIComponent(config.appName + ':' + u.email)}?secret=${u.totp_secret}&issuer=${encodeURIComponent(config.appName)}`;
      const qr = await QRCode.toDataURL(uri, { margin: 1, width: 200 });
      setup = html`
<div class="card">
  <h3>סריקת קוד</h3>
  <p>סרקו את הקוד באפליקציית אימות (Google Authenticator, Microsoft Authenticator וכדומה), או הזינו ידנית את המפתח:</p>
  <img src="${qr}" alt="QR" width="200" height="200"><p><code>${u.totp_secret}</code></p>
  ${postForm(req, '/me/2fa/enable', html`${field('קוד מהאפליקציה', html`<input name="code" inputmode="numeric" maxlength="6" required>`)}
    <button class="btn btn-primary">הפעלה</button>`)}
</div>`;
    }
    res.page('סיסמה ואבטחה', html`
<div class="narrow">
  <h1>סיסמה ואבטחה</h1>
  ${postForm(req, '/me/password', html`
    <h2>${u.password_hash ? 'שינוי סיסמה' : 'הגדרת סיסמה'}</h2>
    ${u.password_hash ? field('סיסמה נוכחית', html`<input type="password" name="current" required autocomplete="current-password">`) : ''}
    ${field('סיסמה חדשה', html`<input type="password" name="password" minlength="8" required autocomplete="new-password">`)}
    <button class="btn btn-primary">שמירה</button>`, 'class="card"')}
  <section class="card">
    <h2>אימות דו־שלבי</h2>
    ${u.role === 'admin' && !u.totp_enabled ? html`<div class="flash flash-warning">מומלץ מאוד להפעיל אימות דו־שלבי לחשבונות מנהל.</div>` : ''}
    ${u.totp_enabled
      ? html`<p>${badge('active', 'פעיל')} האימות הדו־שלבי מופעל.</p>
        ${postForm(req, '/me/2fa/disable', html`${field('קוד נוכחי לביטול', html`<input name="code" inputmode="numeric" maxlength="6" required>`)}
          <button class="btn btn-danger">ביטול אימות דו־שלבי</button>`)}`
      : u.totp_secret ? '' : actionButton(req, '/me/2fa/start', 'הפעלת אימות דו־שלבי', { cls: 'btn-light' })}
  </section>
  ${setup}
</div>`);
  });

  app.post('/me/password', requireLogin, (req, res) => {
    const u = req.user;
    if (u.password_hash && !auth.verifyPassword(String(req.body.current || ''), u.password_hash)) {
      res.flash('error', 'הסיסמה הנוכחית שגויה');
    } else if (String(req.body.password || '').length < 8) {
      res.flash('error', 'הסיסמה חייבת להכיל לפחות 8 תווים');
    } else {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(String(req.body.password)), u.id);
      // Log out other devices, keep this session.
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(u.id, req.session.token_hash);
      audit(u.id, 'user.password_change', 'user', u.id);
      res.flash('success', 'הסיסמה עודכנה');
    }
    res.redirect('/me/security');
  });

  app.post('/me/2fa/start', requireLogin, (req, res) => {
    if (!req.user.totp_enabled) db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(auth.newTotpSecret(), req.user.id);
    res.redirect('/me/security');
  });

  app.post('/me/2fa/enable', requireLogin, (req, res) => {
    const u = req.user;
    if (u.totp_secret && auth.verifyTotp(u.totp_secret, req.body.code)) {
      db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(u.id);
      audit(u.id, 'user.2fa_enable', 'user', u.id);
      res.flash('success', 'האימות הדו־שלבי הופעל');
    } else {
      res.flash('error', 'הקוד שגוי. ודאו שהשעון בטלפון מדויק ונסו שוב');
    }
    res.redirect('/me/security');
  });

  app.post('/me/2fa/disable', requireLogin, (req, res) => {
    const u = req.user;
    if (u.totp_enabled && auth.verifyTotp(u.totp_secret, req.body.code)) {
      db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(u.id);
      audit(u.id, 'user.2fa_disable', 'user', u.id);
      res.flash('success', 'האימות הדו־שלבי בוטל');
    } else {
      res.flash('error', 'הקוד שגוי');
    }
    res.redirect('/me/security');
  });
};
