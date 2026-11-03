'use strict';
const path = require('node:path');
const { db, audit, getSettings, setSetting, currentPolicy, defaultVehicle, storageInfo } = require('../db');
const auth = require('../auth');
const mail = require('../mail');
const time = require('../time');
const config = require('../config');
const bookings = require('../bookings');
const google = require('../google');
const storage = require('../storage');
const { html, markdown, postForm, actionButton, field, badge, icon, pageHead, licenseInput, uploadLimitLabel, USER_STATUS, VEHICLE_STATUS } = require('../views/html');
const { validIsraeliId, normalizePhone, validPhone, validEmail } = require('./public');

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
  if (!list.length) return html`<p class="empty">${icon('calendar', 28)}<span>אין רשומות.</span></p>`;
  return html`<table class="table">
<thead><tr>${showUser ? html`<th>משתמש</th>` : ''}<th>איסוף</th><th>החזרה</th><th>מטרה</th><th>סטטוס</th><th></th></tr></thead>
<tbody>${list.map((b) => html`<tr>
  ${showUser ? html`<td data-label="משתמש">${b.kind === 'block' ? html`<span class="note-line">${icon('wrench', 16)} ${b.block_reason}</span>` : fullName(b)}</td>` : ''}
  <td data-label="איסוף">${time.fmt(b.start_at)}</td>
  <td data-label="החזרה">${time.fmt(b.end_at)}</td>
  <td data-label="מטרה">${b.purpose || '—'}</td>
  <td data-label="סטטוס">${b.kind === 'block' ? badge('block', 'חסימה') : ''} ${bookingBadge(b.status)}</td>
  <td><a class="btn btn-light btn-sm" href="/admin/bookings/${b.id}">פרטים</a></td>
</tr>`)}</tbody></table>`;
}

/**
 * The message after an approval, built from what really happened to the e-mails (mail.bookingApproved's outcome)
 * rather than assuming they went out. Returns [flashType, text].
 */
function approvalNotice(b, sent, { notifyUser = true } = {}) {
  if (!sent.delivered) {
    return ['warning', 'ההזמנה אושרה, אבל המיילים לא נשלחו בפועל: לא הוגדר שרת דואר (SMTP), ולכן הם נשמרו רק בתיקייה data/outbox. '
      + 'ההגדרה מוסברת בהגדרות ← שליחת מיילים.'];
  }
  if (notifyUser && sent.user === false) {
    return ['warning', `ההזמנה אושרה, אבל שליחת מייל האישור אל ${b.email} נכשלה. פרטי השגיאה מופיעים בהגדרות ← שליחת מיילים.`];
  }
  const toUser = notifyUser && sent.user ? `נשלח מייל אישור אל ${b.email}` : 'לא נשלח מייל למשתמש';
  if (sent.admins === false) return ['warning', `ההזמנה אושרה (${toUser}), אבל שליחת העותק למנהלים נכשלה.`];
  return ['success', `ההזמנה אושרה. ${toUser}${sent.admins ? ' ועותק למנהלים' : ''}.`];
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
  <h2 class="section-title">${icon('shield')} הרשאות</h2>
  <p>תפקיד נוכחי: ${isAdmin ? badge('admin', 'מנהל מערכת') : badge('completed', 'משתמש רגיל')}</p>
  <p class="muted small">${isAdmin
    ? 'גישה מלאה לממשק הניהול: אישור משתמשים והזמנות, צפייה ברישיונות נהיגה, ניהול הרכב, הנהלים וההגדרות. מקבל את התראות המנהל במייל.'
    : 'יכול להזמין את הרכב ולנהל את ההזמנות והפרטים שלו בלבד.'}</p>
  ${action}
</section>`;
}

/** Settings page: which version runs and where the data is kept, so "is my data saved between versions?" is visible. */
function systemCard() {
  const s = storageInfo();
  const env = process.env;
  const commit = (env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7);
  const count = (sql) => db.prepare(sql).get().n;
  const leftovers = config.onVercel ? ['DATA_DIR', 'ALLOW_TEMPORARY_DATA', 'DB_FILE'].filter((k) => env[k]) : [];
  return html`<section class="card" id="system">
  <h2 class="section-title">${icon('settings')} מערכת ונתונים</h2>
  ${s.perDeployment ? html`<div class="flash flash-error small"><b>מסד נתונים חדש לכל גרסה:</b> מסד הנתונים הזה נוצר במיוחד לפריסה הזו
      על ידי האינטגרציה של Turso ב־Vercel, ולכן הנתונים לא יעברו לגרסה הבאה. יש להגדיר <code>LIBSQL_URL</code> ו־<code>LIBSQL_AUTH_TOKEN</code>
      של מסד נתונים קבוע אחד (פירוט ב־docs/vercel.md).</div>`
    : s.kind === 'hosted'
    ? html`<div class="flash flash-success small">הנתונים נשמרים במסד נתונים קבוע (Turso) ונשארים בין גרסאות.</div>`
    : s.kind === 'temporary'
      ? html`<div class="flash flash-error small"><b>הנתונים זמניים:</b> הם נשמרים בקובץ על השרת ונמחקים בכל גרסה חדשה. יש לחבר מסד נתונים (Turso) לסביבה הזו.</div>`
      : html`<p class="small">הנתונים נשמרים בקובץ <code dir="ltr">${s.file}</code>.</p>`}
  ${leftovers.length ? html`<div class="flash flash-warning small">ב־Vercel מוגדרים ${leftovers.join(', ')}, שלא צריכים להיות שם. יש למחוק אותם ולבצע Redeploy.</div>` : ''}
  <dl class="dl small">
    ${env.VERCEL_ENV ? html`<dt>סביבה</dt><dd>${env.VERCEL_ENV === 'production' ? 'Production (main)' : `${env.VERCEL_ENV} (${env.VERCEL_GIT_COMMIT_REF || '—'})`}</dd>` : ''}
    ${commit ? html`<dt>גרסה</dt><dd><code>${commit}</code> ${env.VERCEL_GIT_COMMIT_MESSAGE ? html`<span class="muted">${env.VERCEL_GIT_COMMIT_MESSAGE.split('\n')[0].slice(0, 80)}</span>` : ''}</dd>` : ''}
    ${s.host ? html`<dt>מסד נתונים</dt><dd><code dir="ltr">${s.host}</code> <span class="muted">(מתוך ${s.from})</span></dd>` : ''}
    <dt>מזהה מסד הנתונים</dt><dd><code>${s.id}</code> <span class="muted">נוצר ${time.fmt(s.createdAt)}</span></dd>
    <dt>נתונים</dt><dd>${count('SELECT COUNT(*) AS n FROM users')} משתמשים · ${count("SELECT COUNT(*) AS n FROM bookings WHERE kind = 'booking'")} הזמנות</dd>
  </dl>
  <p class="muted small">אחרי פריסה של גרסה חדשה, מזהה מסד הנתונים חייב להישאר זהה. אם הוא השתנה, הגרסה החדשה מחוברת למסד נתונים אחר (או חדש).</p>
</section>`;
}

/** Settings page: how e-mail is sent, the last delivery error, and a test button. */
function emailStatusCard(req) {
  const m = mail.status();
  const admins = mail.adminEmails();
  return html`<section class="card" id="email">
  <h2 class="section-title">${icon('file')} שליחת מיילים</h2>
  ${m.configured
    ? html`<p>${m.verified === false ? badge('blocked', 'שגיאה') : badge('active', 'מוגדר')}
        שרת: <code>${m.host}:${m.port}</code> ${m.secure ? '(TLS)' : '(STARTTLS)'} · משתמש: <code>${m.user || '—'}</code> · שולח: <code>${m.from}</code></p>`
    : config.onVercel || config.production
      ? html`<div class="flash flash-error small"><b>מיילים לא נשלחים:</b> באתר הזה לא הוגדר שרת דואר (<code>SMTP_HOST</code>),
          ולכן מנהלים ולקוחות לא מקבלים שום מייל.</div>
        <p class="small">${config.onVercel
          ? html`להגדרה: ב־Vercel ← Project ← <b>Settings ← Environment Variables</b> מוסיפים <code>SMTP_HOST</code>, <code>SMTP_PORT</code>,
            <code>SMTP_USER</code>, <code>SMTP_PASS</code> (מסומנים ל־Production), ואז <b>Deployments ← ⋯ ← Redeploy</b>. משתנים חלים רק על פריסה חדשה.`
          : html`להגדרה מוסיפים <code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_USER</code>, <code>SMTP_PASS</code> למשתני הסביבה ומפעילים מחדש.`}
          פירוט: <code>docs/email-setup.md</code>.</p>`
      : html`<p>${badge('pending', 'לא מוגדר')} לא הוגדר שרת דואר (<code>SMTP_HOST</code>), ולכן מיילים <b>לא נשלחים</b>:
        הם נשמרים בתיקייה <code>data/outbox</code>, וקודי התחברות מודפסים בחלון השרת. להגדרה (למשל Gmail) ראו README ← "מיילים אמיתיים".</p>`}
  ${m.lastError ? html`<div class="flash flash-error small"><b>שגיאה אחרונה (${time.fmt(time.toLocal(m.lastError.at))}):</b> <code>${m.lastError.message}</code>
    ${/Invalid login|Username and Password not accepted|535/i.test(m.lastError.message) ? html`<br>שם המשתמש או הסיסמה נדחו. ב־Gmail יש להשתמש ב־App password (לא בסיסמה הרגילה).` : ''}
    ${/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|Greeting never received|timeout/i.test(m.lastError.message) ? html`<br>אין חיבור לשרת הדואר: בדקו את SMTP_HOST ו־SMTP_PORT (ב־Gmail: 465), ושחומת האש מאפשרת יציאה.` : ''}</div>` : ''}
  ${admins.length
    ? html`<p class="small">הודעות על בקשות הזמנה חדשות נשלחות אל המנהלים הפעילים: <span dir="ltr">${admins.join(', ')}</span></p>`
    : html`<div class="flash flash-warning small">אין מנהל פעיל, ולכן אף אחד לא יקבל הודעה על בקשות הזמנה חדשות.</div>`}
  ${m.lastSentAt && m.configured ? html`<p class="muted small">מייל אחרון נשלח בהצלחה: ${time.fmt(time.toLocal(m.lastSentAt))}</p>` : ''}
  ${postForm(req, '/admin/settings/test-email', html`<button class="btn btn-light btn-sm">שליחת מייל בדיקה אל ${req.user.email}</button>`)}
</section>`;
}

/** Settings page: is "Sign in with Google" set up, and what exactly to enter in Google Cloud Console. */
function googleStatusCard(req) {
  const g = google.status();
  const check = (ok, text) => html`<li class="note-line ${ok ? 'ok' : 'bad'}">${icon(ok ? 'check' : 'alert', 18)} <span>${text}</span></li>`;
  const here = `${req.protocol}://${req.get('host')}`;
  return html`<section class="card" id="google">
  <h2 class="section-title">${icon('login')} התחברות עם Google</h2>
  <p>${g.enabled ? badge('active', 'מופעלת') : badge('blocked', 'לא מופעלת')}
    ${g.enabled ? 'הכפתור מוצג בדפי ההתחברות וההרשמה.' : 'הכפתור מוסתר עד שההגדרה תושלם.'}</p>
  <ul class="plain">
    ${check(g.clientIdSet, html`<code>GOOGLE_CLIENT_ID</code> מוגדר ב־.env`)}
    ${g.clientIdSet && !g.clientIdLooksRight ? html`<li class="note-line bad">${icon('alert', 18)} ה־Client ID אמור להסתיים ב־<code>.apps.googleusercontent.com</code></li>` : ''}
    ${check(g.secretSet, html`<code>GOOGLE_CLIENT_SECRET</code> מוגדר ב־.env`)}
    ${check(here === g.origin, html`האתר פתוח בכתובת שב־<code>BASE_URL</code> (${g.origin})`)}
  </ul>
  ${here !== g.origin ? html`<p class="small note-line">${icon('alert', 16)} פתחת את האתר בכתובת <code>${here}</code>. Google יחזיר את המשתמשים רק לכתובת <code>${g.origin}</code>,
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

/** Admin → Users → "Add user": the account is active right away; the person chooses a password from an invitation. */
function newUserPage(req, { errors = [], v = {} } = {}) {
  const invite = v.send_invite ?? true;
  return html`
<div class="narrow-wide">
  <p><a class="back" href="/admin/users">${icon('arrow', 16)} חזרה לרשימה</a></p>
  ${pageHead('הוספת משתמש', { iconName: 'userplus', sub: 'בלי הרשמה עצמית: המשתמש יקבל במייל קישור לבחירת סיסמה.' })}
  ${errors.length ? html`<div class="flash flash-error"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
  ${postForm(req, '/admin/users/new', html`
    <fieldset>
      <legend>${icon('user')} פרטים אישיים</legend>
      <div class="grid2">
        ${field('שם פרטי', html`<input name="first_name" value="${v.first_name}" required>`)}
        ${field('שם משפחה', html`<input name="last_name" value="${v.last_name}" required>`)}
        ${field('מספר תעודת זהות', html`<input name="id_number" value="${v.id_number}" required inputmode="numeric" maxlength="9">`)}
        ${field('טלפון נייד', html`<input type="tel" name="phone" value="${v.phone}" required placeholder="05XXXXXXXX">`)}
      </div>
      ${field('דואר אלקטרוני', html`<input type="email" name="email" value="${v.email}" required>`, 'משמש גם כשם המשתמש להתחברות')}
    </fieldset>
    <fieldset>
      <legend>${icon('id')} רישיון נהיגה (אופציונלי)</legend>
      ${field('תאריך פקיעת תוקף הרישיון', html`<input type="date" name="license_expiry" value="${v.license_expiry}" min="${time.today()}">`,
        'מילוי התאריך מסמן שבדקת את הרישיון, והחשבון פעיל מיד. בלי תאריך המשתמש יתבקש להעלות רישיון, ואחרי אישורך יוכל להזמין.')}
      ${field('צילום רישיון נהיגה', licenseInput({ required: false }), `תמונה או PDF, עד ${uploadLimitLabel()}`)}
    </fieldset>
    <fieldset>
      <legend>${icon('shield')} תפקיד והזמנה</legend>
      ${field('תפקיד', html`<select name="role">
        <option value="user" ${v.role !== 'admin' ? 'selected' : ''}>משתמש רגיל</option>
        <option value="admin" ${v.role === 'admin' ? 'selected' : ''}>מנהל מערכת</option></select>`)}
      <label class="check"><input type="checkbox" name="send_invite" value="1" ${invite ? 'checked' : ''}> <span>שליחת מייל עם קישור לבחירת סיסמה (תקף ל־7 ימים)</span></label>
    </fieldset>
    <button class="btn btn-primary btn-block">${icon('userplus')} יצירת המשתמש</button>
    <p class="muted small">את נהלי השאלת הרכב המשתמש יאשר בעצמו לפני ההזמנה הראשונה.</p>
  `, 'enctype="multipart/form-data" class="card"')}
</div>`;
}

function userOptions(selected) {
  const users = db.prepare("SELECT * FROM users WHERE status = 'active' ORDER BY first_name, last_name").all();
  return users.map((u) => html`<option value="${u.id}" ${u.id === Number(selected) ? 'selected' : ''}>${fullName(u)} (${u.email})</option>`);
}

module.exports = ({ app, requireAdmin, licenseUpload }) => {
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
${pageHead('לוח בקרה', {
    iconName: 'dashboard', sub: 'מה מחכה לטיפול שלך היום.',
    actions: html`<a class="btn btn-primary" href="/admin/bookings/new">${icon('plus')} הזמנה ידנית</a> <a class="btn btn-light" href="/calendar">${icon('calendar')} יומן</a>`,
  })}
${storageInfo().perDeployment || storageInfo().kind === 'temporary' ? html`<div class="flash flash-error">
  <b>הנתונים לא נשמרים בין גרסאות:</b> הפריסה הזו משתמשת במסד נתונים ${storageInfo().kind === 'temporary' ? 'זמני' : 'שנוצר רק בשבילה'}.
  <a href="/admin/settings#system">פרטים ותיקון</a></div>` : ''}
${!config.smtp && (config.production || config.onVercel) ? html`<div class="flash flash-error">
  <b>מיילים לא נשלחים:</b> לא הוגדר שרת דואר (SMTP), ולכן מנהלים לא מקבלים הודעה על בקשות חדשות ומשתמשים לא מקבלים אישור הזמנה.
  <a href="/admin/settings#email">להגדרה</a></div>` : ''}
<div class="stats">
  <a class="stat ${pendingUsers.length ? 'hot' : ''}" href="/admin/users?status=pending">${icon('userplus')}<b>${pendingUsers.length}</b><span>משתמשים ממתינים</span></a>
  <a class="stat ${pendingBookings.length ? 'hot' : ''}" href="/admin/bookings?status=pending">${icon('clock')}<b>${pendingBookings.length}</b><span>בקשות ממתינות</span></a>
  <a class="stat" href="/admin/bookings?status=approved">${icon('calendar')}<b>${upcoming.length}</b><span>הזמנות ב־14 הימים הקרובים</span></a>
  <a class="stat ${licenses.length ? 'warn' : ''}" href="/admin/users?status=license_update">${icon('id')}<b>${licenses.length}</b><span>רישיונות שפגו / עומדים לפוג</span></a>
</div>

${vehicleAlerts.length ? html`<div class="card alert"><h2 class="section-title">${icon('alert')} התראות רכב</h2><ul>${vehicleAlerts.map((a) => html`<li>${a}</li>`)}</ul><a href="/admin/vehicle">לניהול הרכב</a></div>` : ''}

<div class="grid2">
  <section class="card">
    <h2 class="section-title">${icon('clock')} בקשות הזמנה ממתינות</h2>
    ${bookingsTable(pendingBookings)}
  </section>
  <section class="card">
    <h2 class="section-title">${icon('users')} משתמשים ורישיונות לבדיקה</h2>
    ${pendingUsers.length || pendingLicenses.length ? html`<ul class="plain">
      ${pendingUsers.map((u) => html`<li><a href="/admin/users/${u.id}">${fullName(u)}</a> – הרשמה חדשה (${time.fmt(u.created_at)})</li>`)}
      ${pendingLicenses.map((u) => html`<li><a href="/admin/users/${u.id}">${fullName(u)}</a> – רישיון חדש לבדיקה</li>`)}
    </ul>` : html`<p class="empty">${icon('check', 28)}<span>אין פריטים לבדיקה.</span></p>`}
    ${licenses.length ? html`<h3>תוקף רישיונות</h3><ul class="plain">${licenses.map((u) => html`<li>
      <a href="/admin/users/${u.id}">${fullName(u)}</a> – ${time.fmt(u.license_expiry)} ${u.license_expiry < today ? badge('blocked', 'פג') : badge('pending', 'בקרוב')}</li>`)}</ul>` : ''}
  </section>
</div>
<section class="card">
  <div class="page-head"><h2 class="section-title">${icon('calendar')} ההזמנות הקרובות</h2>
    <div class="page-actions"><a class="btn btn-light btn-sm" href="/admin/blocks/new">${icon('wrench', 16)} חסימת מועד</a> <a class="btn btn-light btn-sm" href="/calendar">ליומן</a></div></div>
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
${pageHead('משתמשים', {
    iconName: 'users', sub: 'אישור נרשמים, בדיקת רישיונות וניהול הרשאות.',
    actions: html`<a class="btn btn-primary" href="/admin/users/new">${icon('userplus')} הוספת משתמש</a>`,
  })}
<form class="filters" method="get">
  <input name="q" value="${q}" placeholder="חיפוש לפי שם, מייל, טלפון או ת״ז">
  <select name="status"><option value="">כל הסטטוסים</option>
    ${Object.entries(USER_STATUS).map(([k, l]) => html`<option value="${k}" ${k === status ? 'selected' : ''}>${l}</option>`)}</select>
  <select name="role"><option value="">כל התפקידים</option>
    <option value="admin" ${role === 'admin' ? 'selected' : ''}>מנהלים</option>
    <option value="user" ${role === 'user' ? 'selected' : ''}>משתמשים רגילים</option></select>
  <button class="btn btn-light">סינון</button>
</form>
<section class="card">
<table class="table">
<thead><tr><th>שם</th><th>דואר אלקטרוני</th><th>טלפון</th><th>תוקף רישיון</th><th>סטטוס</th><th></th></tr></thead>
<tbody>${users.map((u) => html`<tr>
  <td data-label="שם">${fullName(u)} ${u.role === 'admin' ? badge('admin', 'מנהל') : ''}</td>
  <td data-label="מייל">${u.email}</td>
  <td data-label="טלפון">${u.phone}</td>
  <td data-label="רישיון">${time.fmt(u.license_expiry)} ${u.pending_license_file ? badge('pending', 'חדש לבדיקה') : ''}</td>
  <td data-label="סטטוס">${userBadge(u.status)}</td>
  <td><a class="btn btn-light btn-sm" href="/admin/users/${u.id}">כרטיס משתמש</a></td>
</tr>`)}</tbody></table>
${users.length ? '' : html`<p class="empty">${icon('users', 28)}<span>לא נמצאו משתמשים.</span></p>`}
</section>
<p class="muted small">למינוי מנהל: פותחים את כרטיס המשתמש ← "הרשאות" ← "הפיכה למנהל".</p>`);
  });

  // Registered before /admin/users/:id so "new" is not taken as an id.
  app.get('/admin/users/new', requireAdmin, (req, res) => res.page('הוספת משתמש', newUserPage(req)));

  app.post('/admin/users/new', requireAdmin, licenseUpload, async (req, res) => {
    const b = req.body;
    const v = {
      first_name: String(b.first_name || '').trim(), last_name: String(b.last_name || '').trim(),
      id_number: String(b.id_number || '').trim(), phone: normalizePhone(b.phone),
      email: String(b.email || '').trim().toLowerCase(), license_expiry: String(b.license_expiry || ''),
      role: b.role === 'admin' ? 'admin' : 'user', send_invite: b.send_invite === '1',
    };
    const errors = [];
    if (!v.first_name || !v.last_name) errors.push('יש למלא שם פרטי ושם משפחה');
    if (!validIsraeliId(v.id_number)) errors.push('מספר תעודת הזהות אינו תקין');
    if (!validPhone(v.phone)) errors.push('מספר הטלפון הנייד אינו תקין');
    if (!validEmail(v.email)) errors.push('כתובת הדואר האלקטרוני אינה תקינה');
    if (v.license_expiry && (!time.isValidDate(v.license_expiry) || v.license_expiry < time.today())) errors.push('תאריך תוקף הרישיון חייב להיות עתידי');
    if (req.file && !v.license_expiry) errors.push('עם צילום רישיון יש למלא גם את תאריך התוקף שלו');
    if (db.prepare('SELECT 1 FROM users WHERE email = ? OR id_number = ?').get(v.email, v.id_number)) {
      errors.push('קיים כבר משתמש עם כתובת דואר אלקטרוני או תעודת זהות זו');
    }
    if (errors.length) {
      storage.discard(req.file);
      return res.status(400).page('הוספת משתמש', newUserPage(req, { errors, v }));
    }
    if (req.file) storage.keep(req.file);
    const now = time.stamp();
    // With a license date the admin vouches for the license; without one the person uploads it first (the usual
    // "license update" flow: upload → the admin approves → active). Admins can manage the system without a license.
    const status = v.license_expiry || v.role === 'admin' ? 'active' : 'license_update';
    const id = Number(db.prepare(`INSERT INTO users (first_name, last_name, id_number, phone, email, role, status, license_file,
        license_expiry, license_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(v.first_name, v.last_name, v.id_number, v.phone, v.email, v.role, status, req.file?.filename ?? null,
        v.license_expiry || null, v.license_expiry ? 1 : 0, now, now).lastInsertRowid);
    audit(req.user.id, 'user.create', 'user', id, `${v.role}${v.license_expiry ? `, רישיון עד ${v.license_expiry}` : ''}`);
    const u = getUser(id);

    let notice = ['success', `המשתמש ${fullName(u)} נוצר.`];
    if (v.send_invite) {
      const token = auth.createPasswordReset(id, auth.INVITE_TTL_MS);
      const sent = await mail.invitation(u, token, fullName(req.user)) && Boolean(config.smtp);
      notice = sent
        ? ['success', `המשתמש ${fullName(u)} נוצר, ונשלח אליו מייל לבחירת סיסמה.`]
        : ['warning', `המשתמש ${fullName(u)} נוצר, אבל ${config.smtp ? 'שליחת המייל נכשלה' : 'לא הוגדר שרת דואר ולכן לא נשלח מייל'}. `
          + `אפשר להעביר לו את הקישור לבחירת סיסמה (תקף ל־7 ימים): ${config.baseUrl}/password/reset?token=${encodeURIComponent(token)}`];
    }
    if (status === 'license_update') notice[1] += ' הוא יתבקש להעלות רישיון נהיגה, ואחרי אישורך יוכל להזמין.';
    res.flash(...notice);
    res.redirect(`/admin/users/${id}`);
  });

  app.get('/admin/users/:id', requireAdmin, (req, res) => {
    const u = getUser(req.params.id);
    if (!u) return res.redirect('/'); // an old or mistyped link: back to the main page
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
<p><a class="back" href="/admin/users">${icon('arrow', 16)} חזרה לרשימה</a></p>
${pageHead(html`${fullName(u)} ${u.role === 'admin' ? badge('admin', 'מנהל') : ''}`, { iconName: 'user', sub: u.email, actions: userBadge(u.status) })}
<div class="grid2">
  <section class="card">
    <h2 class="section-title">${icon('user')} פרטים</h2>
    <dl class="dl">
      <dt>ת"ז</dt><dd>${u.id_number}</dd>
      <dt>טלפון</dt><dd><a href="tel:${u.phone}">${u.phone}</a></dd>
      <dt>דואר אלקטרוני</dt><dd><a href="mailto:${u.email}">${u.email}</a></dd>
      <dt>נרשם</dt><dd>${time.fmt(u.created_at)}</dd>
      <dt>מדיניות פרטיות</dt><dd>${u.privacy_accepted_at ? 'אושרה ' + time.fmt(u.privacy_accepted_at) : '—'}</dd>
      <dt>אישורי נהלים</dt><dd>${acceptances.map((a) => html`גרסה ${a.policy_version} – ${time.fmt(a.accepted_at)}<br>`)}</dd>
    </dl>
    ${postForm(req, `/admin/users/${u.id}/note`, html`
      ${field('הערת מנהל (פנימית)', html`<textarea name="admin_note" rows="2">${u.admin_note}</textarea>`)}
      <button class="btn btn-light btn-sm">שמירת הערה</button>`)}
    ${actionButton(req, `/admin/users/${u.id}/send-reset`, 'שליחת קישור לאיפוס סיסמה', { cls: 'btn-light btn-sm', confirm: `לשלוח אל ${u.email} קישור לאיפוס הסיסמה?` })}
  </section>

  <section class="card">
    <h2 class="section-title" id="license">${icon('id')} רישיון נהיגה</h2>
    ${isSelf ? html`<p class="small">${u.pending_license_file
      ? 'זה הרישיון שלך: כמנהל ניתן לאשר אותו כאן. האישור נרשם ביומן הפעולות.'
      : html`זה החשבון שלך. כדי להזמין את הרכב גם אתה צריך רישיון מאושר: <a href="/me/license">העלאת רישיון</a>, ואז אישור כאן.`}</p>` : ''}
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
  <h2 class="section-title">${icon('settings')} פעולות</h2>
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
  <h2 class="section-title">${icon('list')} היסטוריית הזמנות</h2>
  ${bookingsTable(list, { showUser: false })}
</section>
<section class="card">
  <h2 class="section-title">${icon('clock')} יומן פעולות</h2>
  ${log.length ? html`<ul class="plain small">${log.map((a) => html`<li>${time.fmt(a.at)} – ${a.action} ${a.details ? '(' + a.details + ')' : ''} ${a.first_name ? '· ' + fullName(a) : ''}</li>`)}</ul>` : html`<p class="muted">אין פעולות.</p>`}
</section>`);
  });

  // License images are never public: served only here, to admins, with no caching.
  app.get('/admin/users/:id/license', requireAdmin, (req, res) => {
    const u = getUser(req.params.id);
    const file = u && (req.query.pending ? u.pending_license_file : u.license_file);
    const data = storage.read(file);
    if (!data) return res.sendStatus(404);
    audit(req.user.id, 'license.view', 'user', u.id);
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Disposition', 'inline');
    res.type(path.extname(file)).send(data);
  });

  const SELF_ALLOWED = new Set(['note', 'license/approve', 'license/reject', 'send-reset']);
  const userAction = (name, handler) => app.post(`/admin/users/:id/${name}`, requireAdmin, async (req, res) => {
    const u = getUser(req.params.id);
    if (!u) return res.sendStatus(404);
    // On your own account you may verify your own driving license, keep notes and get a reset link,
    // but never change your own status or role.
    if (u.id === req.user.id && !SELF_ALLOWED.has(name)) {
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
    db.prepare("UPDATE users SET status = 'active', license_verified = 1, license_expiry = ?, updated_at = ? WHERE id = ?").run(expiry, time.stamp(), u.id);
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
    storage.remove(u.license_file);
    const status = u.status === 'license_update' ? 'active' : u.status;
    db.prepare(`UPDATE users SET license_file = pending_license_file, license_expiry = ?, license_verified = 1,
      pending_license_file = NULL, pending_license_expiry = NULL, status = ? WHERE id = ?`).run(expiry, status, u.id);
    audit(req.user.id, 'user.license_approve', 'user', u.id, u.id === req.user.id ? `${expiry} (self)` : expiry);
    if (status === 'active' && u.status !== 'active') await mail.userApproved(u);
    return status === 'pending' ? 'הרישיון אושר. יש לאשר גם את המשתמש' : 'הרישיון החדש אושר';
  });

  userAction('license/reject', async (u, req, note) => {
    storage.remove(u.pending_license_file);
    db.prepare('UPDATE users SET pending_license_file = NULL, pending_license_expiry = NULL WHERE id = ?').run(u.id);
    audit(req.user.id, 'user.license_reject', 'user', u.id, note);
    await mail.licenseRequested(u, note || 'הרישיון שהועלה לא אושר');
    return 'הרישיון נדחה והמשתמש התבקש להעלות רישיון אחר';
  });

  userAction('make-admin', async (u, req) => {
    if (u.role === 'admin') return { type: 'warning', text: 'המשתמש כבר מנהל' };
    if (u.status !== 'active') return { type: 'error', text: 'ניתן למנות למנהל רק משתמש פעיל. יש לאשר את המשתמש קודם' };
    db.prepare("UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?").run(time.stamp(), u.id);
    audit(req.user.id, 'user.make_admin', 'user', u.id);
    await mail.roleChanged(u, true);
    return `${fullName(u)} מונה למנהל ונשלחה אליו הודעה`;
  });

  userAction('remove-admin', async (u, req) => {
    if (u.role !== 'admin') return { type: 'warning', text: 'המשתמש אינו מנהל' };
    db.prepare("UPDATE users SET role = 'user', updated_at = ? WHERE id = ?").run(time.stamp(), u.id);
    audit(req.user.id, 'user.remove_admin', 'user', u.id);
    await mail.roleChanged(u, false);
    return `הרשאת המנהל של ${fullName(u)} הוסרה`;
  });

  userAction('send-reset', async (u, req) => {
    const token = auth.createPasswordReset(u.id);
    const sent = await mail.passwordReset(u, token) && Boolean(config.smtp); // without SMTP it only reaches data/outbox
    audit(req.user.id, 'user.password_reset_sent', 'user', u.id, sent ? 'email' : 'shown to admin');
    if (sent) return `נשלח אל ${u.email} קישור לאיפוס סיסמה (תקף לשעה)`;
    // No e-mail reached the user: give the admin the link to pass on (WhatsApp, SMS…). Single use, valid one hour.
    const link = `${config.baseUrl}/password/reset?token=${encodeURIComponent(token)}`;
    return { type: 'warning', text: `${config.smtp ? 'שליחת המייל נכשלה' : 'לא הוגדר שרת דואר, ולכן לא נשלח מייל'}. `
      + `אפשר להעביר למשתמש את קישור האיפוס הזה (חד־פעמי, תקף לשעה): ${link}` };
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
${pageHead('הזמנות', {
    iconName: 'list', sub: 'בקשות ממתינות מופיעות ראשונות.',
    actions: html`<a class="btn btn-primary" href="/admin/bookings/new">${icon('plus')} הזמנה ידנית</a> <a class="btn btn-light" href="/admin/blocks/new">${icon('wrench')} חסימת מועד</a>`,
  })}
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
<section class="card">${bookingsTable(list)}</section>`);
  });

  app.get('/admin/bookings/new', requireAdmin, (req, res) => {
    const start = time.isValidLocal(req.query.start) ? req.query.start : '';
    const end = start ? time.addMinutes(start, 120) : '';
    res.page('הזמנה ידנית', html`
<div class="narrow">
  ${pageHead('הזמנה ידנית', { iconName: 'plus', sub: 'הזמנה שהמנהל יוצר עבור משתמש מאושרת מיד.' })}
  <p class="muted small">לחסימת זמן לתחזוקה <a href="/admin/blocks/new?start=${start}">השתמשו בחסימת מועד</a>.</p>
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
    const notifyUser = req.body.notify === '1';
    const [type, text] = approvalNotice(b, await mail.bookingApproved(b, { approvedBy: fullName(req.user), notifyUser }), { notifyUser });
    res.flash(type, text.replace('ההזמנה אושרה', 'ההזמנה נוצרה ואושרה'));
    res.redirect(`/admin/bookings/${b.id}`);
  }));

  app.get('/admin/blocks/new', requireAdmin, (req, res) => {
    const start = time.isValidLocal(req.query.start) ? req.query.start : '';
    res.page('חסימת מועד', html`
<div class="narrow">
  ${pageHead('חסימת מועד ביומן', { iconName: 'wrench', sub: 'סימון שהרכב אינו זמין (טיפול, תקלה, שימוש פנימי) ללא יצירת הזמנה בשם משתמש.' })}
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
    if (!b) return res.redirect('/'); // an old or mistyped link: back to the main page
    const history = db.prepare(`SELECT h.*, u.first_name, u.last_name FROM booking_history h LEFT JOIN users u ON u.id = h.actor_id
      WHERE booking_id = ? ORDER BY h.id`).all(b.id);
    const conflicts = b.status === 'pending' ? bookings.findConflicts(b.vehicle_id, b.start_at, b.end_at, { excludeId: b.id }) : [];
    const competing = ['pending', 'approved'].includes(b.status) ? bookings.findPendingOverlaps(b.vehicle_id, b.start_at, b.end_at, b.id) : [];
    const user = b.user_id ? getUser(b.user_id) : null;
    const problems = user && b.status === 'pending' ? bookings.eligibilityProblems(user, b.end_at) : [];
    res.page(`הזמנה #${b.id}`, html`
<p><a class="back" href="/admin/bookings">${icon('arrow', 16)} חזרה להזמנות</a></p>
${pageHead(`${b.kind === 'block' ? 'חסימת יומן' : 'הזמנה'} #${b.id}`, { iconName: b.kind === 'block' ? 'wrench' : 'calendar', sub: `${time.fmt(b.start_at)} – ${time.fmt(b.end_at)}`, actions: bookingBadge(b.status) })}
<div class="grid2">
  <section class="card">
    <h2 class="section-title">${icon('file')} פרטים</h2>
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
    <h2 class="section-title">${icon('check')} בדיקת זמינות ופעולות</h2>
    ${b.status === 'pending' ? (conflicts.length
      ? html`<div class="flash flash-error">המועד מתנגש עם:<ul>${conflicts.map((c) => html`<li><a href="/admin/bookings/${c.id}">
          ${c.kind === 'block' ? 'חסימה: ' + c.block_reason : fullName(c)}</a> ${time.fmt(c.start_at)}–${time.fmt(c.end_at)}</li>`)}</ul></div>`
      : html`<div class="flash flash-success">הרכב פנוי במועד זה</div>`) : ''}
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
  <h2 class="section-title">${icon('clock')} היסטוריית שינויים</h2>
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
    const [type, text] = approvalNotice(b, await mail.bookingApproved(b, { approvedBy: fullName(req.user) }));
    const competing = bookings.findPendingOverlaps(b.vehicle_id, b.start_at, b.end_at, b.id);
    res.flash(competing.length ? 'warning' : type, competing.length
      ? `${text} יש ${competing.length} בקשות ממתינות נוספות לאותו מועד שכבר לא ניתן לאשר – מומלץ לדחות אותן.`
      : text);
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
  ${pageHead('ניהול הרכב', { iconName: 'car', sub: html`${[v.make, v.model].filter(Boolean).join(' ')} · ${v.plate} · ${VEHICLE_STATUS[v.status]}` })}
  ${postForm(req, '/admin/vehicle', html`
    <h2 class="section-title">${icon('car')} פרטי הרכב ומועדים</h2>
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
  <nav class="quick" aria-label="תחזוקה">
    <a href="/admin/blocks/new">${icon('wrench')}חסימת מועד<small>לטיפול או תחזוקה</small></a>
    <a href="/admin/bookings?kind=block">${icon('list')}חסימות קיימות<small>צפייה וביטול</small></a>
  </nav>
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
${pageHead('נהלי השאלת הרכב', { iconName: 'shield', sub: `גרסה נוכחית: ${p.version}. כל שמירה יוצרת גרסה חדשה.` })}
<div class="grid2">
  ${postForm(req, '/admin/policies', html`
    <h2 class="section-title">${icon('file')} עריכה – תיצור גרסה ${p.version + 1}</h2>
    ${field('תוכן הנהלים', html`<textarea name="content" rows="20" class="mono" required>${p.content}</textarea>`, 'כותרות: # / ## , רשימות: - , הדגשה: **טקסט**')}
    <label class="check"><input type="checkbox" name="requires_reaccept" value="1"> <span>שינוי מהותי – לדרוש מכל המשתמשים אישור מחדש לפני ההזמנה הבאה</span></label>
    <button class="btn btn-primary">פרסום גרסה חדשה</button>`, 'class="card"')}
  <section class="card">
    <h2 class="section-title">${icon('list')} גרסאות</h2>
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
    db.prepare('INSERT INTO policies (version, content, requires_reaccept, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(version, content, req.body.requires_reaccept === '1' ? 1 : 0, req.user.id, time.stamp());
    audit(req.user.id, 'policy.publish', 'policy', version, req.body.requires_reaccept === '1' ? 'requires reaccept' : '');
    res.flash('success', `גרסה ${version} פורסמה`);
    res.redirect('/admin/policies');
  });

  // ---------- Settings & audit ----------
  app.get('/admin/settings', requireAdmin, (req, res) => {
    const s = getSettings();
    res.page('הגדרות', html`
<div class="narrow">
  ${pageHead('הגדרות מערכת', { iconName: 'settings', sub: 'כללי הזמנה, תזכורות, מיילים והתחברות.' })}
  ${postForm(req, '/admin/settings', html`
    <h2 class="section-title">${icon('calendar')} כללי הזמנה ותזכורות</h2>
    ${Object.entries(SETTING_LABELS).map(([k, [label, hint]]) => field(label, html`<input type="number" name="${k}" value="${s[k]}" min="0" step="1" required>`, hint))}
    <button class="btn btn-primary btn-block">שמירה</button>`, 'class="card"')}
  ${systemCard()}
  ${emailStatusCard(req)}
  ${googleStatusCard(req)}
  <p><a class="back" href="/admin/audit">${icon('clock', 16)} יומן פעולות מנהלים</a></p>
</div>`);
  });

  app.post('/admin/settings/test-email', requireAdmin, async (req, res) => {
    const ok = await mail.test(req.user.email);
    if (!ok) res.flash('error', 'שליחת מייל הבדיקה נכשלה. פרטי השגיאה מופיעים למטה.');
    else if (config.smtp) res.flash('success', `מייל בדיקה נשלח אל ${req.user.email}. אם לא הגיע תוך דקה, בדקו בספאם.`);
    else if (config.onVercel || config.production) res.flash('warning', 'המייל לא נשלח: באתר הזה לא הוגדר שרת דואר (SMTP). ההוראות מופיעות למטה.');
    else res.flash('warning', 'מייל הבדיקה לא נשלח אלא נשמר בתיקייה data/outbox, כי לא הוגדר שרת דואר (SMTP).');
    res.redirect('/admin/settings#email');
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
${pageHead('יומן פעולות', { iconName: 'clock', sub: '300 הפעולות האחרונות במערכת.' })}
<section class="card">
<table class="table"><thead><tr><th>מועד</th><th>מבצע</th><th>פעולה</th><th>יעד</th><th>פרטים</th></tr></thead><tbody>
${rows.map((r) => html`<tr><td data-label="מועד">${time.fmt(r.at)}</td><td data-label="מבצע">${r.actor_id ? fullName(r) : 'מערכת'}</td>
  <td data-label="פעולה"><code>${r.action}</code></td>
  <td data-label="יעד">${link(r) ? html`<a href="${link(r)}">${r.target_type} #${r.target_id}</a>` : ''}</td>
  <td data-label="פרטים">${r.details}</td></tr>`)}
</tbody></table>
</section>`);
  });
};
