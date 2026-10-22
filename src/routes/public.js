'use strict';
const fs = require('node:fs');
const { db, audit, currentPolicy } = require('../db');
const auth = require('../auth');
const mail = require('../mail');
const time = require('../time');
const config = require('../config');
const { html, raw, markdown, postForm, field } = require('../views/html');

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
  ${postForm(req, '/login', html`
    <input type="hidden" name="next" value="${req.query.next || req.body?.next || ''}">
    ${field('דואר אלקטרוני', html`<input type="email" name="email" value="${email}" required autocomplete="username">`)}
    ${field('סיסמה', html`<input type="password" name="password" required autocomplete="current-password">`)}
    <button class="btn btn-primary btn-block">כניסה</button>
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
function finishLogin(req, res, user) {
  auth.resetThrottle('login:' + req.ip);
  const needs2fa = Boolean(user.totp_enabled);
  auth.createSession(res, user.id, needs2fa);
  if (needs2fa) return res.redirect('/login/2fa' + (safeNext(req.body.next) ? '?next=' + encodeURIComponent(req.body.next) : ''));
  res.redirect(safeNext(req.body.next) || homeFor(user));
}

function registerPage(req, { errors = [], v = {} } = {}) {
  const policy = currentPolicy();
  return html`
<h1>הרשמה למערכת</h1>
<p class="muted">לאחר ההרשמה המנהל יבדוק את הפרטים ואת רישיון הנהיגה. לא ניתן להזמין את הרכב עד לאישור.</p>
${errors.length ? html`<div class="flash flash-error"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
${postForm(req, '/register', html`
  <fieldset>
    <legend>פרטים אישיים</legend>
    <div class="grid2">
      ${field('שם פרטי', html`<input name="first_name" value="${v.first_name}" required autocomplete="given-name">`)}
      ${field('שם משפחה', html`<input name="last_name" value="${v.last_name}" required autocomplete="family-name">`)}
      ${field('מספר תעודת זהות', html`<input name="id_number" value="${v.id_number}" required inputmode="numeric" maxlength="9">`)}
      ${field('טלפון נייד', html`<input type="tel" name="phone" value="${v.phone}" required placeholder="05XXXXXXXX" autocomplete="tel">`)}
    </div>
    ${field('דואר אלקטרוני', html`<input type="email" name="email" value="${v.email}" required autocomplete="email">`)}
    ${field('סיסמה', html`<input type="password" name="password" minlength="8" autocomplete="new-password">`,
      'לפחות 8 תווים. ניתן להשאיר ריק ולהתחבר תמיד באמצעות קוד חד־פעמי שיישלח לדואר האלקטרוני.')}
  </fieldset>
  <fieldset>
    <legend>רישיון נהיגה</legend>
    ${field('צילום רישיון נהיגה בתוקף', html`<input type="file" name="license" accept="image/*,application/pdf" required>`,
      'תמונה או PDF, עד 8MB. הקובץ נשמר באזור מוגן ונגיש למנהלים בלבד.')}
    ${field('תאריך פקיעת תוקף הרישיון', html`<input type="date" name="license_expiry" value="${v.license_expiry}" required min="${time.today()}">`)}
  </fieldset>
  <fieldset>
    <legend>אישורים</legend>
    <details class="policy-box"><summary>נהלי השאלת הרכב (גרסה ${policy.version}) – לחצו לקריאה</summary>
      <div class="prose">${markdown(policy.content)}</div></details>
    <label class="check"><input type="checkbox" name="accept_policy" value="1" required> <span>קראתי ואני מסכים/ה לנהלי השאלת הרכב (גרסה ${policy.version})</span></label>
    <label class="check"><input type="checkbox" name="accept_privacy" value="1" required> <span>קראתי ואני מסכים/ה ל<a href="/privacy" target="_blank">מדיניות הפרטיות</a></span></label>
    <input type="hidden" name="policy_version" value="${policy.version}">
  </fieldset>
  <button class="btn btn-primary btn-block">שליחת הרשמה</button>
`, 'enctype="multipart/form-data" class="card"')}`;
}

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
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Same response whether or not the address exists, to avoid revealing registered e-mails.
    if (user) await mail.loginCode(user, auth.createLoginCode(user.id));
    res.page('קוד התחברות', html`
<div class="narrow">
  <h1>הזנת קוד</h1>
  <p>אם הכתובת רשומה במערכת, נשלח אליה קוד בן 6 ספרות. הקוד תקף ל־10 דקות.</p>
  ${postForm(req, '/login/code/verify', html`
    <input type="hidden" name="email" value="${email}">
    ${field('קוד', html`<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus>`)}
    <button class="btn btn-primary btn-block">כניסה</button>`, 'class="card"')}
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

  app.post('/register', licenseUpload, async (req, res) => {
    const b = req.body;
    const v = {
      first_name: String(b.first_name || '').trim(),
      last_name: String(b.last_name || '').trim(),
      id_number: String(b.id_number || '').trim(),
      phone: normalizePhone(b.phone),
      email: String(b.email || '').trim().toLowerCase(),
      license_expiry: String(b.license_expiry || ''),
    };
    const errors = [];
    if (!v.first_name || !v.last_name) errors.push('יש למלא שם פרטי ושם משפחה');
    if (!validIsraeliId(v.id_number)) errors.push('מספר תעודת הזהות אינו תקין');
    if (!validPhone(v.phone)) errors.push('מספר הטלפון הנייד אינו תקין');
    if (!validEmail(v.email)) errors.push('כתובת הדואר האלקטרוני אינה תקינה');
    if (b.password && String(b.password).length < 8) errors.push('הסיסמה חייבת להכיל לפחות 8 תווים');
    if (!req.file) errors.push('יש להעלות צילום רישיון נהיגה (תמונה או PDF)');
    if (!time.isValidDate(v.license_expiry) || v.license_expiry < time.today()) errors.push('יש להזין תאריך תוקף רישיון עתידי');
    if (b.accept_policy !== '1') errors.push('יש לאשר את נהלי השאלת הרכב');
    if (b.accept_privacy !== '1') errors.push('יש לאשר את מדיניות הפרטיות');
    if (Number(b.policy_version) !== currentPolicy().version) errors.push('הנהלים עודכנו בזמן ההרשמה. יש לקרוא ולאשר אותם מחדש');
    if (db.prepare('SELECT 1 FROM users WHERE email = ? OR id_number = ?').get(v.email, v.id_number)) {
      errors.push('קיים כבר משתמש עם כתובת דואר אלקטרוני או תעודת זהות זו');
    }
    if (errors.length) {
      if (req.file) fs.rmSync(req.file.path, { force: true });
      return res.status(400).page('הרשמה', registerPage(req, { errors, v }));
    }

    const id = Number(db.prepare(`INSERT INTO users (first_name, last_name, id_number, phone, email, password_hash,
        license_file, license_expiry, privacy_accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`)
      .run(v.first_name, v.last_name, v.id_number, v.phone, v.email, b.password ? auth.hashPassword(String(b.password)) : null,
        req.file.filename, v.license_expiry).lastInsertRowid);
    db.prepare('INSERT INTO policy_acceptances (user_id, policy_version, ip) VALUES (?, ?, ?)').run(id, Number(b.policy_version), req.ip);
    audit(id, 'user.register', 'user', id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    await mail.newRegistration(user);
    auth.createSession(res, id);
    res.flash('success', 'ההרשמה התקבלה! החשבון ממתין לאישור המנהל. תישלח הודעה בדואר האלקטרוני לאחר הבדיקה.');
    res.redirect('/me');
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
  <h2>יצירת קשר</h2>
  <p>בכל שאלה ניתן לפנות למנהל המערכת: ${config.mailFrom}</p>
</article>`);
  });
};

module.exports.validIsraeliId = validIsraeliId;
module.exports.normalizePhone = normalizePhone;
module.exports.validPhone = validPhone;
module.exports.safeNext = safeNext;
