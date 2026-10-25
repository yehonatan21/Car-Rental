'use strict';
const crypto = require('node:crypto');
const { db, audit, currentPolicy } = require('../db');
const auth = require('../auth');
const mail = require('../mail');
const time = require('../time');
const config = require('../config');
const { html, raw, markdown, postForm, field } = require('../views/html');
const google = require('../google');
const storage = require('../storage');

const GOOGLE_STATE_COOKIE = 'gstate';
const GOOGLE_SIGNUP_COOKIE = 'gsignup';

/** Israeli ID check digit (Luhn variant). */
function validIsraeliId(id) {
  if (!/^\d{5,9}$/.test(id)) return false;
  const digits = id.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(digits[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

const normalizePhone = (p) => String(p || '').replace(/[\s-]/g, '');
const validPhone = (p) => /^(05\d{8}|\+9725\d{8})$/.test(p);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/** Only allow redirects to local paths ("//host" and "/\\host" are treated by browsers as other origins). */
const safeNext = (n) => (typeof n === 'string' && /^\/(?![/\\])/.test(n) && !/[\r\n]/.test(n) ? n : null);

function homeFor(user) {
  if (user.role === 'admin') return '/admin';
  return user.status === 'active' ? '/calendar' : '/me';
}

function loginPage(req, { error, email = '' } = {}) {
  return html`
<div class="narrow">
  <h1>התחברות</h1>
  ${error ? html`<div class="flash flash-error">${error}</div>` : ''}
  ${googleOption(req, '/auth/google' + (safeNext(req.query.next) ? '?next=' + encodeURIComponent(req.query.next) : ''), 'התחברות עם Google', '/login')}
  ${google.enabled() ? html`<p class="divider"><span>או</span></p>` : ''}
  ${postForm(req, '/login', html`
    <input type="hidden" name="next" value="${req.query.next || req.body?.next || ''}">
    ${field('דואר אלקטרוני', html`<input type="email" name="email" value="${email}" required autocomplete="username">`)}
    ${field('סיסמה', html`<input type="password" name="password" required autocomplete="current-password">`)}
    <button class="btn btn-primary btn-block">כניסה</button>
    <p class="small"><a href="/password/forgot${email ? '?email=' + encodeURIComponent(email) : ''}">שכחתי סיסמה</a></p>
  `, 'class="card"')}
  <div class="card">
    <h2>כניסה עם קוד חד־פעמי</h2>
    <p class="muted">נשלח קוד בן 6 ספרות לכתובת הדואר האלקטרוני שלך.</p>
    ${postForm(req, '/login/code', html`
      ${field('דואר אלקטרוני', html`<input type="email" name="email" value="${email}" required>`)}
      <button class="btn btn-light btn-block">שליחת קוד</button>`)}
  </div>
  <p>עדיין אין לך חשבון? <a href="/register">להרשמה</a></p>
</div>`;
}

/** After the first factor: start a session, possibly waiting for the admin's TOTP code. */
function finishLogin(req, res, user, next = req.body?.next) {
  auth.resetThrottle('login:' + req.ip);
  const needs2fa = Boolean(user.totp_enabled);
  auth.createSession(res, user.id, needs2fa);
  if (needs2fa) return res.redirect('/login/2fa' + (safeNext(next) ? '?next=' + encodeURIComponent(next) : ''));
  res.redirect(safeNext(next) || homeFor(user));
}

const googleButton = (href, label) => html`
  <a class="btn btn-google btn-block" href="${href}">
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.1 1.4-4.9 2.3-8.2 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>
    ${label}</a>`;

/**
 * The Google button, when it can work from here. Google only returns users to the registered BASE_URL address,
 * so on any other address (another host name, a Wi-Fi IP) point to the right one instead of failing later.
 */
function googleOption(req, href, label, page, hint) {
  if (!google.enabled()) return '';
  if (!google.onPublicHost(req)) {
    const url = new URL(config.baseUrl).origin + page;
    return html`<div class="card"><p class="muted small">ההתחברות עם Google זמינה בכתובת <a href="${url}">${url}</a>.
      בכתובת הנוכחית אפשר להתחבר עם סיסמה או קוד חד־פעמי.</p></div>`;
  }
  return html`<div class="card">${googleButton(href, label)}${hint ? html`<p class="muted small">${hint}</p>` : ''}</div>`;
}

function registerPage(req, { errors = [], v = {}, draft = null } = {}) {
  const policy = currentPolicy();
  const gs = google.pendingSignup(req.cookies[GOOGLE_SIGNUP_COOKIE]);
  if (gs) v = { first_name: gs.first_name, last_name: gs.last_name, ...v, email: gs.email };
  return html`
<h1>הרשמה למערכת</h1>
<p class="muted">לאחר ההרשמה המנהל יבדוק את הפרטים ואת רישיון הנהיגה. לא ניתן להזמין את הרכב עד לאישור.</p>
${errors.length ? html`<div class="flash flash-error"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
${gs ? html`<div class="flash flash-success">מתחברים עם חשבון Google <b>${gs.email}</b>. נשאר להשלים את הפרטים ולהעלות רישיון נהיגה.</div>`
    : googleOption(req, '/auth/google', 'הרשמה מהירה עם Google', '/register',
      'השם והדואר האלקטרוני יילקחו מחשבון Google. עדיין יש להשלים ת"ז, טלפון ורישיון נהיגה.')}
${postForm(req, '/register', html`
  ${draft ? html`<input type="hidden" name="draft" value="${draft.token}">` : ''}
  <fieldset>
    <legend>פרטים אישיים</legend>
    <div class="grid2">
      ${field('שם פרטי', html`<input name="first_name" value="${v.first_name}" required autocomplete="given-name">`)}
      ${field('שם משפחה', html`<input name="last_name" value="${v.last_name}" required autocomplete="family-name">`)}
      ${field('מספר תעודת זהות', html`<input name="id_number" value="${v.id_number}" required inputmode="numeric" maxlength="9">`)}
      ${field('טלפון נייד', html`<input type="tel" name="phone" value="${v.phone}" required placeholder="05XXXXXXXX" autocomplete="tel">`)}
    </div>
    ${gs
      ? field('דואר אלקטרוני', html`<input type="email" value="${gs.email}" readonly>`, 'מחשבון Google')
      : field('דואר אלקטרוני', html`<input type="email" name="email" value="${v.email}" required autocomplete="email">`)}
    ${draft?.hasPassword
      ? field('סיסמה', html`<input type="password" name="password" minlength="8" autocomplete="new-password" placeholder="••••••••">`,
        html`<span class="saved">✓ הסיסמה שהזנת נשמרה. אפשר להשאיר ריק, או להקליד סיסמה אחרת.</span>`)
      : field(gs ? 'סיסמה (אופציונלי)' : 'סיסמה', html`<input type="password" name="password" minlength="8" autocomplete="new-password">`,
        gs ? 'לא חובה: אפשר להתחבר תמיד עם Google.' : 'לפחות 8 תווים. ניתן להשאיר ריק ולהתחבר תמיד באמצעות קוד חד־פעמי שיישלח לדואר האלקטרוני.')}
  </fieldset>
  <fieldset>
    <legend>רישיון נהיגה</legend>
    ${draft?.licenseName
      ? field('צילום רישיון נהיגה (להחלפה בלבד)', html`<input type="file" name="license" accept="image/*,application/pdf">`,
        html`<span class="saved">✓ הקובץ <b dir="auto">${draft.licenseName}</b> נשמר. אין צורך להעלות אותו שוב.</span>`)
      : field('צילום רישיון נהיגה בתוקף', html`<input type="file" name="license" accept="image/*,application/pdf" required>`,
        'תמונה או PDF, עד 8MB. הקובץ נשמר באזור מוגן ונגיש למנהלים בלבד.')}
    ${field('תאריך פקיעת תוקף הרישיון', html`<input type="date" name="license_expiry" value="${v.license_expiry}" required min="${time.today()}">`)}
  </fieldset>
  <fieldset>
    <legend>אישורים</legend>
    <details class="policy-box"><summary>נהלי השאלת הרכב (גרסה ${policy.version}) – לחצו לקריאה</summary>
      <div class="prose">${markdown(policy.content)}</div></details>
    <label class="check"><input type="checkbox" name="accept_policy" value="1" required ${v.accept_policy ? raw('checked') : ''}> <span>קראתי ואני מסכים/ה לנהלי השאלת הרכב (גרסה ${policy.version})</span></label>
    <label class="check"><input type="checkbox" name="accept_privacy" value="1" required ${v.accept_privacy ? raw('checked') : ''}> <span>קראתי ואני מסכים/ה ל<a href="/privacy" target="_blank">מדיניות הפרטיות</a></span></label>
    <input type="hidden" name="policy_version" value="${policy.version}">
  </fieldset>
  <button class="btn btn-primary btn-block">שליחת הרשמה</button>
`, 'enctype="multipart/form-data" class="card"')}`;
}

// ---------- Registration drafts: keep the upload and password after a failed attempt ----------
const DRAFT_TTL_MS = 2 * 3600000;

/** Multer reports file names as latin1; decode them back to UTF-8 (e.g. Hebrew names). */
function uploadName(file) {
  const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
  return (decoded.includes('\uFFFD') ? file.originalname : decoded).slice(0, 120);
}

function loadDraft(token) {
  if (typeof token !== 'string' || !token) return null;
  const row = db.prepare('SELECT * FROM registration_drafts WHERE token_hash = ? AND expires_at > ?').get(auth.sha256(token), Date.now());
  return row ? { ...row, token } : null;
}

/** Creates or updates the draft; returns its token (only the hash is stored). */
function saveDraft(token, { licenseFile, licenseName, passwordHash }) {
  const t = token || crypto.randomBytes(24).toString('base64url');
  db.prepare(`INSERT INTO registration_drafts (token_hash, license_file, license_name, password_hash, expires_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(token_hash) DO UPDATE SET license_file = excluded.license_file, license_name = excluded.license_name,
      password_hash = excluded.password_hash, expires_at = excluded.expires_at`)
    .run(auth.sha256(t), licenseFile, licenseName, passwordHash, Date.now() + DRAFT_TTL_MS);
  return t;
}

/** Forgets the draft once the account exists (its license file now belongs to the user). */
const dropDraft = (token) => db.prepare('DELETE FROM registration_drafts WHERE token_hash = ?').run(auth.sha256(token));

function forgotPage(req, { email = '', error } = {}) {
  return html`
<div class="narrow">
  <h1>שכחתי סיסמה</h1>
  ${error ? html`<div class="flash flash-error">${error}</div>` : ''}
  ${postForm(req, '/password/forgot', html`
    <p>נשלח לכתובת הדואר האלקטרוני שלך קישור לבחירת סיסמה חדשה.</p>
    ${field('דואר אלקטרוני', html`<input type="email" name="email" value="${email}" required autocomplete="email" autofocus>`)}
    <button class="btn btn-primary btn-block">שליחת קישור לאיפוס</button>`, 'class="card"')}
  <p class="muted small">אפשר גם להתחבר בלי סיסמה עם <a href="/login">קוד חד־פעמי במייל</a>.</p>
</div>`;
}

function resetPage(req, { token, error } = {}) {
  return html`
<div class="narrow">
  <h1>בחירת סיסמה חדשה</h1>
  ${error ? html`<div class="flash flash-error">${error}</div>` : ''}
  ${postForm(req, '/password/reset', html`
    <input type="hidden" name="token" value="${token}">
    ${field('סיסמה חדשה', html`<input type="password" name="password" minlength="8" required autocomplete="new-password" autofocus>`, 'לפחות 8 תווים')}
    ${field('אימות הסיסמה', html`<input type="password" name="confirm" minlength="8" required autocomplete="new-password">`)}
    <button class="btn btn-primary btn-block">שמירת הסיסמה</button>
    <p class="muted small">לאחר השמירה תנותק מכל המכשירים ותצטרך להתחבר מחדש.</p>`, 'class="card"')}
</div>`;
}

const invalidResetPage = () => html`
<div class="narrow card">
  <h1>הקישור אינו תקף</h1>
  <p>קישור האיפוס פג תוקף (שעה), כבר נוצל, או שהוחלף בקישור חדש יותר.</p>
  <p><a class="btn btn-primary" href="/password/forgot">בקשת קישור חדש</a></p>
</div>`;

module.exports = ({ app, licenseUpload }) => {
  app.get('/', (req, res) => {
    if (req.user) return res.redirect(homeFor(req.user));
    res.page('ברוכים הבאים', html`
<section class="hero">
  <h1>הזמנת הרכב המשותף</h1>
  <p>בודקים מתי הרכב פנוי, שולחים בקשה ומקבלים אישור מהמנהל – הכל במקום אחד.</p>
  <div class="actions"><a class="btn btn-primary" href="/login">התחברות</a> <a class="btn btn-light" href="/register">הרשמה</a></div>
</section>
<section class="steps">
  <div class="card"><b>1. הרשמה</b><p>ממלאים פרטים, מעלים רישיון נהיגה ומאשרים את הנהלים.</p></div>
  <div class="card"><b>2. אישור מנהל</b><p>המנהל בודק את הפרטים ומאשר את החשבון.</p></div>
  <div class="card"><b>3. הזמנה</b><p>בוחרים מועד פנוי ביומן ושולחים בקשה.</p></div>
  <div class="card"><b>4. אישור סופי</b><p>לאחר אישור המנהל נשלח מייל עם כל הפרטים.</p></div>
</section>`);
  });

  app.get('/login', (req, res) => {
    if (req.user) return res.redirect(homeFor(req.user));
    res.page('התחברות', loginPage(req));
  });

  app.post('/login', (req, res) => {
    const email = String(req.body.email || '').trim();
    if (auth.throttled('login:' + req.ip)) {
      return res.status(429).page('התחברות', loginPage(req, { error: 'יותר מדי ניסיונות. נסו שוב בעוד מספר דקות.', email }));
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !auth.verifyPassword(String(req.body.password || ''), user.password_hash)) {
      return res.status(401).page('התחברות', loginPage(req, { error: 'דואר אלקטרוני או סיסמה שגויים', email }));
    }
    finishLogin(req, res, user);
  });

  app.post('/login/code', async (req, res) => {
    const email = String(req.body.email || '').trim();
    if (auth.throttled('code:' + req.ip, 5)) {
      return res.status(429).page('התחברות', loginPage(req, { error: 'יותר מדי בקשות. נסו שוב בעוד מספר דקות.', email }));
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).page('התחברות', loginPage(req, { error: 'כתובת הדואר האלקטרוני אינה תקינה', email }));
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Same response whether or not the address exists, to avoid revealing registered e-mails.
    const sent = user ? await mail.loginCode(user, auth.createLoginCode(user.id)) : true;
    if (!sent) {
      return res.status(503).page('התחברות', loginPage(req, {
        error: 'שליחת המייל נכשלה, ולכן הקוד לא נשלח. נסו שוב בעוד כמה דקות, או התחברו עם סיסמה. אם הבעיה נמשכת, פנו למנהל המערכת.', email,
      }));
    }
    res.page('קוד התחברות', html`
<div class="narrow">
  <h1>הזנת קוד</h1>
  <p>אם הכתובת <b dir="ltr">${email}</b> רשומה במערכת, נשלח אליה קוד בן 6 ספרות. הקוד תקף ל־10 דקות.</p>
  ${!config.smtp && !config.production ? html`<div class="flash flash-warning small">
    מצב פיתוח: לא הוגדר שרת דואר (SMTP), ולכן המייל לא נשלח בפועל. <b>הקוד מודפס בחלון השרת</b> (החלון שבו רץ start.cmd / npm run dev).</div>` : ''}
  ${postForm(req, '/login/code/verify', html`
    <input type="hidden" name="email" value="${email}">
    ${field('קוד', html`<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" pattern="[0-9 \-]*" required autofocus>`)}
    <button class="btn btn-primary btn-block">כניסה</button>`, 'class="card"')}
  <p class="muted small">לא הגיע? בדקו בתיקיית הספאם / קידומי מכירות. אפשר לבקש קוד חדש; גם הקוד הקודם ימשיך לעבוד עד שיפוג.</p>
  ${postForm(req, '/login/code', html`<input type="hidden" name="email" value="${email}"><button class="btn btn-light btn-sm">שליחת קוד חדש</button>`)}
</div>`);
  });

  app.post('/login/code/verify', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(req.body.email || '').trim());
    if (auth.throttled('login:' + req.ip) || !user || !auth.consumeLoginCode(user.id, req.body.code)) {
      return res.status(401).page('התחברות', loginPage(req, { error: 'הקוד שגוי או שפג תוקפו', email: req.body.email }));
    }
    finishLogin(req, res, user);
  });

  app.get('/login/2fa', (req, res) => {
    if (!req.pendingUser) return res.redirect('/login');
    res.page('אימות דו־שלבי', html`
<div class="narrow">
  <h1>אימות דו־שלבי</h1>
  <p>יש להזין את הקוד מאפליקציית האימות.</p>
  ${postForm(req, '/login/2fa', html`
    <input type="hidden" name="next" value="${req.query.next || ''}">
    ${field('קוד', html`<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus>`)}
    <button class="btn btn-primary btn-block">אימות</button>`, 'class="card"')}
</div>`);
  });

  app.post('/login/2fa', (req, res) => {
    const user = req.pendingUser;
    if (!user) return res.redirect('/login');
    if (auth.throttled('2fa:' + user.id, 8) || !auth.verifyTotp(user.totp_secret, req.body.code)) {
      res.flash('error', 'קוד שגוי');
      return res.redirect('/login/2fa');
    }
    auth.completeTwoFactor(req);
    auth.resetThrottle('2fa:' + user.id);
    res.redirect(safeNext(req.body.next) || homeFor(user));
  });

  app.post('/logout', (req, res) => {
    auth.destroySession(req, res);
    res.redirect('/');
  });

  app.get('/register', (req, res) => {
    if (req.user) return res.redirect('/me');
    res.page('הרשמה', registerPage(req));
  });

  // ---------- Sign in with Google ----------
  app.get('/auth/google', (req, res) => {
    if (!google.enabled()) {
      return res.status(404).page('לא נמצא', html`<h1>התחברות עם Google אינה מוגדרת</h1>
        <p>מנהל המערכת יכול להפעיל אותה ב<a href="/admin/settings#google">הגדרות</a>.</p>`);
    }
    // The state cookie must live on the address Google sends the user back to (redirect there once).
    if (!google.onPublicHost(req) && !req.query.moved) {
      const target = new URL(req.originalUrl, config.baseUrl);
      target.searchParams.set('moved', '1');
      return res.redirect(target.href);
    }
    const { state, url } = google.begin(safeNext(req.query.next));
    res.cookie(GOOGLE_STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 10 * 60000, path: '/auth/google' });
    res.redirect(url);
  });

  app.get('/auth/google/callback', async (req, res) => {
    if (!google.enabled()) return res.redirect('/login');
    const cookieState = req.cookies[GOOGLE_STATE_COOKIE];
    res.clearCookie(GOOGLE_STATE_COOKIE, { path: '/auth/google', secure: req.secure });
    if (req.query.error) {
      if (req.query.error !== 'access_denied') google.recordError(new Error(`Google returned error=${req.query.error}`));
      res.flash('warning', req.query.error === 'access_denied' ? 'ההתחברות עם Google בוטלה' : 'Google דחה את ההתחברות. נסו שוב.');
      return res.redirect('/login');
    }
    let profile;
    try {
      profile = await google.complete({ code: req.query.code, state: req.query.state, cookieState });
    } catch (err) {
      if (!(err instanceof google.GoogleAuthError)) throw err;
      console.warn('[google] login failed:', err.message);
      google.recordError(err);
      res.flash('error', err.reason);
      return res.redirect('/login');
    }

    let user = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(profile.sub);
    if (!user) {
      // Google verified this address, so an existing account with the same e-mail is linked to it.
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(profile.email);
      if (user && user.google_sub && user.google_sub !== profile.sub) {
        res.flash('error', 'החשבון כבר מקושר לחשבון Google אחר');
        return res.redirect('/login');
      }
      if (user) {
        db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(profile.sub, user.id);
        audit(user.id, 'user.google_link', 'user', user.id, profile.email);
      }
    }
    if (user) return finishLogin(req, res, user, profile.next);

    // New person: continue to the registration form with name and e-mail from Google.
    const token = google.rememberSignup(profile);
    res.cookie(GOOGLE_SIGNUP_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 60000, path: '/' });
    res.flash('success', 'כמעט סיימנו: יש להשלים את פרטי ההרשמה.');
    res.redirect('/register');
  });

  app.post('/register', licenseUpload, async (req, res) => {
    const b = req.body;
    const gs = google.pendingSignup(req.cookies[GOOGLE_SIGNUP_COOKIE]);
    if (gs) b.email = gs.email; // the address Google verified, not whatever was posted
    const v = {
      first_name: String(b.first_name || '').trim(),
      last_name: String(b.last_name || '').trim(),
      id_number: String(b.id_number || '').trim(),
      phone: normalizePhone(b.phone),
      email: String(b.email || '').trim().toLowerCase(),
      license_expiry: String(b.license_expiry || ''),
      accept_policy: b.accept_policy === '1',
      accept_privacy: b.accept_privacy === '1',
    };
    const errors = [];

    // The license image and password from an earlier failed attempt are kept in a draft (see saveDraft).
    const draft = loadDraft(b.draft);
    let licenseFile = draft?.license_file || null;
    let licenseName = draft?.license_name || null;
    if (req.file) {
      storage.keep(req.file); // stored right away, so a failed attempt doesn't lose it
      if (licenseFile) storage.remove(licenseFile);
      licenseFile = req.file.filename;
      licenseName = uploadName(req.file);
    }
    let passwordHash = draft?.password_hash || null;
    const password = String(b.password || '');
    if (password && password.length < 8) errors.push('הסיסמה חייבת להכיל לפחות 8 תווים');
    else if (password) passwordHash = auth.hashPassword(password);

    if (!v.first_name || !v.last_name) errors.push('יש למלא שם פרטי ושם משפחה');
    if (!validIsraeliId(v.id_number)) errors.push('מספר תעודת הזהות אינו תקין');
    if (!validPhone(v.phone)) errors.push('מספר הטלפון הנייד אינו תקין');
    if (!validEmail(v.email)) errors.push('כתובת הדואר האלקטרוני אינה תקינה');
    if (!licenseFile) errors.push('יש להעלות צילום רישיון נהיגה (תמונה או PDF)');
    if (!time.isValidDate(v.license_expiry) || v.license_expiry < time.today()) errors.push('יש להזין תאריך תוקף רישיון עתידי');
    if (!v.accept_policy) errors.push('יש לאשר את נהלי השאלת הרכב');
    if (!v.accept_privacy) errors.push('יש לאשר את מדיניות הפרטיות');
    if (Number(b.policy_version) !== currentPolicy().version) errors.push('הנהלים עודכנו בזמן ההרשמה. יש לקרוא ולאשר אותם מחדש');
    if (db.prepare('SELECT 1 FROM users WHERE email = ? OR id_number = ?').get(v.email, v.id_number)) {
      errors.push('קיים כבר משתמש עם כתובת דואר אלקטרוני או תעודת זהות זו');
    }
    if (errors.length) {
      const token = saveDraft(draft?.token, { licenseFile, licenseName, passwordHash });
      return res.status(400).page('הרשמה', registerPage(req, {
        errors, v, draft: { token, licenseName, hasPassword: Boolean(passwordHash) },
      }));
    }

    const now = time.stamp();
    const id = Number(db.prepare(`INSERT INTO users (first_name, last_name, id_number, phone, email, password_hash,
        license_file, license_expiry, google_sub, privacy_accepted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(v.first_name, v.last_name, v.id_number, v.phone, v.email, passwordHash,
        licenseFile, v.license_expiry, gs ? gs.sub : null, now, now, now).lastInsertRowid);
    if (draft) dropDraft(draft.token);
    if (gs) {
      google.clearSignup(req.cookies[GOOGLE_SIGNUP_COOKIE]);
      res.clearCookie(GOOGLE_SIGNUP_COOKIE, { path: '/', secure: req.secure });
    }
    db.prepare('INSERT INTO policy_acceptances (user_id, policy_version, ip, accepted_at) VALUES (?, ?, ?, ?)').run(id, Number(b.policy_version), req.ip, now);
    audit(id, 'user.register', 'user', id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    await mail.newRegistration(user);
    auth.createSession(res, id);
    res.flash('success', 'ההרשמה התקבלה! החשבון ממתין לאישור המנהל. תישלח הודעה בדואר האלקטרוני לאחר הבדיקה.');
    res.redirect('/me');
  });

  // ---------- Forgot / reset password ----------
  const noStore = (res) => res.set('Cache-Control', 'no-store');

  app.get('/password/forgot', (req, res) => {
    res.page('שכחתי סיסמה', forgotPage(req, { email: String(req.query.email || '') }));
  });

  app.post('/password/forgot', async (req, res) => {
    const email = String(req.body.email || '').trim();
    if (auth.throttled('reset:' + req.ip, 5)) {
      return res.status(429).page('שכחתי סיסמה', forgotPage(req, { email, error: 'יותר מדי בקשות. נסו שוב בעוד מספר דקות.' }));
    }
    if (!validEmail(email)) return res.status(400).page('שכחתי סיסמה', forgotPage(req, { email, error: 'כתובת הדואר האלקטרוני אינה תקינה' }));
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Same answer whether or not the address is registered.
    const sent = user ? await mail.passwordReset(user, auth.createPasswordReset(user.id)) : true;
    if (!sent) {
      return res.status(503).page('שכחתי סיסמה', forgotPage(req, {
        email, error: 'שליחת המייל נכשלה. נסו שוב בעוד כמה דקות, או פנו למנהל המערכת.',
      }));
    }
    if (user) audit(user.id, 'user.password_reset_requested', 'user', user.id);
    res.page('שכחתי סיסמה', html`
<div class="narrow card">
  <h1>בדקו את תיבת הדואר</h1>
  <p>אם הכתובת <b dir="ltr">${email}</b> רשומה במערכת, נשלח אליה קישור לבחירת סיסמה חדשה. הקישור תקף לשעה.</p>
  ${!config.smtp && !config.production ? html`<div class="flash flash-warning small">
    מצב פיתוח: לא הוגדר שרת דואר (SMTP), ולכן המייל לא נשלח בפועל. <b>הקישור מודפס בחלון השרת</b>.</div>` : ''}
  <p class="muted small">לא הגיע? בדקו בתיקיית הספאם, או <a href="/password/forgot?email=${encodeURIComponent(email)}">בקשו קישור חדש</a>.</p>
  <p><a href="/login">חזרה להתחברות</a></p>
</div>`);
  });

  app.get('/password/reset', (req, res) => {
    noStore(res);
    const token = String(req.query.token || '');
    if (!auth.checkPasswordReset(token)) return res.status(400).page('איפוס סיסמה', invalidResetPage());
    res.page('איפוס סיסמה', resetPage(req, { token }));
  });

  app.post('/password/reset', async (req, res) => {
    noStore(res);
    const token = String(req.body.token || '');
    const password = String(req.body.password || '');
    if (auth.throttled('reset-set:' + req.ip, 10)) return res.status(429).page('איפוס סיסמה', invalidResetPage());
    if (!auth.checkPasswordReset(token)) return res.status(400).page('איפוס סיסמה', invalidResetPage());
    if (password.length < 8) return res.status(400).page('איפוס סיסמה', resetPage(req, { token, error: 'הסיסמה חייבת להכיל לפחות 8 תווים' }));
    if (password !== String(req.body.confirm || '')) {
      return res.status(400).page('איפוס סיסמה', resetPage(req, { token, error: 'הסיסמאות אינן זהות' }));
    }
    const userId = auth.resetPassword(token, password);
    if (!userId) return res.status(400).page('איפוס סיסמה', invalidResetPage());
    audit(userId, 'user.password_reset', 'user', userId);
    await mail.passwordChanged(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
    res.clearCookie(auth.COOKIE, { path: '/', secure: req.secure });
    res.flash('success', 'הסיסמה עודכנה. אפשר להתחבר עם הסיסמה החדשה.');
    res.redirect('/login');
  });

  app.get('/policy', (req, res) => {
    const policy = currentPolicy();
    res.page('נהלי השאלת הרכב', html`
<article class="card prose">
  <p class="muted">גרסה ${policy.version} · עודכן ${time.fmt(policy.created_at)}</p>
  ${markdown(policy.content)}
</article>
${req.user ? raw(`<p><a href="/policy/accept">לאישור הנהלים</a></p>`) : ''}`);
  });

  app.get('/privacy', (req, res) => {
    res.page('מדיניות פרטיות', html`
<article class="card prose">
  <h1>מדיניות פרטיות</h1>
  <p class="muted">טיוטה – יש להשלים בהתאם לייעוץ משפטי ולחוק הגנת הפרטיות.</p>
  <h2>איזה מידע נאסף</h2>
  <p>שם, מספר תעודת זהות, טלפון נייד, דואר אלקטרוני, צילום רישיון נהיגה ותאריך תוקפו, ופרטי ההזמנות שלך. המידע נאסף לצורך ניהול השאלת הרכב בלבד.</p>
  <h2>מי רואה את המידע</h2>
  <p>המידע נגיש לך ולמנהלי המערכת המורשים בלבד. משתמשים אחרים רואים ביומן שהרכב תפוס, אך לא מי הזמין אותו. צילום הרישיון נשמר באזור אחסון מוגן ואינו נגיש לציבור.</p>
  <h2>שמירה ומחיקה</h2>
  <p>המידע נשמר כל עוד החשבון פעיל ולפי הנדרש בדין. ניתן לבקש מהמנהל לעיין במידע, לתקן אותו או למחוק את החשבון.</p>
  ${config.vercelAnalytics ? html`<h2>סטטיסטיקת שימוש</h2>
  <p>לספירת צפיות בדפים אנחנו משתמשים ב־Vercel Web Analytics. הכלי אינו משתמש בעוגיות ואינו שומר מידע מזהה אישי.</p>` : ''}
  <h2>יצירת קשר</h2>
  <p>בכל שאלה ניתן לפנות למנהל המערכת: ${config.mailFrom}</p>
</article>`);
  });
};

module.exports.validIsraeliId = validIsraeliId;
module.exports.normalizePhone = normalizePhone;
module.exports.validPhone = validPhone;
module.exports.safeNext = safeNext;
