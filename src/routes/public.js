'use strict';
const crypto = require('node:crypto');
const { db, audit, currentPolicy } = require('../db');
const auth = require('../auth');
const mail = require('../mail');
const time = require('../time');
const config = require('../config');
const { html, raw, markdown, postForm, field, fieldError, errorSummary, icon, pageHead, licenseInput, uploadLimitLabel } = require('../views/html');
const google = require('../google');
const { brand } = require('../brand');
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

/** The client's contact details (Settings → Organization), or the sender address when none were set. */
function contactLine() {
  const b = brand();
  const parts = [b.contactPhone && html`<a href="tel:${b.contactPhone.replace(/[^\d+]/g, '')}" dir="ltr">${b.contactPhone}</a>`,
    b.contactEmail && html`<a href="mailto:${b.contactEmail}" dir="ltr">${b.contactEmail}</a>`].filter(Boolean);
  if (parts.length) return html`${parts[0]}${parts[1] ? html` · ${parts[1]}` : ''}`;
  return config.smtp ? html`<a href="mailto:${config.mailFrom}" dir="ltr">${config.mailFrom}</a>` : '';
}

const normalizePhone = (p) => String(p || '').replace(/[\s-]/g, '');
const validPhone = (p) => /^(05\d{8}|\+9725\d{8})$/.test(p);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/** Only allow redirects to local paths ("//host" and "/\\host" are treated by browsers as other origins). */
const safeNext = (n) => (typeof n === 'string' && /^\/(?![/\\])/.test(n) && !/[\r\n]/.test(n) ? n : null);

function homeFor(user) {
  if (config.master) return '/master';
  if (user.role === 'admin') return '/admin';
  return user.status === 'active' ? '/calendar' : '/me';
}

/** The login form. `next`: where to continue after signing in (defaults to ?next= of this request). */
function loginPage(req, { error, email = '', next = req.query.next || req.body?.next || '' } = {}) {
  return html`
<div class="narrow">
  <div class="auth-head"><span class="brand-mark">${icon('car', 30)}</span><h1>התחברות</h1>
    <p class="muted">${config.master ? 'כניסה למרכז הניהול של אתרי הלקוחות.' : 'ברוכים השבים! התחברו כדי לבדוק זמינות ולהזמין את הרכב.'}</p></div>
  ${errorSummary(error)}
  ${googleOption(req, '/auth/google' + (safeNext(next) ? '?next=' + encodeURIComponent(next) : ''), 'התחברות עם Google', '/login')}
  ${google.enabled() ? html`<p class="divider"><span>או</span></p>` : ''}
  ${postForm(req, '/login', html`
    <input type="hidden" name="next" value="${next}">
    ${field('דואר אלקטרוני', html`<input type="email" name="email" value="${email}" required autocomplete="username">`)}
    ${field('סיסמה', html`<input type="password" name="password" required autocomplete="current-password">`)}
    <button class="btn btn-primary btn-block">כניסה</button>
    ${mail.canDeliver() ? html`<p class="small"><a href="/password/forgot${email ? '?email=' + encodeURIComponent(email) : ''}">שכחתי סיסמה</a></p>`
      : html`<p class="muted small">שכחת סיסמה? פנו למנהל המערכת.</p>`}
  `, 'class="card"')}
  ${mail.canDeliver() ? html`<div class="card">
    <h2 class="section-title">${icon('lock')} כניסה עם קוד חד־פעמי</h2>
    <p class="muted">נשלח קוד בן 6 ספרות לכתובת הדואר האלקטרוני שלך.</p>
    ${postForm(req, '/login/code', html`
      ${field('דואר אלקטרוני', html`<input type="email" name="email" value="${email}" required autocomplete="email">`)}
      <button class="btn btn-light btn-block">שליחת קוד</button>`)}
  </div>` : ''}
  ${config.master ? '' : html`<p class="auth-foot">עדיין אין לך חשבון? <a href="/register">להרשמה</a></p>`}
</div>`;
}

/** Password, e-mail code or Google checked: start the session and go on. */
function finishLogin(req, res, user, next = req.body?.next) {
  // Only this account's failures are cleared: signing in to some other account must not reset the counter of the one
  // being guessed (SEC-002). The per-address counter runs out on its own.
  auth.resetThrottle(`login:acct:${user.id}`);
  auth.createSession(res, user.id);
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
<div class="narrow-wide">
${pageHead('הרשמה למערכת', { iconName: 'userplus', sub: 'לאחר ההרשמה המנהל יבדוק את הפרטים ואת רישיון הנהיגה. לא ניתן להזמין את הרכב עד לאישור.' })}
${errorSummary(errors)}
<p class="muted small">שדות המסומנים בכוכבית (*) הם שדות חובה.</p>
${gs ? html`<div class="flash flash-success">מתחברים עם חשבון Google <b>${gs.email}</b>. נשאר להשלים את הפרטים ולהעלות רישיון נהיגה.</div>`
    : googleOption(req, '/auth/google', 'הרשמה מהירה עם Google', '/register',
      'השם והדואר האלקטרוני יילקחו מחשבון Google. עדיין יש להשלים ת"ז, טלפון ורישיון נהיגה.')}
${postForm(req, '/register', html`
  ${draft ? html`<input type="hidden" name="draft" value="${draft.token}">` : ''}
  <fieldset>
    <legend>${icon('user')} פרטים אישיים</legend>
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
    <legend>${icon('id')} רישיון נהיגה</legend>
    ${draft?.licenseName
      ? field('צילום רישיון נהיגה (להחלפה בלבד)', licenseInput({ required: false }),
        html`<span class="saved">✓ הקובץ <b dir="auto">${draft.licenseName}</b> נשמר. אין צורך להעלות אותו שוב.</span>`)
      : field('צילום רישיון נהיגה בתוקף', licenseInput(),
        `תמונה או PDF, עד ${uploadLimitLabel()} (תמונה גדולה מוקטנת אוטומטית). הקובץ נשמר באזור מוגן ונגיש למנהלים בלבד.`)}
    ${field('תאריך פקיעת תוקף הרישיון', html`<input type="date" name="license_expiry" value="${v.license_expiry}" required min="${time.today()}">`)}
  </fieldset>
  <fieldset>
    <legend>${icon('shield')} אישורים</legend>
    <details class="policy-box"><summary>נהלי השאלת הרכב (גרסה ${policy.version}) – לחצו לקריאה</summary>
      <div class="prose">${markdown(policy.content)}</div></details>
    <label class="check"><input type="checkbox" name="accept_policy" value="1" required ${v.accept_policy ? raw('checked') : ''}> <span>קראתי ואני מסכים/ה לנהלי השאלת הרכב (גרסה ${policy.version})</span></label>
    <label class="check"><input type="checkbox" name="accept_privacy" value="1" required ${v.accept_privacy ? raw('checked') : ''}> <span>קראתי ואני מסכים/ה ל<a href="/privacy" target="_blank">מדיניות הפרטיות</a></span></label>
    <input type="hidden" name="policy_version" value="${policy.version}">
  </fieldset>
  <button class="btn btn-primary btn-block">שליחת הרשמה</button>
`, 'enctype="multipart/form-data" class="card"')}
<p class="auth-foot">כבר יש לך חשבון? <a href="/login">להתחברות</a></p>
</div>`;
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
  ${errorSummary(error)}
  ${!mail.canDeliver() ? html`<div class="flash flash-warning">באתר הזה לא הוגדרה שליחת מיילים, ולכן לא ניתן לשלוח קישור לאיפוס. לאיפוס הסיסמה פנו למנהל המערכת.</div>` : ''}
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
  ${errorSummary(error)}
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
  <span class="hero-badge">${icon('car', 34)}</span>
  <h1>הזמנת הרכב המשותף</h1>
  <p>${brand().welcomeText}</p>
  <div class="actions"><a class="btn btn-primary" href="/login">${icon('login')} התחברות</a> <a class="btn btn-light" href="/register">${icon('userplus')} הרשמה</a></div>
</section>
<h2 class="steps-title">איך זה עובד?</h2>
<section class="steps">
  <div class="card"><b>הרשמה</b><p>ממלאים פרטים, מעלים רישיון נהיגה ומאשרים את הנהלים.</p></div>
  <div class="card"><b>אישור מנהל</b><p>המנהל בודק את הפרטים ומאשר את החשבון.</p></div>
  <div class="card"><b>הזמנה</b><p>בוחרים מועד פנוי ביומן ושולחים בקשה.</p></div>
  <div class="card"><b>אישור סופי</b><p>לאחר אישור המנהל נשלח מייל עם כל הפרטים.</p></div>
</section>
<p class="site-footer"><a href="/policy">נהלי השאלת הרכב</a> · <a href="/privacy">מדיניות פרטיות</a>${contactLine() ? html`<br>ליצירת קשר: ${contactLine()}` : ''}</p>`);
  });

  app.get('/login', (req, res) => {
    if (req.user) return res.redirect(safeNext(req.query.next) || homeFor(req.user)); // already signed in: carry on
    res.page('התחברות', loginPage(req));
  });

  app.post('/login', (req, res) => {
    const email = String(req.body.email || '').trim().slice(0, 254);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Every attempt is counted first, in the database, per network address and per account; a success gives its count
    // back, so only failures add up and a sign-in to another account resets nothing (SEC-002). A locked password does
    // not lock the e-mailed code, "forgot password" or Google.
    const ipKey = `login:${req.ip}`;
    const overIp = auth.throttled(ipKey, 30);
    const overAccount = user ? auth.throttled(`login:acct:${user.id}`, 10) : false;
    if (overIp || overAccount) {
      return res.status(429).page('התחברות', loginPage(req, { error: 'יותר מדי ניסיונות. נסו שוב בעוד מספר דקות, או התחברו עם קוד במייל.', email }));
    }
    if (!user || !auth.verifyPassword(String(req.body.password || ''), user.password_hash)) {
      return res.status(401).page('התחברות', loginPage(req, { error: fieldError(['email', 'password'], 'דואר אלקטרוני או סיסמה שגויים'), email }));
    }
    auth.release(ipKey);
    finishLogin(req, res, user);
  });

  app.post('/login/code', async (req, res) => {
    const email = String(req.body.email || '').trim();
    if (!mail.canDeliver()) {
      return res.status(503).page('התחברות', loginPage(req, { error: 'באתר הזה לא הוגדרה שליחת מיילים, ולכן לא ניתן לשלוח קוד. התחברו עם סיסמה.', email }));
    }
    if (auth.throttled('code:' + req.ip, 5)) {
      return res.status(429).page('התחברות', loginPage(req, { error: 'יותר מדי בקשות. נסו שוב בעוד מספר דקות.', email }));
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).page('התחברות', loginPage(req, { error: fieldError('email', 'כתובת הדואר האלקטרוני אינה תקינה'), email }));
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
    const email = String(req.body.email || '').trim().slice(0, 254);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Per network address only: codes already allow 5 wrong tries per account (consumeLoginCode), and this way a
    // locked password never locks the code too.
    const ipKey = `code-verify:${req.ip}`;
    if (auth.throttled(ipKey, 30) || !user || !auth.consumeLoginCode(user.id, req.body.code)) {
      return res.status(401).page('התחברות', loginPage(req, { error: 'הקוד שגוי או שפג תוקפו', email: req.body.email }));
    }
    auth.release(ipKey);
    finishLogin(req, res, user);
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
        <p>מנהל המערכת יכול להפעיל אותה ב<a href="/admin/settings?tab=integrations">הגדרות</a>.</p>`);
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
    // A client site's Google sign-in comes back here, the one address registered with Google (GOOGLE_RELAY_URL on that
    // site): pass the answer on to that site, which checks it and signs the person in. Only to this console's clients.
    // (The client site itself then receives the answer here too: an answer meant for this site is handled normally.)
    const target = google.relayTarget(req.query.state);
    if (target && target !== new URL(config.baseUrl).origin) {
      if (!google.relayAllowed(target)) {
        console.warn(`[google] refused to pass a sign-in on to ${target}: not one of this site's clients`);
        return res.status(400).page('ההתחברות נכשלה', html`<div class="narrow"><section class="card"><h1>ההתחברות עם Google נכשלה</h1>
          <p>האתר שממנו התחלתם את ההתחברות אינו מוכר כאן. חזרו לאתר ונסו שוב, או התחברו עם סיסמה.</p></section></div>`);
      }
      const back = new URL('/auth/google/callback', target);
      for (const k of ['code', 'state', 'error', 'error_description']) if (req.query[k]) back.searchParams.set(k, String(req.query[k]));
      return res.set('Cache-Control', 'no-store').redirect(302, back.href);
    }
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
        // Google proved this address belongs to the person signing in. If nobody had proved it before, the account may
        // have been registered by someone else with this address: its password and sessions go before linking (SEC-003).
        if (auth.distrustUnverified(user)) {
          audit(user.id, 'user.unverified_password_removed', 'user', user.id, 'Google sign-in');
          res.flash('warning', 'לחשבון הייתה סיסמה שלא אומתה במייל, ולכן היא בוטלה. מעכשיו מתחברים עם Google, או בוחרים סיסמה חדשה ב"שכחתי סיסמה".');
        }
        db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(profile.sub, user.id);
        audit(user.id, 'user.google_link', 'user', user.id, profile.email);
      }
    }
    if (user) auth.markEmailVerified(user.id);
    if (user) return finishLogin(req, res, user, profile.next);

    // New person: continue to the registration form with name and e-mail from Google.
    const token = google.rememberSignup(profile);
    res.cookie(GOOGLE_SIGNUP_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 60000, path: '/' });
    res.flash('success', 'כמעט סיימנו: יש להשלים את פרטי ההרשמה.');
    res.redirect('/register');
  });

  app.post('/register', licenseUpload, async (req, res) => {
    // Anyone can post this form, with a file: at most 20 attempts an hour from one address (SEC-008). Each attempt
    // counts, so the file of a refused one is deleted before anything is kept.
    if (auth.throttled('register:' + req.ip, 20, 3600000)) {
      storage.discard(req.file);
      return res.status(429).page('הרשמה', html`<div class="narrow card"><h1>יותר מדי ניסיונות הרשמה</h1>
        <p>נשלחו מהרשת הזו יותר מדי טפסי הרשמה בשעה האחרונה. נסו שוב בעוד שעה, או פנו למנהל האתר.</p></div>`);
    }
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
    if (password && password.length < 8) errors.push(fieldError('password', 'הסיסמה חייבת להכיל לפחות 8 תווים'));
    else if (password) passwordHash = auth.hashPassword(password);

    if (!v.first_name || !v.last_name) errors.push(fieldError(['first_name', 'last_name'], 'יש למלא שם פרטי ושם משפחה'));
    if (!validIsraeliId(v.id_number)) errors.push(fieldError('id_number', 'מספר תעודת הזהות אינו תקין'));
    if (!validPhone(v.phone)) errors.push(fieldError('phone', 'מספר הטלפון הנייד אינו תקין'));
    if (!validEmail(v.email)) errors.push(fieldError('email', 'כתובת הדואר האלקטרוני אינה תקינה'));
    if (!licenseFile) errors.push(fieldError('license', 'יש להעלות צילום רישיון נהיגה (תמונה או PDF)'));
    if (!time.isValidDate(v.license_expiry) || v.license_expiry < time.today()) errors.push(fieldError('license_expiry', 'יש להזין תאריך תוקף רישיון עתידי'));
    if (!v.accept_policy) errors.push(fieldError('accept_policy', 'יש לאשר את נהלי השאלת הרכב'));
    if (!v.accept_privacy) errors.push(fieldError('accept_privacy', 'יש לאשר את מדיניות הפרטיות'));
    if (Number(b.policy_version) !== currentPolicy().version) errors.push(fieldError('accept_policy', 'הנהלים עודכנו בזמן ההרשמה. יש לקרוא ולאשר אותם מחדש'));
    // Two separate messages: "this e-mail already has an account" (sign in instead) is a different problem from
    // "this ID number belongs to another account".
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(v.email)) errors.push('כבר קיים חשבון עם כתובת הדואר האלקטרוני הזו. אפשר להתחבר אליו במקום להירשם.');
    else if (db.prepare('SELECT 1 FROM users WHERE id_number = ?').get(v.id_number)) errors.push('מספר תעודת הזהות הזה כבר רשום בחשבון אחר. בדקו את המספר, או פנו למנהל האתר.');
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
    if (gs) auth.markEmailVerified(id); // registered through Google: Google proved the address
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
    if (!mail.canDeliver()) return res.status(503).page('שכחתי סיסמה', forgotPage(req, { email }));
    if (auth.throttled('reset:' + req.ip, 5)) {
      return res.status(429).page('שכחתי סיסמה', forgotPage(req, { email, error: 'יותר מדי בקשות. נסו שוב בעוד מספר דקות.' }));
    }
    if (!validEmail(email)) return res.status(400).page('שכחתי סיסמה', forgotPage(req, { email, error: 'כתובת הדואר האלקטרוני אינה תקינה' }));
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Same answer whether or not the address is registered.
    const resetToken = user && auth.createPasswordReset(user.id);
    const sent = user ? await mail.passwordReset(user, resetToken) : true;
    if (user && sent && config.smtp) auth.markResetDelivered(resetToken);
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
    if (password.length < 8) return res.status(400).page('איפוס סיסמה', resetPage(req, { token, error: fieldError('password', 'הסיסמה חייבת להכיל לפחות 8 תווים') }));
    if (password !== String(req.body.confirm || '')) {
      return res.status(400).page('איפוס סיסמה', resetPage(req, { token, error: fieldError('confirm', 'הסיסמאות אינן זהות') }));
    }
    const userId = auth.resetPassword(token, password);
    if (!userId) return res.status(400).page('איפוס סיסמה', invalidResetPage());
    audit(userId, 'user.password_reset', 'user', userId);
    await mail.passwordChanged(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
    res.clearCookie(auth.COOKIE, { path: '/', secure: req.secure });
    res.flash('success', 'הסיסמה עודכנה. אפשר להתחבר עם הסיסמה החדשה.');
    res.redirect('/login');
  });

  // The client's logo (Settings → Organization). Public: it is shown on the login page too. The address carries the
  // file name (?v=…), so a new logo is a new address and the old one can be cached for long.
  app.get('/brand/logo', (req, res) => {
    const file = brand().logoFile;
    const data = file && storage.read(file);
    if (!data) return res.status(404).type('text/plain').send('Not found');
    res.set('Cache-Control', 'public, max-age=86400');
    res.type(require('node:path').extname(file)).send(data);
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

  // The accessibility statement required by the Israeli accessibility regulations (WCAG 2.1 AA / SI 5568). The
  // coordinator's details come from Settings → Organization; until they are filled in, a marked placeholder shows.
  app.get('/accessibility', (req, res) => {
    const b = brand();
    const missing = (what) => html`<mark class="placeholder">[יש להשלים: ${what}]</mark>`;
    const isAdmin = req.user?.role === 'admin';
    res.page('הצהרת נגישות', html`
<article class="card prose">
  <h1>הצהרת נגישות</h1>
  ${isAdmin && !(b.a11y.name && (b.a11y.phone || b.a11y.email)) ? html`<div class="flash flash-warning">חסרים פרטי רכז/ת הנגישות.
    <a href="/admin/settings?tab=general#branding">להשלמה בהגדרות ← הארגון ומיתוג</a></div>` : ''}
  <p>${b.name} רואה חשיבות רבה במתן שירות שוויוני ונגיש לכל המשתמשים, כולל אנשים עם מוגבלות. האתר הותאם לדרישות
    תקנות שוויון זכויות לאנשים עם מוגבלות (התאמות נגישות לשירות), התשע"ג־2013, ולתקן הישראלי ת"י 5568, המבוסס על
    הנחיות WCAG 2.1 ברמה AA.</p>
  <h2>מה הונגש באתר</h2>
  <ul>
    <li>ניווט מלא במקלדת, עם סימון ברור של הרכיב הממוקד, וקישור "דילוג לתוכן" בראש כל עמוד.</li>
    <li>התאמה לקוראי מסך: כותרות, תוויות לכל שדה ולכל כפתור, והודעות שמוקראות כשהן מופיעות.</li>
    <li>ניגודיות צבעים לפי הנדרש, וטקסט שאפשר להגדיל עד 200% בלי לאבד תוכן.</li>
    <li>התאמה לטלפון ולמחשב, בעברית ומימין לשמאל.</li>
    <li>שדות התאריך והשעה ניתנים להקלדה (יום/חודש/שנה, 24 שעות) ולבחירה מלוח שנה שנגיש במקלדת.</li>
  </ul>
  <h2>מגבלות ידועות</h2>
  <ul>
    <li>מסמכים שהמנהלים מעלים (למשל רישיון רכב או פוליסת ביטוח בפורמט PDF או כתמונה) עשויים שלא להיות נגישים במלואם.</li>
    <li>יומן הרכב בתצוגה שבועית כולל משבצות רבות; לניווט מהיר במקלדת מומלצת התצוגה היומית.</li>
  </ul>
  <h2>פנייה בנושא נגישות</h2>
  <p>נתקלתם בקושי? נשמח לשמוע ולתקן. אפשר לפנות לרכז/ת הנגישות:</p>
  <ul class="plain">
    <li><b>שם:</b> ${b.a11y.name || missing('שם רכז/ת הנגישות')}</li>
    <li><b>טלפון:</b> ${b.a11y.phone ? html`<a href="tel:${b.a11y.phone}" dir="ltr">${b.a11y.phone}</a>` : missing('טלפון')}</li>
    <li><b>דואר אלקטרוני:</b> ${b.a11y.email ? html`<a href="mailto:${b.a11y.email}" dir="ltr">${b.a11y.email}</a>` : missing('דואר אלקטרוני')}</li>
  </ul>
  <p>בפנייה כדאי לציין את העמוד, מה ניסיתם לעשות ובאיזה דפדפן או טכנולוגיה מסייעת השתמשתם.</p>
  <p class="muted small">ההצהרה עודכנה בתאריך 19/11/2026, בעקבות בדיקת נגישות של האתר.</p>
</article>`);
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
  <p>בכל שאלה ניתן לפנות למנהל המערכת${contactLine() ? html`: ${contactLine()}` : '.'}</p>
</article>`);
  });
};

module.exports.validIsraeliId = validIsraeliId;
module.exports.normalizePhone = normalizePhone;
module.exports.validPhone = validPhone;
module.exports.safeNext = safeNext;
module.exports.validEmail = validEmail;
module.exports.loginPage = loginPage;
module.exports.uploadName = uploadName;
