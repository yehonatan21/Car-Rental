'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { db, audit, getSettings, setSetting, currentPolicy, defaultVehicle } = require('../db');
const auth = require('../auth');
const mail = require('../mail');
const time = require('../time');
const config = require('../config');
const bookings = require('../bookings');
const google = require('../google');
const { html, markdown, postForm, actionButton, field, badge, USER_STATUS, VEHICLE_STATUS } = require('../views/html');

const SETTING_LABELS = {
  buffer_minutes: ['זמן התארגנות בין הזמנות (דקות)', 'מרווח חובה בין החזרת הרכב להזמנה הבאה'],
  cancel_hours_before: ['ביטול עצמי של הזמנה מאושרת – עד כמה שעות לפני תחילתה', 'אחרי מועד זה רק מנהל יכול לבטל'],
  max_booking_hours: ['משך הזמנה מקסימלי (שעות)', '0 = ללא הגבלה'],
  max_open_bookings: ['מספר הזמנות פתוחות מקסימלי למשתמש', '0 = ללא הגבלה'],
  pickup_reminder_hours: ['תזכורת לפני איסוף (שעות)', ''],
  return_reminder_hours: ['תזכורת לפני החזרה (שעות)', ''],
  pending_alert_hours: ['התראה על בקשה שממתינה יותר מ־(שעות)', ''],
  license_warn_days: ['תזכורת למשתמש לפני פקיעת רישיון (ימים)', ''],
};

const fullName = (u) => `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim();
const bookingBadge = (s) => badge(s, bookings.STATUS_LABELS[s]);
const userBadge = (s) => badge(s, USER_STATUS[s]);
const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));

/** Wraps a POST handler that may throw BookingError, flashing the message and redirecting back. */
const guarded = (fallback, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (!(err instanceof bookings.BookingError)) throw err;
    res.flash('error', err.message);
    res.redirect(typeof fallback === 'function' ? fallback(req) : fallback);
  }
};

function bookingsTable(list, { showUser = true } = {}) {
  if (!list.length) return html`<p class="muted">אין רשומות.</p>`;
  return html`<table class="table">
<thead><tr>${showUser ? html`<th>משתמש</th>` : ''}<th>איסוף</th><th>החזרה</th><th>מטרה</th><th>סטטוס</th><th></th></tr></thead>
<tbody>${list.map((b) => html`<tr>
  ${showUser ? html`<td data-label="משתמש">${b.kind === 'block' ? html`🔧 ${b.block_reason}` : fullName(b)}</td>` : ''}
  <td data-label="איסוף">${time.fmt(b.start_at)}</td>
  <td data-label="החזרה">${time.fmt(b.end_at)}</td>
  <td data-label="מטרה">${b.purpose || '—'}</td>
  <td data-label="סטטוס">${b.kind === 'block' ? badge('block', 'חסימה') : ''} ${bookingBadge(b.status)}</td>
  <td><a href="/admin/bookings/${b.id}">פרטים</a></td>
</tr>`)}</tbody></table>`;
}

/** "Permissions" section of the user card: current role, what it allows, and the button to change it. */
function permissionsCard(req, u, isSelf) {
  const isAdmin = u.role === 'admin';
  let action;
  if (isSelf) {
    action = html`<p class="muted">לא ניתן לשנות את ההרשאות של עצמך. מנהל אחר יכול לעשות זאת.</p>`;
  } else if (isAdmin) {
    action = actionButton(req, `/admin/users/${u.id}/remove-admin`, 'הסרת הרשאת מנהל', {
      cls: 'btn-danger', confirm: `להסיר את הרשאת המנהל של ${fullName(u)}? הוא/היא יחזרו להיות משתמש/ת רגיל/ה.`,
    });
  } else if (u.status !== 'active') {
    action = html`<p class="muted">ניתן למנות למנהל רק משתמש פעיל. יש לאשר את המשתמש קודם.</p>`;
  } else {
    action = actionButton(req, `/admin/users/${u.id}/make-admin`, 'הפיכה למנהל', {
      cls: 'btn-primary', confirm: `לתת ל־${fullName(u)} הרשאות מנהל מלאות? מנהל יכול לאשר משתמשים והזמנות, לצפות ברישיונות נהיגה ולשנות הגדרות.`,
    });
  }
  return html`<section class="card" id="permissions">
  <h2>הרשאות</h2>
  <p>תפקיד נוכחי: ${isAdmin ? badge('admin', 'מנהל מערכת') : badge('completed', 'משתמש רגיל')}</p>
  <p class="muted small">${isAdmin
    ? 'גישה מלאה לממשק הניהול: אישור משתמשים והזמנות, צפייה ברישיונות נהיגה, ניהול הרכב, הנהלים וההגדרות. מקבל את התראות המנהל במייל.'
    : 'יכול להזמין את הרכב ולנהל את ההזמנות והפרטים שלו בלבד.'}</p>
  ${isAdmin && !u.totp_enabled ? html`<p class="small">⚠️ למנהל זה אין אימות דו־שלבי. מומלץ לבקש ממנו להפעיל אותו (אזור אישי ← סיסמה ואבטחה).</p>` : ''}
  ${action}
</section>`;
}

/** Settings page: is "Sign in with Google" set up, and what exactly to enter in Google Cloud Console. */
function googleStatusCard(req) {
  const g = google.status();
  const check = (ok, text) => html`<li>${ok ? '✅' : '❌'} ${text}</li>`;
  const here = `${req.protocol}://${req.get('host')}`;
  return html`<section class="card" id="google">
  <h2>התחברות עם Google</h2>
  <p>${g.enabled ? badge('active', 'מופעלת') : badge('blocked', 'לא מופעלת')}
    ${g.enabled ? 'הכפתור מוצג בדפי ההתחברות וההרשמה.' : 'הכפתור מוסתר עד שההגדרה תושלם.'}</p>
  <ul class="plain">
    ${check(g.clientIdSet, html`<code>GOOGLE_CLIENT_ID</code> מוגדר ב־.env`)}
    ${g.clientIdSet && !g.clientIdLooksRight ? html`<li>⚠️ ה־Client ID אמור להסתיים ב־<code>.apps.googleusercontent.com</code></li>` : ''}
    ${check(g.secretSet, html`<code>GOOGLE_CLIENT_SECRET</code> מוגדר ב־.env`)}
    ${check(here === g.origin, html`האתר פתוח בכתובת שב־<code>BASE_URL</code> (${g.origin})`)}
  </ul>
  ${here !== g.origin ? html`<p class="small">⚠️ פתחת את האתר בכתובת <code>${here}</code>. Google יחזיר את המשתמשים רק לכתובת <code>${g.origin}</code>,
    ולכן כפתור Google יפעל רק שם. כדי להשתמש בכתובת אחרת, יש לעדכן את <code>BASE_URL</code> ב־.env.</p>` : ''}
  <h3>מה להזין ב־Google Cloud Console</h3>
  <p class="small">APIs &amp; Services ← Credentials ← OAuth client ID (Web application):</p>
  <dl class="dl small">
    <dt>Authorized JavaScript origins</dt><dd><code>${g.origin}</code></dd>
    <dt>Authorized redirect URIs</dt><dd><code>${g.redirectUri}</code></dd>
  </dl>
  <p class="muted small">כל עוד מסך ההסכמה (OAuth consent screen) במצב <b>Testing</b>, רק חשבונות שהוספו ב־<b>Test users</b> יכולים להתחבר.
    אחרי עריכת .env יש להפעיל מחדש את השרת.</p>
  ${g.lastError ? html`<div class="flash flash-error small"><b>שגיאה אחרונה (${time.fmt(time.toLocal(g.lastError.at))}):</b>
    <code>${g.lastError.message}</code></div>` : ''}
</section>`;
}

function userOptions(selected) {
  const users = db.prepare("SELECT * FROM users WHERE status = 'active' ORDER BY first_name, last_name").all();
  return users.map((u) => html`<option value="${u.id}" ${u.id === Number(selected) ? 'selected' : ''}>${fullName(u)} (${u.email})</option>`);
}

module.exports = ({ app, requireAdmin }) => {
  // ---------- Dashboard ----------
  app.get('/admin', requireAdmin, (req, res) => {
    const s = getSettings();
    const now = time.now();
    const today = time.today();
    const v = defaultVehicle();
    const pendingUsers = db.prepare("SELECT * FROM users WHERE status = 'pending' ORDER BY created_at").all();
    const pendingLicenses = db.prepare('SELECT * FROM users WHERE pending_license_file IS NOT NULL').all();
    const pendingBookings = db.prepare(`SELECT b.*, u.first_name, u.last_name FROM bookings b JOIN users u ON u.id = b.user_id
      WHERE b.status = 'pending' AND b.end_at > ? ORDER BY b.start_at`).all(now);
    const upcoming = db.prepare(`SELECT b.*, u.first_name, u.last_name FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE b.status = 'approved' AND b.end_at > ? AND b.start_at < ? ORDER BY b.start_at`).all(now, time.addDays(today, 14) + 'T00:00');
    const licenses = db.prepare(`SELECT * FROM users WHERE status IN ('active','license_update') AND role = 'user'
      AND license_expiry <= ? ORDER BY license_expiry`).all(time.addDays(today, s.license_warn_days));
    const vehicleAlerts = [];
    if (v.status !== 'available') vehicleAlerts.push(`הרכב בסטטוס "${VEHICLE_STATUS[v.status]}"`);
    for (const [key, label] of [['insurance_renewal', 'חידוש ביטוח'], ['registration_renewal', 'חידוש רישיון רכב'], ['next_service', 'טיפול']]) {
      if (v[key] && v[key] <= time.addDays(today, 30)) vehicleAlerts.push(`${label}: ${time.fmt(v[key])}${v[key] < today ? ' (עבר!)' : ''}`);
    }

    res.page('לוח בקרה', html`
<h1>לוח בקרה</h1>
${!req.user.totp_enabled ? html`<div class="flash flash-warning">מומלץ להפעיל אימות דו־שלבי לחשבון המנהל. <a href="/me/security">להפעלה</a></div>` : ''}
<div class="stats">
  <a class="stat ${pendingUsers.length ? 'hot' : ''}" href="/admin/users?status=pending"><b>${pendingUsers.length}</b><span>משתמשים ממתינים</span></a>
  <a class="stat ${pendingBookings.length ? 'hot' : ''}" href="/admin/bookings?status=pending"><b>${pendingBookings.length}</b><span>בקשות ממתינות</span></a>
  <a class="stat" href="/admin/bookings?status=approved"><b>${upcoming.length}</b><span>הזמנות ב־14 הימים הקרובים</span></a>
  <a class="stat ${licenses.length ? 'warn' : ''}" href="/admin/users?status=license_update"><b>${licenses.length}</b><span>רישיונות שפגו / עומדים לפוג</span></a>
</div>

${vehicleAlerts.length ? html`<div class="card alert"><h2>התראות רכב</h2><ul>${vehicleAlerts.map((a) => html`<li>${a}</li>`)}</ul><a href="/admin/vehicle">לניהול הרכב</a></div>` : ''}

<div class="grid2">
  <section class="card">
    <h2>בקשות הזמנה ממתינות</h2>
    ${bookingsTable(pendingBookings)}
  </section>
  <section class="card">
    <h2>משתמשים ורישיונות לבדיקה</h2>
    ${pendingUsers.length || pendingLicenses.length ? html`<ul class="plain">
      ${pendingUsers.map((u) => html`<li><a href="/admin/users/${u.id}">${fullName(u)}</a> – הרשמה חדשה (${time.fmt(u.created_at)})</li>`)}
      ${pendingLicenses.map((u) => html`<li><a href="/admin/users/${u.id}">${fullName(u)}</a> – רישיון חדש לבדיקה</li>`)}
    </ul>` : html`<p class="muted">אין פריטים לבדיקה.</p>`}
    ${licenses.length ? html`<h3>תוקף רישיונות</h3><ul class="plain">${licenses.map((u) => html`<li>
      <a href="/admin/users/${u.id}">${fullName(u)}</a> – ${time.fmt(u.license_expiry)} ${u.license_expiry < today ? badge('blocked', 'פג') : badge('pending', 'בקרוב')}</li>`)}</ul>` : ''}
  </section>
</div>
<section class="card">
  <div class="page-head"><h2>ההזמנות הקרובות</h2>
    <div><a class="btn btn-light btn-sm" href="/admin/bookings/new">הזמנה ידנית</a> <a class="btn btn-light btn-sm" href="/admin/blocks/new">חסימת מועד</a> <a class="btn btn-light btn-sm" href="/calendar">ליומן</a></div></div>
  ${bookingsTable(upcoming)}
</section>`);
  });

  // ---------- Users ----------
  app.get('/admin/users', requireAdmin, (req, res) => {
    const status = USER_STATUS[req.query.status] ? req.query.status : '';
    const q = String(req.query.q || '').trim();
    const role = ['admin', 'user'].includes(req.query.role) ? req.query.role : '';
    const where = [];
    const args = [];
    if (status) { where.push('status = ?'); args.push(status); }
    if (role) { where.push('role = ?'); args.push(role); }
    if (q) { where.push("(first_name || ' ' || last_name LIKE ? OR email LIKE ? OR phone LIKE ? OR id_number LIKE ?)"); args.push(...Array(4).fill(`%${q}%`)); }
    const users = db.prepare(`SELECT * FROM users ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY
      CASE status WHEN 'pending' THEN 0 WHEN 'license_update' THEN 1 ELSE 2 END, created_at DESC`).all(...args);
    res.page('משתמשים', html`
<h1>משתמשים</h1>
<form class="filters" method="get">
  <input name="q" value="${q}" placeholder="חיפוש לפי שם, מייל, טלפון או ת״ז">
  <select name="status"><option value="">כל הסטטוסים</option>
    ${Object.entries(USER_STATUS).map(([k, l]) => html`<option value="${k}" ${k === status ? 'selected' : ''}>${l}</option>`)}</select>
  <select name="role"><option value="">כל התפקידים</option>
    <option value="admin" ${role === 'admin' ? 'selected' : ''}>מנהלים</option>
    <option value="user" ${role === 'user' ? 'selected' : ''}>משתמשים רגילים</option></select>
  <button class="btn btn-light">סינון</button>
</form>
<p class="muted small">למינוי מנהל: פותחים את כרטיס המשתמש ← "הרשאות" ← "הפיכה למנהל".</p>
<table class="table">
<thead><tr><th>שם</th><th>דואר אלקטרוני</th><th>טלפון</th><th>תוקף רישיון</th><th>סטטוס</th><th></th></tr></thead>
<tbody>${users.map((u) => html`<tr>
  <td data-label="שם">${fullName(u)} ${u.role === 'admin' ? badge('admin', 'מנהל') : ''}</td>
  <td data-label="מייל">${u.email}</td>
  <td data-label="טלפון">${u.phone}</td>
  <td data-label="רישיון">${time.fmt(u.license_expiry)} ${u.pending_license_file ? badge('pending', 'חדש לבדיקה') : ''}</td>
  <td data-label="סטטוס">${userBadge(u.status)}</td>
  <td><a href="/admin/users/${u.id}">כרטיס משתמש</a></td>
</tr>`)}</tbody></table>
${users.length ? '' : html`<p class="muted">לא נמצאו משתמשים.</p>`}`);
  });

  app.get('/admin/users/:id', requireAdmin, (req, res) => {
    const u = getUser(req.params.id);
    if (!u) return res.status(404).page('לא נמצא', html`<h1>המשתמש לא נמצא</h1>`);
    const list = db.prepare("SELECT * FROM bookings WHERE user_id = ? AND kind = 'booking' ORDER BY start_at DESC").all(u.id);
    const acceptances = db.prepare('SELECT * FROM policy_acceptances WHERE user_id = ? ORDER BY id DESC').all(u.id);
    const log = db.prepare('SELECT a.*, x.first_name, x.last_name FROM audit_log a LEFT JOIN users x ON x.id = a.actor_id WHERE target_type = ? AND target_id = ? ORDER BY a.id DESC LIMIT 30').all('user', u.id);
    const preview = (pending) => {
      const file = pending ? u.pending_license_file : u.license_file;
      if (!file) return html`<p class="muted">לא הועלה קובץ.</p>`;
      const src = `/admin/users/${u.id}/license${pending ? '?pending=1' : ''}`;
      return file.endsWith('.pdf') || file.endsWith('.heic')
        ? html`<p><a class="btn btn-light" href="${src}" target="_blank">פתיחת הקובץ</a></p>`
        : html`<a href="${src}" target="_blank"><img class="license-img" src="${src}" alt="רישיון נהיגה"></a>`;
    };
    const isSelf = u.id === req.user.id;
    res.page(fullName(u), html`
<p><a href="/admin/users">→ חזרה לרשימה</a></p>
<div class="page-head"><h1>${fullName(u)} ${u.role === 'admin' ? badge('admin', 'מנהל') : ''}</h1>${userBadge(u.status)}</div>
<div class="grid2">
  <section class="card">
    <h2>פרטים</h2>
    <dl class="dl">
      <dt>ת"ז</dt><dd>${u.id_number}</dd>
      <dt>טלפון</dt><dd><a href="tel:${u.phone}">${u.phone}</a></dd>
      <dt>דואר אלקטרוני</dt><dd><a href="mailto:${u.email}">${u.email}</a></dd>
      <dt>נרשם</dt><dd>${time.fmt(u.created_at)}</dd>
      <dt>מדיניות פרטיות</dt><dd>${u.privacy_accepted_at ? 'אושרה ' + time.fmt(u.privacy_accepted_at) : '—'}</dd>
      <dt>אישורי נהלים</dt><dd>${acceptances.map((a) => html`גרסה ${a.policy_version} – ${time.fmt(a.accepted_at)}<br>`)}</dd>
      <dt>אימות דו־שלבי</dt><dd>${u.totp_enabled ? 'פעיל' : 'לא פעיל'}</dd>
    </dl>
    ${postForm(req, `/admin/users/${u.id}/note`, html`
      ${field('הערת מנהל (פנימית)', html`<textarea name="admin_note" rows="2">${u.admin_note}</textarea>`)}
      <button class="btn btn-light btn-sm">שמירת הערה</button>`)}
  </section>

  <section class="card">
    <h2>רישיון נהיגה</h2>
    <p>תוקף: <b>${time.fmt(u.license_expiry)}</b> ${u.license_verified ? badge('active', 'אומת') : badge('pending', 'טרם אומת')}
      ${u.license_expiry && u.license_expiry < time.today() ? badge('blocked', 'פג תוקף') : ''}</p>
    ${preview(false)}
    ${u.pending_license_file ? html`
      <h3>רישיון חדש שהועלה – תוקף ${time.fmt(u.pending_license_expiry)}</h3>
      ${preview(true)}
      ${postForm(req, `/admin/users/${u.id}/license/approve`, html`
        ${field('תאריך תוקף (לאחר בדיקה)', html`<input type="date" name="license_expiry" value="${u.pending_license_expiry}" required>`)}
        <button class="btn btn-primary">אישור הרישיון החדש</button>`)}
      ${actionButton(req, `/admin/users/${u.id}/license/reject`, 'דחיית הרישיון החדש', { cls: 'btn-danger', note: true })}` : ''}
  </section>
</div>

<section class="card">
  <h2>פעולות</h2>
  ${isSelf ? html`<p class="muted">לא ניתן לשנות את סטטוס החשבון שלך.</p>` : html`<div class="actions-grid">
    ${['pending', 'license_update', 'rejected', 'blocked'].includes(u.status) && !u.pending_license_file ? postForm(req, `/admin/users/${u.id}/approve`, html`
      ${field('תוקף רישיון שאומת', html`<input type="date" name="license_expiry" value="${u.license_expiry}" required>`)}
      <button class="btn btn-primary">${u.status === 'blocked' ? 'הפעלה מחדש' : 'אישור המשתמש והרישיון'}</button>`, 'class="action-box"') : ''}
    ${u.status === 'pending' ? actionButton(req, `/admin/users/${u.id}/reject`, 'דחיית ההרשמה', { cls: 'btn-danger', note: true, confirm: 'לדחות את המשתמש?' }) : ''}
    ${['active', 'pending'].includes(u.status) ? actionButton(req, `/admin/users/${u.id}/request-license`, 'בקשת רישיון חדש', { cls: 'btn-light', note: true }) : ''}
    ${u.status !== 'blocked' ? actionButton(req, `/admin/users/${u.id}/block`, 'חסימת המשתמש', { cls: 'btn-danger', note: true, confirm: 'לחסום את המשתמש? הזמנות עתידיות לא יבוטלו אוטומטית.' }) : ''}
  </div>`}
</section>

${permissionsCard(req, u, isSelf)}

<section class="card">
  <h2>היסטוריית הזמנות</h2>
  ${bookingsTable(list, { showUser: false })}
</section>
<section class="card">
  <h2>יומן פעולות</h2>
  ${log.length ? html`<ul class="plain small">${log.map((a) => html`<li>${time.fmt(a.at)} – ${a.action} ${a.details ? '(' + a.details + ')' : ''} ${a.first_name ? '· ' + fullName(a) : ''}</li>`)}</ul>` : html`<p class="muted">אין פעולות.</p>`}
</section>`);
  });

  // License images are never public: served only here, to admins, with no caching.
  app.get('/admin/users/:id/license', requireAdmin, (req, res) => {
    const u = getUser(req.params.id);
    const file = u && (req.query.pending ? u.pending_license_file : u.license_file);
    const full = file && path.join(config.uploadsDir, path.basename(file));
    if (!full || !fs.existsSync(full)) return res.sendStatus(404);
    audit(req.user.id, 'license.view', 'user', u.id);
    res.set('Cache-Control', 'private, no-store');
    res.sendFile(full, { headers: { 'Content-Disposition': 'inline' } });
  });

  const userAction = (name, handler) => app.post(`/admin/users/:id/${name}`, requireAdmin, async (req, res) => {
    const u = getUser(req.params.id);
    if (!u) return res.sendStatus(404);
    if (u.id === req.user.id && name !== 'note') {
      res.flash('error', 'לא ניתן לבצע פעולה זו על החשבון שלך');
      return res.redirect(`/admin/users/${u.id}`);
    }
    const note = String(req.body.note || '').trim().slice(0, 500);
    const msg = await handler(u, req, note);
    if (msg) res.flash(msg.type || 'success', msg.text || msg);
    res.redirect(`/admin/users/${u.id}`);
  });

  userAction('approve', async (u, req) => {
    const expiry = String(req.body.license_expiry || '');
    if (!time.isValidDate(expiry) || expiry < time.today()) return { type: 'error', text: 'לא ניתן לאשר: תוקף הרישיון אינו עתידי' };
    db.prepare("UPDATE users SET status = 'active', license_verified = 1, license_expiry = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(expiry, u.id);
    audit(req.user.id, 'user.approve', 'user', u.id, `רישיון עד ${expiry}`);
    await mail.userApproved(u);
    return 'המשתמש אושר';
  });

  userAction('reject', async (u, req, note) => {
    db.prepare("UPDATE users SET status = 'rejected' WHERE id = ?").run(u.id);
    audit(req.user.id, 'user.reject', 'user', u.id, note);
    await mail.userRejected(u, note);
    return 'ההרשמה נדחתה';
  });

  userAction('block', async (u, req, note) => {
    db.prepare("UPDATE users SET status = 'blocked' WHERE id = ?").run(u.id);
    auth.destroyAllSessions(u.id);
    audit(req.user.id, 'user.block', 'user', u.id, note);
    await mail.userBlocked(u, note);
    const open = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND status IN ('pending','approved') AND end_at > ?").get(u.id, time.now()).n;
    return open ? { type: 'warning', text: `המשתמש נחסם. שימו לב: יש לו ${open} הזמנות פתוחות שלא בוטלו.` } : 'המשתמש נחסם';
  });

  userAction('request-license', async (u, req, note) => {
    db.prepare("UPDATE users SET status = 'license_update' WHERE id = ?").run(u.id);
    audit(req.user.id, 'user.request_license', 'user', u.id, note);
    await mail.licenseRequested(u, note);
    return 'נשלחה בקשה להעלאת רישיון חדש';
  });

  userAction('license/approve', async (u, req) => {
    const expiry = String(req.body.license_expiry || '');
    if (!u.pending_license_file) return { type: 'error', text: 'אין רישיון חדש לאישור' };
    if (!time.isValidDate(expiry) || expiry < time.today()) return { type: 'error', text: 'תוקף הרישיון אינו עתידי' };
    if (u.license_file) fs.rmSync(path.join(config.uploadsDir, u.license_file), { force: true });
    const status = u.status === 'license_update' ? 'active' : u.status;
    db.prepare(`UPDATE users SET license_file = pending_license_file, license_expiry = ?, license_verified = 1,
      pending_license_file = NULL, pending_license_expiry = NULL, status = ? WHERE id = ?`).run(expiry, status, u.id);
    audit(req.user.id, 'user.license_approve', 'user', u.id, expiry);
    if (status === 'active' && u.status !== 'active') await mail.userApproved(u);
    return status === 'pending' ? 'הרישיון אושר. יש לאשר גם את המשתמש' : 'הרישיון החדש אושר';
  });

  userAction('license/reject', async (u, req, note) => {
    if (u.pending_license_file) fs.rmSync(path.join(config.uploadsDir, u.pending_license_file), { force: true });
    db.prepare('UPDATE users SET pending_license_file = NULL, pending_license_expiry = NULL WHERE id = ?').run(u.id);
    audit(req.user.id, 'user.license_reject', 'user', u.id, note);
    await mail.licenseRequested(u, note || 'הרישיון שהועלה לא אושר');
    return 'הרישיון נדחה והמשתמש התבקש להעלות רישיון אחר';
  });

  userAction('make-admin', async (u, req) => {
    if (u.role === 'admin') return { type: 'warning', text: 'המשתמש כבר מנהל' };
    if (u.status !== 'active') return { type: 'error', text: 'ניתן למנות למנהל רק משתמש פעיל. יש לאשר את המשתמש קודם' };
    db.prepare("UPDATE users SET role = 'admin', updated_at = datetime('now','localtime') WHERE id = ?").run(u.id);
    audit(req.user.id, 'user.make_admin', 'user', u.id);
    await mail.roleChanged(u, true);
    return `${fullName(u)} מונה למנהל ונשלחה אליו הודעה`;
  });

  userAction('remove-admin', async (u, req) => {
    if (u.role !== 'admin') return { type: 'warning', text: 'המשתמש אינו מנהל' };
    db.prepare("UPDATE users SET role = 'user', updated_at = datetime('now','localtime') WHERE id = ?").run(u.id);
    audit(req.user.id, 'user.remove_admin', 'user', u.id);
    await mail.roleChanged(u, false);
    return `הרשאת המנהל של ${fullName(u)} הוסרה`;
  });

  userAction('note', async (u, req) => {
    db.prepare('UPDATE users SET admin_note = ? WHERE id = ?').run(String(req.body.admin_note || '').slice(0, 2000), u.id);
    return 'ההערה נשמרה';
  });

  // ---------- Bookings ----------
  app.get('/admin/bookings', requireAdmin, (req, res) => {
    const status = bookings.STATUS_LABELS[req.query.status] ? req.query.status : '';
    const q = String(req.query.q || '').trim();
    const from = time.isValidDate(req.query.from) ? req.query.from : '';
    const to = time.isValidDate(req.query.to) ? req.query.to : '';
    const kind = ['booking', 'block'].includes(req.query.kind) ? req.query.kind : '';
    const vehicles = db.prepare('SELECT * FROM vehicles ORDER BY id').all();
    const vehicleId = Number(req.query.vehicle) || 0;
    const where = [];
    const args = [];
    if (status) { where.push('b.status = ?'); args.push(status); }
    if (kind) { where.push('b.kind = ?'); args.push(kind); }
    if (vehicleId) { where.push('b.vehicle_id = ?'); args.push(vehicleId); }
    if (q) { where.push("(u.first_name || ' ' || u.last_name LIKE ? OR u.email LIKE ? OR b.block_reason LIKE ? OR b.purpose LIKE ?)"); args.push(...Array(4).fill(`%${q}%`)); }
    if (from) { where.push('b.end_at > ?'); args.push(from + 'T00:00'); }
    if (to) { where.push('b.start_at < ?'); args.push(time.addDays(to, 1) + 'T00:00'); }
    const list = db.prepare(`SELECT b.*, u.first_name, u.last_name FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE b.status WHEN 'pending' THEN 0 ELSE 1 END, b.start_at DESC LIMIT 500`).all(...args);
    res.page('הזמנות', html`
<div class="page-head"><h1>הזמנות</h1>
  <div><a class="btn btn-primary" href="/admin/bookings/new">הזמנה ידנית</a> <a class="btn btn-light" href="/admin/blocks/new">חסימת מועד</a></div></div>
<form class="filters" method="get">
  <input name="q" value="${q}" placeholder="שם משתמש, מייל או מטרה">
  <select name="status"><option value="">כל הסטטוסים</option>
    ${Object.entries(bookings.STATUS_LABELS).map(([k, l]) => html`<option value="${k}" ${k === status ? 'selected' : ''}>${l}</option>`)}</select>
  <select name="kind"><option value="">הזמנות וחסימות</option>
    <option value="booking" ${kind === 'booking' ? 'selected' : ''}>הזמנות בלבד</option>
    <option value="block" ${kind === 'block' ? 'selected' : ''}>חסימות בלבד</option></select>
  ${vehicles.length > 1 ? html`<select name="vehicle"><option value="">כל הרכבים</option>
    ${vehicles.map((v) => html`<option value="${v.id}" ${v.id === vehicleId ? 'selected' : ''}>${v.plate}</option>`)}</select>` : ''}
  <label class="inline-label">מ־<input type="date" name="from" value="${from}"></label>
  <label class="inline-label">עד<input type="date" name="to" value="${to}"></label>
  <button class="btn btn-light">סינון</button>
</form>
${bookingsTable(list)}`);
  });

  app.get('/admin/bookings/new', requireAdmin, (req, res) => {
    const start = time.isValidLocal(req.query.start) ? req.query.start : '';
    const end = start ? time.addMinutes(start, 120) : '';
    res.page('הזמנה ידנית', html`
<div class="narrow">
  <h1>הזמנה ידנית</h1>
  <p class="muted">הזמנה שהמנהל יוצרת עבור משתמש מאושרת מיד. לחסימת זמן לתחזוקה <a href="/admin/blocks/new?start=${start}">השתמשו בחסימת מועד</a>.</p>
  ${postForm(req, '/admin/bookings/new', html`
    ${field('משתמש', html`<select name="user_id" required><option value="">בחירה…</option>${userOptions(req.query.user)}</select>`)}
    <div class="grid2">
      ${field('איסוף', html`<input type="datetime-local" name="start" value="${start}" required>`)}
      ${field('החזרה', html`<input type="datetime-local" name="end" value="${end}" required>`)}
    </div>
    ${field('מטרה', html`<input name="purpose" maxlength="200">`)}
    ${field('הערות', html`<textarea name="notes" rows="2"></textarea>`)}
    <label class="check"><input type="checkbox" name="notify" value="1" checked> <span>שליחת מייל אישור למשתמש</span></label>
    <button class="btn btn-primary btn-block">יצירת הזמנה מאושרת</button>`, 'class="card"')}
</div>`);
  });

  app.post('/admin/bookings/new', requireAdmin, guarded((req) => `/admin/bookings/new?start=${encodeURIComponent(req.body.start || '')}`, async (req, res) => {
    const b = bookings.createManual(req.user.id, {
      vehicleId: defaultVehicle().id, userId: Number(req.body.user_id), start: String(req.body.start || ''), end: String(req.body.end || ''),
      purpose: String(req.body.purpose || '').trim(), notes: String(req.body.notes || '').trim(),
    });
    await mail.bookingApproved(b, { approvedBy: fullName(req.user), notifyUser: req.body.notify === '1' });
    res.flash('success', 'ההזמנה נוצרה ואושרה');
    res.redirect(`/admin/bookings/${b.id}`);
  }));

  app.get('/admin/blocks/new', requireAdmin, (req, res) => {
    const start = time.isValidLocal(req.query.start) ? req.query.start : '';
    res.page('חסימת מועד', html`
<div class="narrow">
  <h1>חסימת מועד ביומן</h1>
  <p class="muted">סימון שהרכב אינו זמין (טיפול, תקלה, שימוש פנימי) ללא יצירת הזמנה בשם משתמש.</p>
  ${postForm(req, '/admin/blocks/new', html`
    <div class="grid2">
      ${field('מ־', html`<input type="datetime-local" name="start" value="${start}" required>`)}
      ${field('עד', html`<input type="datetime-local" name="end" required>`)}
    </div>
    ${field('סיבה', html`<input name="reason" required maxlength="200" list="reasons" placeholder="טיפול תקופתי">`)}
    <datalist id="reasons"><option value="טיפול תקופתי"><option value="תקלה"><option value="שימוש פנימי"><option value="טסט"></datalist>
    <button class="btn btn-primary btn-block">חסימה</button>`, 'class="card"')}
</div>`);
  });

  app.post('/admin/blocks/new', requireAdmin, guarded('/admin/blocks/new', (req, res) => {
    const b = bookings.createBlock(req.user.id, {
      vehicleId: defaultVehicle().id, start: String(req.body.start || ''), end: String(req.body.end || ''), reason: String(req.body.reason || '').trim(),
    });
    res.flash('success', 'המועד נחסם ביומן');
    res.redirect(`/admin/bookings/${b.id}`);
  }));

  app.get('/admin/bookings/:id', requireAdmin, (req, res) => {
    const b = bookings.getBooking(Number(req.params.id));
    if (!b) return res.status(404).page('לא נמצא', html`<h1>ההזמנה לא נמצאה</h1>`);
    const history = db.prepare(`SELECT h.*, u.first_name, u.last_name FROM booking_history h LEFT JOIN users u ON u.id = h.actor_id
      WHERE booking_id = ? ORDER BY h.id`).all(b.id);
    const conflicts = b.status === 'pending' ? bookings.findConflicts(b.vehicle_id, b.start_at, b.end_at, { excludeId: b.id }) : [];
    const competing = ['pending', 'approved'].includes(b.status) ? bookings.findPendingOverlaps(b.vehicle_id, b.start_at, b.end_at, b.id) : [];
    const user = b.user_id ? getUser(b.user_id) : null;
    const problems = user && b.status === 'pending' ? bookings.eligibilityProblems(user, b.end_at) : [];
    res.page(`הזמנה #${b.id}`, html`
<p><a href="/admin/bookings">→ חזרה להזמנות</a></p>
<div class="page-head"><h1>${b.kind === 'block' ? 'חסימת יומן' : 'הזמנה'} #${b.id}</h1>${bookingBadge(b.status)}</div>
<div class="grid2">
  <section class="card">
    <dl class="dl">
      ${user ? html`<dt>משתמש</dt><dd><a href="/admin/users/${user.id}">${fullName(user)}</a> ${userBadge(user.status)}<br>
        <a href="tel:${user.phone}">${user.phone}</a> · ${user.email}</dd>` : html`<dt>סיבה</dt><dd>${b.block_reason}</dd>`}
      <dt>רכב</dt><dd>${b.make} ${b.model} (${b.plate})</dd>
      <dt>איסוף</dt><dd>${time.fmtLong(b.start_at)}</dd>
      <dt>החזרה</dt><dd>${time.fmtLong(b.end_at)}</dd>
      <dt>משך</dt><dd>${time.hoursBetween(b.start_at, b.end_at).toFixed(1)} שעות</dd>
      ${b.purpose ? html`<dt>מטרה</dt><dd>${b.purpose}</dd>` : ''}
      ${b.notes ? html`<dt>הערות</dt><dd class="pre">${b.notes}</dd>` : ''}
      <dt>נוצרה</dt><dd>${time.fmt(b.created_at)}</dd>
    </dl>
  </section>
  <section class="card">
    <h2>בדיקת זמינות</h2>
    ${b.status === 'pending' ? (conflicts.length
      ? html`<div class="flash flash-error">⚠️ המועד מתנגש עם:<ul>${conflicts.map((c) => html`<li><a href="/admin/bookings/${c.id}">
          ${c.kind === 'block' ? '🔧 ' + c.block_reason : fullName(c)}</a> ${time.fmt(c.start_at)}–${time.fmt(c.end_at)}</li>`)}</ul></div>`
      : html`<div class="flash flash-success">✓ הרכב פנוי במועד זה</div>`) : ''}
    ${problems.length ? html`<div class="flash flash-error">${problems.join('. ')}</div>` : ''}
    ${competing.length ? html`<p><b>בקשות ממתינות נוספות לאותו מועד:</b></p><ul>${competing.map((c) => html`<li>
      <a href="/admin/bookings/${c.id}">${fullName(c)}</a> ${time.fmt(c.start_at)}–${time.fmt(c.end_at)} (הוגשה ${time.fmt(c.created_at)})</li>`)}</ul>`
      : html`<p class="muted">אין בקשות מתחרות.</p>`}
    <div class="actions-grid">
      ${b.status === 'pending' ? actionButton(req, `/admin/bookings/${b.id}/approve`, 'אישור ההזמנה', { cls: 'btn-primary' }) : ''}
      ${b.status === 'pending' ? actionButton(req, `/admin/bookings/${b.id}/reject`, 'דחייה', { cls: 'btn-danger', note: true }) : ''}
      ${b.status === 'approved' ? actionButton(req, `/admin/bookings/${b.id}/cancel`, b.kind === 'block' ? 'הסרת החסימה' : 'ביטול ההזמנה', { cls: 'btn-danger', note: b.kind !== 'block', confirm: 'לבטל?' }) : ''}
    </div>
  </section>
</div>
<section class="card">
  <h2>היסטוריית שינויים</h2>
  <table class="table"><thead><tr><th>מועד</th><th>שינוי</th><th>על ידי</th><th>הערה</th></tr></thead><tbody>
  ${history.map((h) => html`<tr>
    <td data-label="מועד">${time.fmt(h.at)}</td>
    <td data-label="שינוי">${h.from_status ? bookings.STATUS_LABELS[h.from_status] + ' ← ' : ''}${bookings.STATUS_LABELS[h.to_status]}</td>
    <td data-label="על ידי">${h.actor_id ? fullName(h) : 'מערכת'}</td>
    <td data-label="הערה">${h.note || ''}</td></tr>`)}
  </tbody></table>
</section>`);
  });

  app.post('/admin/bookings/:id/approve', requireAdmin, guarded((req) => `/admin/bookings/${req.params.id}`, async (req, res) => {
    const b = bookings.approve(Number(req.params.id), req.user.id);
    await mail.bookingApproved(b, { approvedBy: fullName(req.user) });
    const competing = bookings.findPendingOverlaps(b.vehicle_id, b.start_at, b.end_at, b.id);
    res.flash(competing.length ? 'warning' : 'success', competing.length
      ? `ההזמנה אושרה ונשלח מייל למשתמש. יש ${competing.length} בקשות ממתינות נוספות לאותו מועד שכבר לא ניתן לאשר – מומלץ לדחות אותן.`
      : 'ההזמנה אושרה ונשלחו מיילי אישור למשתמש ולמנהלים');
    res.redirect(`/admin/bookings/${b.id}`);
  }));

  app.post('/admin/bookings/:id/reject', requireAdmin, guarded((req) => `/admin/bookings/${req.params.id}`, async (req, res) => {
    const note = String(req.body.note || '').trim().slice(0, 500);
    const b = bookings.reject(Number(req.params.id), req.user.id, note);
    await mail.bookingRejected(b, note);
    res.flash('success', 'הבקשה נדחתה והמשתמש עודכן');
    res.redirect('/admin/bookings?status=pending');
  }));

  app.post('/admin/bookings/:id/cancel', requireAdmin, guarded((req) => `/admin/bookings/${req.params.id}`, async (req, res) => {
    const note = String(req.body.note || '').trim().slice(0, 500);
    const b = bookings.cancel(Number(req.params.id), req.user, note);
    if (b.kind === 'booking') await mail.bookingCancelled(b, true, note);
    res.flash('success', b.kind === 'block' ? 'החסימה הוסרה' : 'ההזמנה בוטלה ונשלחה הודעה');
    res.redirect(`/admin/bookings/${b.id}`);
  }));

  // ---------- Vehicle ----------
  app.get('/admin/vehicle', requireAdmin, (req, res) => {
    const v = defaultVehicle();
    res.page('ניהול הרכב', html`
<div class="narrow">
  <h1>ניהול הרכב</h1>
  ${postForm(req, '/admin/vehicle', html`
    <div class="grid2">
      ${field('מספר רישוי', html`<input name="plate" value="${v.plate}" required>`)}
      ${field('סטטוס', html`<select name="status">${Object.entries(VEHICLE_STATUS).map(([k, l]) => html`<option value="${k}" ${k === v.status ? 'selected' : ''}>${l}</option>`)}</select>`,
        '"מושבת" חוסם הגשה ואישור של הזמנות')}
      ${field('יצרן', html`<input name="make" value="${v.make}">`)}
      ${field('דגם', html`<input name="model" value="${v.model}">`)}
      ${field('חידוש ביטוח', html`<input type="date" name="insurance_renewal" value="${v.insurance_renewal}">`)}
      ${field('חידוש רישיון רכב (טסט)', html`<input type="date" name="registration_renewal" value="${v.registration_renewal}">`)}
      ${field('טיפול הבא', html`<input type="date" name="next_service" value="${v.next_service}">`)}
    </div>
    ${field('הנחיות לנהג (יופיעו במייל האישור)', html`<textarea name="instructions" rows="3" placeholder="מיקום החניה, איסוף מפתח, כרטיס דלק…">${v.instructions}</textarea>`)}
    ${field('הערות מנהל (פנימי)', html`<textarea name="notes" rows="3">${v.notes}</textarea>`)}
    <button class="btn btn-primary btn-block">שמירה</button>`, 'class="card"')}
  <p><a href="/admin/blocks/new">חסימת מועד לטיפול או תחזוקה</a> · <a href="/admin/bookings?kind=block">חסימות קיימות</a></p>
</div>`);
  });

  app.post('/admin/vehicle', requireAdmin, (req, res) => {
    const v = defaultVehicle();
    const b = req.body;
    const date = (x) => (time.isValidDate(x) ? x : null);
    const status = VEHICLE_STATUS[b.status] ? b.status : v.status;
    db.prepare(`UPDATE vehicles SET plate = ?, make = ?, model = ?, status = ?, insurance_renewal = ?, registration_renewal = ?,
      next_service = ?, instructions = ?, notes = ? WHERE id = ?`).run(String(b.plate || v.plate).trim(), String(b.make || '').trim(),
      String(b.model || '').trim(), status, date(b.insurance_renewal), date(b.registration_renewal), date(b.next_service),
      String(b.instructions || '').trim(), String(b.notes || '').trim(), v.id);
    audit(req.user.id, 'vehicle.update', 'vehicle', v.id, status);
    res.flash('success', 'פרטי הרכב נשמרו');
    res.redirect('/admin/vehicle');
  });

  // ---------- Policies ----------
  app.get('/admin/policies', requireAdmin, (req, res) => {
    const p = currentPolicy();
    const versions = db.prepare(`SELECT p.version, p.created_at, p.requires_reaccept, COUNT(a.id) AS accepted
      FROM policies p LEFT JOIN policy_acceptances a ON a.policy_version = p.version GROUP BY p.version ORDER BY p.version DESC`).all();
    res.page('ניהול נהלים', html`
<h1>נהלי השאלת הרכב</h1>
<div class="grid2">
  ${postForm(req, '/admin/policies', html`
    <h2>עריכה – תיצור גרסה ${p.version + 1}</h2>
    ${field('תוכן הנהלים', html`<textarea name="content" rows="20" class="mono" required>${p.content}</textarea>`, 'כותרות: # / ## , רשימות: - , הדגשה: **טקסט**')}
    <label class="check"><input type="checkbox" name="requires_reaccept" value="1"> <span>שינוי מהותי – לדרוש מכל המשתמשים אישור מחדש לפני ההזמנה הבאה</span></label>
    <button class="btn btn-primary">פרסום גרסה חדשה</button>`, 'class="card"')}
  <section class="card">
    <h2>גרסאות</h2>
    <table class="table"><thead><tr><th>גרסה</th><th>פורסמה</th><th>אישור מחדש</th><th>אישורים</th></tr></thead><tbody>
    ${versions.map((x) => html`<tr><td data-label="גרסה">${x.version}</td><td data-label="פורסמה">${time.fmt(x.created_at)}</td>
      <td data-label="אישור מחדש">${x.requires_reaccept ? 'כן' : '—'}</td><td data-label="אישורים">${x.accepted}</td></tr>`)}
    </tbody></table>
    <h3>תצוגה מקדימה (גרסה נוכחית)</h3>
    <div class="prose">${markdown(p.content)}</div>
  </section>
</div>`);
  });

  app.post('/admin/policies', requireAdmin, (req, res) => {
    const content = String(req.body.content || '').trim();
    if (!content) { res.flash('error', 'התוכן ריק'); return res.redirect('/admin/policies'); }
    const version = currentPolicy().version + 1;
    db.prepare('INSERT INTO policies (version, content, requires_reaccept, created_by) VALUES (?, ?, ?, ?)')
      .run(version, content, req.body.requires_reaccept === '1' ? 1 : 0, req.user.id);
    audit(req.user.id, 'policy.publish', 'policy', version, req.body.requires_reaccept === '1' ? 'requires reaccept' : '');
    res.flash('success', `גרסה ${version} פורסמה`);
    res.redirect('/admin/policies');
  });

  // ---------- Settings & audit ----------
  app.get('/admin/settings', requireAdmin, (req, res) => {
    const s = getSettings();
    res.page('הגדרות', html`
<div class="narrow">
  <h1>הגדרות מערכת</h1>
  ${postForm(req, '/admin/settings', html`
    ${Object.entries(SETTING_LABELS).map(([k, [label, hint]]) => field(label, html`<input type="number" name="${k}" value="${s[k]}" min="0" step="1" required>`, hint))}
    <button class="btn btn-primary btn-block">שמירה</button>`, 'class="card"')}
  ${googleStatusCard(req)}
  <p><a href="/admin/audit">יומן פעולות מנהלים</a></p>
</div>`);
  });

  app.post('/admin/settings', requireAdmin, (req, res) => {
    for (const k of Object.keys(SETTING_LABELS)) {
      const n = Number(req.body[k]);
      if (Number.isInteger(n) && n >= 0) setSetting(k, n);
    }
    audit(req.user.id, 'settings.update', null, null, JSON.stringify(req.body, Object.keys(SETTING_LABELS)));
    res.flash('success', 'ההגדרות נשמרו');
    res.redirect('/admin/settings');
  });

  app.get('/admin/audit', requireAdmin, (req, res) => {
    const rows = db.prepare(`SELECT a.*, u.first_name, u.last_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.id DESC LIMIT 300`).all();
    const link = (r) => (r.target_type === 'user' ? `/admin/users/${r.target_id}` : r.target_type === 'booking' ? `/admin/bookings/${r.target_id}` : null);
    res.page('יומן פעולות', html`
<h1>יומן פעולות</h1>
<table class="table"><thead><tr><th>מועד</th><th>מבצע</th><th>פעולה</th><th>יעד</th><th>פרטים</th></tr></thead><tbody>
${rows.map((r) => html`<tr><td data-label="מועד">${time.fmt(r.at)}</td><td data-label="מבצע">${r.actor_id ? fullName(r) : 'מערכת'}</td>
  <td data-label="פעולה"><code>${r.action}</code></td>
  <td data-label="יעד">${link(r) ? html`<a href="${link(r)}">${r.target_type} #${r.target_id}</a>` : ''}</td>
  <td data-label="פרטים">${r.details}</td></tr>`)}
</tbody></table>`);
  });
};
