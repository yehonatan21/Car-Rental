'use strict';
// The master console (APP_MODE=master): one place to create and manage every client's site. Each client keeps its
// own deployment, database and managers; from here the console's admins see all of them, create new ones, sign in to
// any of them as a manager, invite each client's managers, change names and colours, suspend, rebuild and delete.
const fs = require('node:fs');
const { db, audit } = require('../db');
const auth = require('../auth');
const mail = require('../mail');
const time = require('../time');
const config = require('../config');
const storage = require('../storage');
const provision = require('../provision');
const master = require('../master');
const { DEFAULT_COLOR, brand } = require('../brand');
const { html, raw, postForm, field, badge, icon, pageHead, pageTabs, activeTab, newPasswordPage: passwordPage } = require('../views/html');
const { validEmail } = require('./public');
const { emailStatusCard, googleStatusCard } = require('./admin');
const { mainAdminEmail } = require('../bootstrap');

const fullName = (u) => `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim();
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const LOGO_MAX_BYTES = 1024 * 1024;
const VERCEL_TOKENS_URL = 'https://vercel.com/account/tokens';

/**
 * Setting other people's passwords is for the main admin only: the ADMIN_EMAIL account (or, while ADMIN_EMAIL is not
 * set, every console admin).
 */
const isMainAdmin = (u) => { const main = mainAdminEmail(); return Boolean(u) && (!main || u.email === main); };
const ROLE_LABEL = (u) => (u.role === 'admin' ? badge('admin', 'מנהל/ת') : badge('completed', 'משתמש/ת'));

/** Created here in the last 20 minutes: a site that does not answer yet is most likely still being built. */
const isNew = (c) => Boolean(c.provisioned) && c.created_at >= time.stamp(new Date(Date.now() - 20 * 60000));

function stateBadge(c, st) {
  if (st.online) return st.data.suspended ? badge('pending', 'מושהה') : badge('active', 'פעיל');
  if (!c.url) return badge('pending', isNew(c) ? 'בבנייה' : 'ללא כתובת');
  if (isNew(c) && ['unreachable', 'timeout', 'not_app', 'down'].includes(st.kind)) return badge('pending', 'בבנייה');
  return badge('blocked', 'לא זמין');
}

const dot = (color) => html`<span class="client-dot" style="background:${/^#[0-9a-f]{6}$/i.test(color || '') ? color : DEFAULT_COLOR}"></span>`;
const statusData = (st) => (st.online ? st.data : st.last);

/** Short version label, and whether it differs from the console's own code. */
function versionLabel(data) {
  const mine = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7);
  const theirs = data?.version?.commit;
  if (!theirs) return '';
  return html`<code>${theirs}</code>${mine && theirs !== mine ? html` ${badge('pending', 'גרסה שונה')}` : ''}`;
}

function setupNotice() {
  const p = master.providers();
  if (p.turso && p.vercel && master.clientRepo()) return '';
  return html`<div class="flash flash-warning">${icon('alert', 18)} כדי ליצור אתרים חדשים מכאן חסרים חיבורים ל־Turso / Vercel.
    <a href="/master/settings">להגדרת החיבורים</a></div>`;
}

module.exports = ({ app, requireAdmin: requireSiteAdmin, logoUpload }) => {
  // Inside a regular site (MASTER_CONSOLE=true) the console belongs to the site's main admin (ADMIN_EMAIL) alone; the
  // site's other managers run only their own site. A dedicated console (APP_MODE=master) is for all its admins.
  const onlyMainAdmin = (req, res, next) => {
    const main = mainAdminEmail();
    if (main && req.user.email === main) return next();
    res.status(403).page('אין הרשאה', html`<div class="narrow"><section class="card"><h1>אין הרשאה לעמוד זה</h1>
      <p>מרכז הניהול זמין רק למנהל/ת הראשי/ת של האתר.</p></section></div>`);
  };
  const requireAdmin = config.master ? requireSiteAdmin : [requireSiteAdmin, onlyMainAdmin];
  // The console's own admins exist only in a dedicated console; inside a site its managers are managed as usual.
  const dedicatedOnly = (req, res, next) => (config.master ? next() : res.redirect(req.method === 'GET' ? 302 : 303, '/admin/users?role=admin'));
  const backTo = (c, hash = '') => `/master/clients/${encodeURIComponent(c.slug)}${hash}`;
  /** Loads the client of :slug, or goes back to the list. */
  const withClient = (fn) => async (req, res) => {
    const c = master.get(req.params.slug);
    if (!c) {
      res.flash('error', 'הלקוח לא נמצא');
      return res.redirect(req.method === 'GET' ? 302 : 303, '/master');
    }
    return fn(req, res, c);
  };
  /** A console action on a client: errors from the site or the hosting services become a message on its page. */
  const clientAction = (name, fn, ...middleware) => app.post(`/master/clients/:slug/${name}`, requireAdmin, ...middleware, withClient(async (req, res, c) => {
    try {
      await fn(req, res, c);
    } catch (err) {
      // Mistakes in the code itself still go to the error page; anything else is a message to the admin.
      if (err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError) throw err;
      console.warn(`[master] ${name} for ${c.slug} failed:`, err.message);
      res.flash('error', err.message);
      res.redirect(303, backTo(c));
    }
  }));

  // ---------- All clients ----------
  app.get('/master', requireAdmin, async (req, res) => {
    let clients = master.list();
    // Addresses of new sites appear once their first deployment is ready.
    await Promise.all(clients.filter((c) => !c.url).map((c) => master.discoverUrl(c).catch(() => null)));
    clients = master.list();
    const statuses = await master.statusAll(clients);
    const online = statuses.filter((s) => s.online);
    const sum = (k) => online.reduce((n, s) => n + (s.data.counts?.[k] || 0), 0);
    res.page('לקוחות', html`
${pageHead('לקוחות', {
    iconName: 'dashboard', sub: 'כל אתרי הלקוחות. לכל לקוח אתר, מסד נתונים ומנהלים משלו.',
    actions: html`<a class="btn btn-primary" href="/master/clients/new">${icon('plus')} לקוח חדש</a>
      <a class="btn btn-light" href="/master/clients/import">${icon('login')} הוספת אתר קיים</a>
      ${config.master ? '' : html`<a class="btn btn-light" href="/master/settings">${icon('settings')} חיבורים</a>`}`,
  })}
${setupNotice()}
<div class="stats">
  <div class="stat">${icon('car')}<b>${clients.length}</b><span>לקוחות</span></div>
  <div class="stat ${online.length < clients.length ? 'warn' : ''}">${icon('check')}<b>${online.filter((s) => !s.data.suspended).length}</b><span>אתרים פעילים</span></div>
  <div class="stat">${icon('users')}<b>${sum('users')}</b><span>משתמשים בכל האתרים</span></div>
  <div class="stat ${sum('pendingUsers') + sum('pendingBookings') ? 'hot' : ''}">${icon('clock')}<b>${sum('pendingUsers') + sum('pendingBookings')}</b><span>ממתינים לאישור המנהלים</span></div>
</div>
<section class="card">
${clients.length ? html`<table class="table">
<thead><tr><th>לקוח</th><th>מצב</th><th>משתמשים</th><th>ממתינים לאישור</th><th>הזמנות קרובות</th><th>מנהל/ת</th><th></th></tr></thead>
<tbody>${clients.map((c, i) => {
    const st = statuses[i];
    const d = statusData(st);
    return html`<tr>
  <td data-label="לקוח"><a class="client-name" href="${backTo(c)}">${dot(d?.branding?.color)}<b>${c.name}</b></a>
    ${c.url ? html`<br><a class="muted small" href="${c.url}" target="_blank" rel="noopener" dir="ltr">${c.url.replace(/^https?:\/\//, '')}</a>` : ''}</td>
  <td data-label="מצב">${stateBadge(c, st)} ${st.online ? versionLabel(d) : ''}</td>
  <td data-label="משתמשים">${d ? d.counts.users : '—'}</td>
  <td data-label="ממתינים לאישור">${d ? d.counts.pendingUsers + d.counts.pendingBookings : '—'}</td>
  <td data-label="הזמנות קרובות">${d ? d.counts.upcomingBookings : '—'}</td>
  <td data-label="מנהל/ת"><span dir="ltr">${c.manager_email || '—'}</span></td>
  <td><a class="btn btn-light btn-sm" href="${backTo(c)}">ניהול</a>
    ${st.online ? html`<a class="btn btn-light btn-sm" href="${backTo(c, '/login')}">${icon('login', 16)} כניסה כמנהל</a>` : ''}</td>
</tr>`;
  })}</tbody></table>` : html`<p class="empty">${icon('car', 28)}<span>${config.master ? 'עדיין אין לקוחות. צרו אתר ללקוח חדש, או הוסיפו את האתר שכבר קיים.'
    : `עדיין אין לקוחות נוספים. האתר הזה (${brand().name}) מנוהל כרגיל מהתפריט; כאן יוצרים ומנהלים את האתרים של לקוחות אחרים.`}</span></p>`}
</section>`);
  });

  // ---------- A new client ----------
  function newClientPage(req, { errors = [], v = {} } = {}) {
    const p = master.providers();
    const ready = p.turso && p.vercel && master.clientRepo();
    const smtp = master.sharedMailVars();
    const g = master.sharedGoogleVars();
    return html`
<div class="narrow">
  ${pageHead('לקוח חדש', { iconName: 'plus', sub: 'נוצרים אתר ומסד נתונים חדשים, נפרדים לגמרי מכל לקוח אחר.' })}
  ${ready ? '' : html`<div class="flash flash-warning">${icon('alert', 18)} כדי ליצור אתר מכאן צריך קודם לחבר את Turso ו־Vercel.
    <a href="/master/settings">להגדרת החיבורים</a>. אפשר גם <a href="/master/clients/import">להוסיף אתר שכבר קיים</a>.</div>`}
  ${errors.length ? html`<div class="flash flash-error" role="alert"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
  ${postForm(req, '/master/clients/new', html`
    ${field('שם הלקוח', html`<input name="name" value="${v.name || ''}" maxlength="60" required>`, 'מופיע בראש האתר, בכותרות ובמיילים. הלקוח יוכל לשנות אותו.')}
    ${field('מזהה קצר באנגלית', html`<input name="slug" value="${v.slug || ''}" pattern="[a-z0-9][a-z0-9\\-]{0,30}" maxlength="32" dir="ltr" required placeholder="bne-adam">`,
    'אותיות קטנות באנגלית, ספרות ומקף. ממנו נגזרת הכתובת: car-rental-<מזהה>.vercel.app')}
    <h2 class="section-title">${icon('user')} מנהל/ת האתר</h2>
    ${field('דואר אלקטרוני', html`<input type="email" name="manager_email" value="${v.manager_email || ''}" dir="ltr" required>`,
    'כשהאתר יעלה, תשלחו מכאן הזמנה עם קישור לבחירת סיסמה.')}
    <div class="grid2">
      ${field('שם פרטי', html`<input name="manager_first_name" value="${v.manager_first_name || ''}" maxlength="60">`)}
      ${field('שם משפחה', html`<input name="manager_last_name" value="${v.manager_last_name || ''}" maxlength="60">`)}
    </div>
    <h2 class="section-title">${icon('settings')} מראה ופרטי קשר</h2>
    ${field('צבע ראשי', html`<input type="color" name="color" value="${v.color || DEFAULT_COLOR}">`)}
    <div class="grid2">
      ${field('טלפון ליצירת קשר', html`<input name="contact_phone" value="${v.contact_phone || ''}" dir="ltr" maxlength="30">`)}
      ${field('מייל ליצירת קשר', html`<input type="email" name="contact_email" value="${v.contact_email || ''}" dir="ltr" maxlength="120">`)}
    </div>
    <h2 class="section-title">${icon('file')} מיילים והתחברות</h2>
    ${smtp ? html`<label class="check"><input type="checkbox" name="shared_mail" value="1" ${v.shared_mail === undefined || v.shared_mail ? 'checked' : ''}>
      <span>שליחת המיילים של הלקוח מתיבת הדואר של מרכז הניהול (<span dir="ltr">${smtp.MAIL_FROM}</span>), בשם הלקוח</span></label>`
    : html`<p class="muted small">למרכז הניהול לא הוגדרה תיבת דואר, ולכן לאתר החדש לא יוגדרו מיילים. אפשר להוסיף אותם אחר כך בהגדרות הפרויקט שלו ב־Vercel.</p>`}
    ${g ? html`<label class="check"><input type="checkbox" name="shared_google" value="1" ${v.shared_google ? 'checked' : ''}>
      <span>התחברות עם Google (דרך כתובת החזרה של האתר הזה, בלי שינוי ב־Google Cloud)</span></label>` : ''}
    <button class="btn btn-primary btn-block" ${ready ? '' : raw('disabled')}>${icon('plus')} יצירת האתר</button>
    <p class="muted small">היצירה לוקחת כמה שניות, ובניית האתר עצמו עוד כ־1–2 דקות.</p>`, 'class="card"')}
</div>`;
  }

  app.get('/master/clients/new', requireAdmin, (req, res) => res.page('לקוח חדש', newClientPage(req)));

  app.post('/master/clients/new', requireAdmin, async (req, res) => {
    const b = req.body;
    const v = {
      name: String(b.name || '').trim(), slug: String(b.slug || '').trim().toLowerCase(),
      manager_email: String(b.manager_email || '').trim().toLowerCase(),
      manager_first_name: String(b.manager_first_name || '').trim(), manager_last_name: String(b.manager_last_name || '').trim(),
      color: String(b.color || '').toLowerCase(), contact_phone: String(b.contact_phone || '').trim(), contact_email: String(b.contact_email || '').trim(),
      shared_mail: b.shared_mail === '1', shared_google: b.shared_google === '1',
    };
    const errors = [];
    if (!v.name) errors.push('יש למלא את שם הלקוח');
    if (!provision.validSlug(v.slug)) errors.push('המזהה הקצר: אותיות קטנות באנגלית, ספרות ומקף (עד 32 תווים, לא בהתחלה או בסוף)');
    else if (master.get(v.slug)) errors.push('כבר יש לקוח עם המזהה הזה');
    if (!validEmail(v.manager_email)) errors.push('כתובת הדואר האלקטרוני של המנהל/ת אינה תקינה');
    if (v.contact_email && !validEmail(v.contact_email)) errors.push('כתובת המייל ליצירת קשר אינה תקינה');
    if (v.color && !/^#[0-9a-f]{6}$/.test(v.color)) errors.push('הצבע אינו תקין');
    if (errors.length) return res.status(400).page('לקוח חדש', newClientPage(req, { errors, v }));
    let result;
    try {
      result = await master.createClient({
        slug: v.slug, name: v.name, managerEmail: v.manager_email, color: v.color && v.color !== DEFAULT_COLOR ? v.color : '',
        contactPhone: v.contact_phone, contactEmail: v.contact_email, sharedMail: v.shared_mail, sharedGoogle: v.shared_google,
      }, req.user.id);
    } catch (err) {
      console.error('[master] creating a client failed:', err.message);
      return res.status(502).page('לקוח חדש', newClientPage(req, {
        errors: [`יצירת האתר נכשלה: ${err.message}`, 'אפשר לנסות שוב עם אותו מזהה: מה שכבר נוצר ישמש שוב.'], v,
      }));
    }
    master.update(v.slug, { notes: [v.manager_first_name, v.manager_last_name].filter(Boolean).join(' ') ? `מנהל/ת: ${v.manager_first_name} ${v.manager_last_name}`.trim() : null });
    audit(req.user.id, 'master.client_create', null, null, `${v.slug}: ${result.database.name}, ${result.deployment.project}`);
    res.flash('success', `האתר של ${v.name} נוצר ונבנה עכשיו (בדרך כלל 1–2 דקות). כשהוא יעלה, שלחו מכאן הזמנה למנהל/ת.`);
    res.redirect(303, backTo(result.client));
  });

  // ---------- A site that already exists (created by hand or with npm run new-client) ----------
  function importPage(req, { errors = [], v = {} } = {}) {
    return html`
<div class="narrow">
  ${pageHead('הוספת אתר קיים', { iconName: 'login', sub: 'אתר הזמנת רכב שכבר פועל (למשל האתר הראשון), כדי לנהל אותו מכאן.' })}
  ${errors.length ? html`<div class="flash flash-error" role="alert"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
  ${postForm(req, '/master/clients/import', html`
    ${field('שם הלקוח', html`<input name="name" value="${v.name || ''}" maxlength="60" required>`)}
    ${field('מזהה קצר באנגלית', html`<input name="slug" value="${v.slug || ''}" pattern="[a-z0-9][a-z0-9\\-]{0,30}" maxlength="32" dir="ltr" required>`,
    'לשימוש פנימי. ממנו נגזר מפתח הניהול של האתר, ולכן אין לשנות אותו אחר כך.')}
    ${field('כתובת האתר', html`<input name="url" value="${v.url || ''}" dir="ltr" required placeholder="https://car-rental-brown-kappa.vercel.app">`)}
    ${field('שם הפרויקט ב־Vercel', html`<input name="vercel_project" value="${v.vercel_project || ''}" dir="ltr" placeholder="car-rental">`,
    'לא חובה. מאפשר להגדיר מכאן את מפתח הניהול, לבנות מחדש ולמחוק.')}
    ${field('שם מסד הנתונים ב־Turso', html`<input name="turso_db" value="${v.turso_db || ''}" dir="ltr">`, 'לא חובה. נדרש רק למחיקה מלאה מכאן.')}
    ${field('מייל המנהל/ת', html`<input type="email" name="manager_email" value="${v.manager_email || ''}" dir="ltr">`, 'לא חובה.')}
    <button class="btn btn-primary btn-block">הוספה לרשימה</button>`, 'class="card"')}
</div>`;
  }

  app.get('/master/clients/import', requireAdmin, (req, res) => res.page('הוספת אתר קיים', importPage(req)));

  app.post('/master/clients/import', requireAdmin, (req, res) => {
    const b = req.body;
    const v = {
      name: String(b.name || '').trim(), slug: String(b.slug || '').trim().toLowerCase(), url: String(b.url || '').trim(),
      vercel_project: String(b.vercel_project || '').trim(), turso_db: String(b.turso_db || '').trim(),
      manager_email: String(b.manager_email || '').trim().toLowerCase(),
    };
    const errors = [];
    const url = master.normalizeUrl(v.url);
    if (!v.name) errors.push('יש למלא את שם הלקוח');
    if (!provision.validSlug(v.slug)) errors.push('המזהה הקצר: אותיות קטנות באנגלית, ספרות ומקף');
    else if (master.get(v.slug)) errors.push('כבר יש לקוח עם המזהה הזה');
    if (!url) errors.push('כתובת האתר אינה תקינה (למשל https://car-rental-brown-kappa.vercel.app)');
    else if (master.list().some((c) => c.url === url)) errors.push('האתר בכתובת הזו כבר ברשימה');
    if (v.manager_email && !validEmail(v.manager_email)) errors.push('כתובת הדואר האלקטרוני של המנהל/ת אינה תקינה');
    if (v.vercel_project && !/^[\w.-]{1,100}$/.test(v.vercel_project)) errors.push('שם הפרויקט ב־Vercel אינו תקין');
    if (v.turso_db && !/^[\w.-]{1,100}$/.test(v.turso_db)) errors.push('שם מסד הנתונים אינו תקין');
    if (errors.length) return res.status(400).page('הוספת אתר קיים', importPage(req, { errors, v }));
    const c = master.add({ ...v, url, created_by: req.user.id });
    audit(req.user.id, 'master.client_import', null, null, `${c.slug}: ${url}`);
    res.flash('success', `${c.name} נוסף לרשימה. כדי לנהל אותו מכאן, צריך להגדיר בו את מפתח הניהול (הוראות למטה).`);
    res.redirect(303, backTo(c));
  });

  // ---------- One client ----------
  app.get('/master/clients/:slug', requireAdmin, withClient(async (req, res, c) => {
    if (!c.url) await master.discoverUrl(c).catch(() => null);
    c = master.get(c.slug);
    const st = await master.statusOf(c);
    const d = statusData(st);
    let admins = null;
    if (st.online) admins = (await master.call(c, 'GET', '/api/manage/admins').catch(() => null))?.admins || null;
    const p = master.providers();
    const project = c.vercel_project_id || c.vercel_project;
    const tokenProblem = ['unauthorized', 'not_enabled', 'not_app'].includes(st.kind) && !(isNew(c) && st.kind === 'not_app');

    res.page(c.name, html`
${pageHead(html`${dot(d?.branding?.color)} ${c.name}`, {
    sub: html`${c.url ? html`<a href="${c.url}" target="_blank" rel="noopener" dir="ltr">${c.url}</a> · ` : ''}<span dir="ltr">${c.slug}</span> · ${stateBadge(c, st)}`,
    actions: html`${st.online ? html`<a class="btn btn-primary" href="${backTo(c, '/login')}">${icon('login')} כניסה כמנהל</a>` : ''}
      <a class="btn btn-light" href="/master">${icon('arrow')} לכל הלקוחות</a>`,
  })}
${st.online ? '' : html`<div class="card alert">
  <h2 class="section-title">${icon('alert')} ${!c.url || (isNew(c) && !tokenProblem) ? 'האתר עדיין לא זמין' : 'אין חיבור לאתר'}</h2>
  <p>${!c.url && isNew(c) ? 'האתר נבנה עכשיו ב־Vercel. רעננו את הדף בעוד דקה.' : st.error}</p>
  ${isNew(c) && !tokenProblem ? html`<p><a class="btn btn-light btn-sm" href="${backTo(c)}">רענון</a></p>` : ''}
  ${tokenProblem ? html`<p>כדי לנהל את האתר מכאן, צריך להגדיר בו את מפתח הניהול:</p>
    <ol>
      <li>ב־Vercel ← הפרויקט${project ? html` <b dir="ltr">${project}</b>` : ''} ← Settings ← Environment Variables, הוסיפו משתנה בשם
        <code>MANAGE_TOKEN</code> (Sensitive, Production) עם הערך:<br><code class="select-all" dir="ltr">${master.manageToken(c.slug)}</code></li>
      <li>Deployments ← Redeploy, ואחרי כדקה רעננו את הדף.</li>
    </ol>
    ${project && p.vercel ? postForm(req, backTo(c, '/install-token'), html`<button class="btn btn-primary btn-sm">${icon('wrench', 16)} להגדיר אוטומטית ולבנות מחדש</button>`, 'class="inline"') : ''}` : ''}
  ${!c.url ? postForm(req, backTo(c, '/find-url'), html`<button class="btn btn-light btn-sm">חיפוש כתובת האתר</button>`, 'class="inline"') : ''}
</div>`}
${st.online && c.manager_email && !c.manager_invited_at && admins && !admins.some((a) => a.email === c.manager_email && !a.invitePending) ? html`
<div class="card alert">
  <h2 class="section-title">${icon('userplus')} ${c.provisioned ? 'האתר מוכן: שלחו הזמנה למנהל/ת' : 'המנהל/ת הרשום/ה כאן עדיין לא מנהל/ת באתר'}</h2>
  ${postForm(req, backTo(c, '/managers'), html`<input type="hidden" name="email" value="${c.manager_email}">
    <button class="btn btn-primary">${icon('userplus')} שליחת הזמנה אל <span dir="ltr">${c.manager_email}</span></button>`)}
</div>` : ''}
${d ? html`
<div class="stats">
  <div class="stat">${icon('users')}<b>${d.counts.users}</b><span>משתמשים (${d.counts.activeUsers} פעילים)</span></div>
  <div class="stat ${d.counts.pendingUsers ? 'hot' : ''}">${icon('userplus')}<b>${d.counts.pendingUsers}</b><span>משתמשים ממתינים לאישור</span></div>
  <div class="stat ${d.counts.pendingBookings ? 'hot' : ''}">${icon('clock')}<b>${d.counts.pendingBookings}</b><span>בקשות הזמנה ממתינות</span></div>
  <div class="stat">${icon('calendar')}<b>${d.counts.upcomingBookings}</b><span>הזמנות קרובות</span></div>
</div>
${st.online ? '' : html`<p class="muted small">הנתונים נכונים ל־${time.fmt(c.last_seen_at)}, הפעם האחרונה שהאתר ענה.</p>`}` : ''}
<div class="grid2">
  <section class="card" id="managers">
    <h2 class="section-title">${icon('shield')} מנהלי האתר</h2>
    ${admins ? html`<ul class="plain">${admins.map((a) => html`<li>
      <b>${a.firstName} ${a.lastName}</b> <span class="muted" dir="ltr">${a.email}</span>
      ${a.invitePending ? badge('pending', 'טרם בחר/ה סיסמה') : a.status === 'active' ? '' : badge('blocked', 'חסום/ה')}
      <div class="kv-inline">
        ${postForm(req, backTo(c, '/managers'), html`<input type="hidden" name="email" value="${a.email}"><input type="hidden" name="new_link" value="1">
          <button class="btn btn-light btn-sm">שליחת קישור לבחירת סיסמה</button>`, 'class="inline"')}
        ${postForm(req, backTo(c, `/managers/${a.id}/remove`), html`<button class="btn btn-light btn-sm" data-confirm="להסיר את הרשאות הניהול של ${a.email}?">הסרת הרשאת ניהול</button>`, 'class="inline"')}
      </div></li>`)}</ul>` : html`<p class="muted">${st.online ? 'לא ניתן לטעון את רשימת המנהלים.' : 'הרשימה תופיע כשיהיה חיבור לאתר.'}</p>`}
    ${st.online ? postForm(req, backTo(c, '/managers'), html`
      <h3>הוספת מנהל/ת</h3>
      ${field('דואר אלקטרוני', html`<input type="email" name="email" dir="ltr" required>`)}
      <div class="grid2">
        ${field('שם פרטי', html`<input name="first_name" maxlength="60">`)}
        ${field('שם משפחה', html`<input name="last_name" maxlength="60">`)}
      </div>
      <button class="btn btn-primary">${icon('userplus')} הוספה ושליחת הזמנה</button>
      <p class="muted small">נשלח מייל עם קישור לבחירת סיסמה (תקף ל־7 ימים). מי שכבר רשום באתר מקבל הרשאות ניהול.</p>`) : ''}
  </section>

  <section class="card" id="branding">
    <h2 class="section-title">${icon('settings')} שם, מראה ופרטי קשר</h2>
    ${d ? postForm(req, backTo(c, '/branding'), html`
      ${field('שם הלקוח', html`<input name="org_name" value="${d.branding.stored?.org_name || ''}" placeholder="${d.branding.name}" maxlength="60">`)}
      ${field('שם השולח במיילים', html`<input name="mail_from_name" value="${d.branding.stored?.mail_from_name || ''}" placeholder="${d.branding.mailFromName}" maxlength="60">`)}
      ${field('צבע ראשי', html`<input type="color" name="brand_color" value="${d.branding.color}">`)}
      <div class="grid2">
        ${field('טלפון ליצירת קשר', html`<input name="contact_phone" value="${d.branding.stored?.contact_phone || ''}" placeholder="${d.branding.contactPhone}" dir="ltr" maxlength="30">`)}
        ${field('מייל ליצירת קשר', html`<input type="email" name="contact_email" value="${d.branding.stored?.contact_email || ''}" placeholder="${d.branding.contactEmail}" dir="ltr" maxlength="120">`)}
      </div>
      ${field('טקסט הפתיחה בדף הבית', html`<textarea name="welcome_text" rows="2" maxlength="300" placeholder="${d.branding.welcomeText}">${d.branding.stored?.welcome_text || ''}</textarea>`)}
      ${field('לוגו', html`<input type="file" name="logo" accept="image/png,image/jpeg,image/webp" data-max-bytes="${LOGO_MAX_BYTES}">`, 'PNG, JPG או WebP, עד 1MB.')}
      ${d.branding.logo ? html`<p><img class="brand-logo" src="${c.url}/brand/logo" alt="הלוגו הנוכחי">
        <label class="check"><input type="checkbox" name="remove_logo" value="1"> <span>הסרת הלוגו</span></label></p>` : ''}
      <button class="btn btn-primary">שמירה באתר של הלקוח</button>
      <p class="muted small">שדה ריק: ברירת המחדל של האתר. גם מנהלי הלקוח יכולים לשנות את אלה בהגדרות שלהם.</p>`,
    'enctype="multipart/form-data"') : html`<p class="muted">יופיע כשיהיה חיבור לאתר.</p>`}
  </section>
</div>

${d ? html`<section class="card" id="system">
  <h2 class="section-title">${icon('wrench')} מצב האתר</h2>
  <dl class="dl">
    <dt>גרסה</dt><dd>${versionLabel(d) || '—'}</dd>
    <dt>מסד נתונים</dt><dd>${d.storage.kind === 'hosted' ? 'קבוע (Turso)' : d.storage.kind === 'temporary' ? html`<b>זמני – הנתונים נמחקים!</b>` : 'קובץ מקומי'} · מזהה <code>${d.storage.id}</code></dd>
    <dt>מיילים</dt><dd>${d.mail.configured ? html`נשלחים מ־<span dir="ltr">${d.mail.from}</span>` : html`<b>לא מוגדרים</b> – מנהלים ומשתמשים לא מקבלים מיילים`}</dd>
    <dt>התחברות עם Google</dt><dd>${!d.google ? 'לא מוגדרת' : d.googleRelay ? html`פעילה, דרך כתובת החזרה של <span dir="ltr">${d.googleRelay}</span> (אין צורך לשנות דבר ב־Google Cloud)`
    : html`פעילה. ב־Google Cloud צריך להופיע ה־Redirect URI: <code dir="ltr">${c.url}/auth/google/callback</code>`}</dd>
    <dt>הזמנה אחרונה</dt><dd>${d.lastBookingAt ? time.fmt(d.lastBookingAt) : '—'}</dd>
    <dt>נוסף למרכז</dt><dd>${time.fmt(c.created_at)}</dd>
  </dl>
</section>` : ''}

${st.online && isMainAdmin(req.user) ? html`<section class="card" id="users">
  <h2 class="section-title">${icon('users')} משתמשי האתר</h2>
  <p class="muted small card-intro">חיפוש משתמש/ת באתר של ${c.name} כדי להגדיר לו/ה סיסמה חדשה.</p>
  <form method="get" action="${backTo(c, '/users')}" class="kv-inline">
    <input name="q" placeholder="שם, מייל, טלפון או ת״ז" aria-label="חיפוש משתמש" class="inline-note">
    <button class="btn btn-light">${icon('users', 16)} חיפוש</button>
  </form>
</section>` : ''}

<section class="card" id="suspend">
  <h2 class="section-title">${icon('lock')} השהיית האתר</h2>
  ${d?.suspended ? html`<p>${badge('pending', 'האתר מושהה')} מאז ${time.fmt(d.suspended.at)}. כל מי שנכנס רואה: "${d.suspended.message || 'האתר אינו זמין כרגע'}".</p>
    ${postForm(req, backTo(c, '/resume'), html`<button class="btn btn-primary">${icon('check')} החזרת האתר לפעילות</button>`)}`
    : st.online ? postForm(req, backTo(c, '/suspend'), html`
      <p class="muted">האתר כולו ייסגר למשתמשים ולמנהלים (הנתונים נשמרים), עד שתחזירו אותו מכאן.</p>
      ${field('הודעה למבקרים', html`<input name="message" maxlength="500" placeholder="האתר אינו זמין כרגע. נסו שוב מאוחר יותר.">`)}
      <button class="btn btn-danger" data-confirm="להשהות את האתר של ${c.name}?">השהיית האתר</button>`) : html`<p class="muted">אפשרי כשיש חיבור לאתר.</p>`}
</section>

<section class="card" id="details">
  <h2 class="section-title">${icon('file')} פרטי הלקוח במרכז הניהול</h2>
  ${postForm(req, backTo(c, '/details'), html`
    ${field('שם', html`<input name="name" value="${c.name}" maxlength="60" required>`)}
    ${field('כתובת האתר', html`<input name="url" value="${c.url || ''}" dir="ltr" placeholder="https://…">`)}
    ${field('מייל המנהל/ת', html`<input type="email" name="manager_email" value="${c.manager_email || ''}" dir="ltr">`)}
    <div class="grid2">
      ${field('פרויקט ב־Vercel', html`<input name="vercel_project" value="${c.vercel_project || ''}" dir="ltr">`)}
      ${field('מסד נתונים ב־Turso', html`<input name="turso_db" value="${c.turso_db || ''}" dir="ltr">`)}
    </div>
    ${field('הערות', html`<textarea name="notes" rows="2" maxlength="1000">${c.notes || ''}</textarea>`)}
    <button class="btn btn-primary">שמירה</button>`)}
  <div class="kv-inline">
    ${project && p.vercel ? postForm(req, backTo(c, '/redeploy'), html`<button class="btn btn-light btn-sm" data-confirm="לבנות מחדש את האתר של ${c.name} מהגרסה האחרונה?">${icon('wrench', 16)} בנייה מחדש (גרסה אחרונה)</button>`, 'class="inline"') : ''}
    <a class="btn btn-light btn-sm btn-danger-text" href="${backTo(c, '/delete')}">מחיקת הלקוח…</a>
  </div>
</section>`);
  }));

  // Sign in to the client's site as a manager. A link (GET), not a form: browsers refuse to follow a form to another
  // site (the page's form-action policy). A link from another site only asks first, so it cannot be used to slip
  // someone into a client's site unnoticed.
  app.get('/master/clients/:slug/login', requireAdmin, withClient(async (req, res, c) => {
    if (req.get('sec-fetch-site') === 'cross-site') {
      return res.page('כניסה לאתר הלקוח', html`<div class="narrow"><section class="card">
        <h1>כניסה לאתר של ${c.name}</h1><p><a class="btn btn-primary" href="${backTo(c, '/login')}">כניסה כמנהל</a></p></section></div>`);
    }
    try {
      const r = await master.call(c, 'POST', '/api/manage/login-link', {
        email: req.user.email, first_name: req.user.first_name, last_name: req.user.last_name, by: req.user.email,
      });
      audit(req.user.id, 'master.client_login', null, null, c.slug);
      res.set('Cache-Control', 'no-store').redirect(302, c.url + r.path);
    } catch (err) {
      if (!(err instanceof master.InstanceError)) throw err;
      res.flash('error', `הכניסה לאתר נכשלה: ${err.message}`);
      res.redirect(backTo(c));
    }
  }));

  clientAction('managers', async (req, res, c) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!validEmail(email)) {
      res.flash('error', 'כתובת הדואר האלקטרוני אינה תקינה');
      return res.redirect(303, backTo(c, '#managers'));
    }
    const r = await master.call(c, 'POST', '/api/manage/admins', {
      email, first_name: req.body.first_name, last_name: req.body.last_name, new_link: req.body.new_link === '1',
      invited_by: fullName(req.user) || 'מנהל השירות', by: req.user.email,
    });
    if (email === c.manager_email) master.update(c.slug, { manager_invited_at: time.stamp() });
    audit(req.user.id, 'master.manager_invite', null, null, `${c.slug}: ${email}`);
    const what = r.created ? 'נוצר חשבון מנהל/ת' : r.promoted ? 'החשבון הקיים קיבל הרשאות ניהול' : 'החשבון כבר מנהל/ת';
    if (r.emailed) res.flash('success', `${what} עבור ${email}, ונשלח אליו/ה מייל${r.link ? ' עם קישור לבחירת סיסמה' : ''}.`);
    else if (r.link) {
      res.flash('warning', `${what} עבור ${email}, אבל ${r.mailConfigured ? 'שליחת המייל נכשלה' : 'באתר לא מוגדרים מיילים'}. `
        + `העבירו לו/ה את הקישור לבחירת סיסמה (תקף ל־7 ימים): ${c.url}${r.link}`);
    } else res.flash('success', `${what} עבור ${email}.`);
    res.redirect(303, backTo(c, '#managers'));
  });

  app.post('/master/clients/:slug/managers/:id/remove', requireAdmin, withClient(async (req, res, c) => {
    try {
      await master.call(c, 'POST', `/api/manage/admins/${Number(req.params.id)}/remove`, { by: req.user.email });
      audit(req.user.id, 'master.manager_remove', null, null, `${c.slug}: #${req.params.id}`);
      res.flash('success', 'הרשאת הניהול הוסרה');
    } catch (err) {
      if (!(err instanceof master.InstanceError)) throw err;
      res.flash('error', err.message);
    }
    res.redirect(303, backTo(c, '#managers'));
  }));

  clientAction('branding', async (req, res, c) => {
    const b = req.body;
    const body = { by: req.user.email };
    for (const k of ['org_name', 'mail_from_name', 'contact_phone', 'contact_email', 'welcome_text', 'brand_color']) if (k in b) body[k] = b[k];
    if (req.file) {
      const ok = LOGO_TYPES.includes(req.file.mimetype) && req.file.size <= LOGO_MAX_BYTES;
      const data = ok ? fs.readFileSync(req.file.path) : null;
      storage.discard(req.file);
      if (!ok) {
        res.flash('error', 'הלוגו צריך להיות תמונה (PNG, JPG או WebP) עד 1MB');
        return res.redirect(303, backTo(c, '#branding'));
      }
      body.logo = { type: req.file.mimetype, data: data.toString('base64') };
    } else if (b.remove_logo === '1') body.remove_logo = true;
    const st = await master.call(c, 'POST', '/api/manage/branding', body);
    if (b.org_name !== undefined && st.branding?.name) master.update(c.slug, { name: st.branding.name });
    audit(req.user.id, 'master.client_branding', null, null, c.slug);
    res.flash('success', 'הפרטים נשמרו באתר של הלקוח');
    res.redirect(303, backTo(c, '#branding'));
  }, logoUpload);

  // ---------- Users of a client site: a new password, by the main admin ----------
  const requireMain = (req, res, next) => (isMainAdmin(req.user) ? next()
    : res.status(403).page('אין הרשאה', html`<div class="narrow"><section class="card"><h1>רק המנהל/ת הראשי/ת</h1>
      <p>הגדרת סיסמה למשתמשים אחרים שמורה למנהל/ת הראשי/ת של מרכז הניהול (<span dir="ltr">${mainAdminEmail()}</span>).</p></section></div>`));

  app.get('/master/clients/:slug/users', requireAdmin, requireMain, withClient(async (req, res, c) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    let r;
    try {
      r = await master.call(c, 'GET', `/api/manage/users${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    } catch (err) {
      if (!(err instanceof master.InstanceError)) throw err;
      res.flash('error', err.message);
      return res.redirect(backTo(c));
    }
    res.page(`משתמשים · ${c.name}`, html`
<p><a class="back" href="${backTo(c)}">${icon('arrow', 16)} ${c.name}</a></p>
${pageHead('משתמשי האתר', { iconName: 'users', sub: `באתר של ${c.name}: ${r.total} משתמשים. מוצגים עד 50.` })}
<form method="get" class="filters card">
  <input name="q" value="${q}" placeholder="שם, מייל, טלפון או ת״ז" aria-label="חיפוש משתמש" class="inline-note">
  <button class="btn btn-primary">${icon('users', 16)} חיפוש</button>
  ${q ? html`<a class="btn btn-light" href="${backTo(c, '/users')}">ניקוי</a>` : ''}
</form>
<section class="card">
${r.users.length ? html`<table class="table"><thead><tr><th>שם</th><th>דואר אלקטרוני</th><th>תפקיד</th><th>התחברות</th><th></th></tr></thead><tbody>
${r.users.map((u) => html`<tr>
  <td data-label="שם"><b>${u.firstName} ${u.lastName}</b></td>
  <td data-label="דואר אלקטרוני"><span dir="ltr">${u.email}</span></td>
  <td data-label="תפקיד">${ROLE_LABEL(u)} ${u.status === 'blocked' ? badge('blocked', 'חסום/ה') : ''}</td>
  <td data-label="התחברות">${[u.hasPassword && 'סיסמה', u.google && 'Google'].filter(Boolean).join(' · ') || badge('pending', 'ללא סיסמה')}</td>
  <td><a class="btn btn-light btn-sm" href="${backTo(c, `/users/${u.id}/password`)}">${icon('lock', 16)} סיסמה חדשה</a></td>
</tr>`)}</tbody></table>` : html`<p class="empty">${icon('users', 28)}<span>לא נמצאו משתמשים.</span></p>`}
</section>`);
  }));

  const sitePasswordPage = async (req, res, c, error) => {
    const { user } = await master.call(c, 'GET', `/api/manage/users/${Number(req.params.id)}`);
    const st = await master.statusOf(c);
    res.status(error ? 400 : 200).page('סיסמה חדשה', passwordPage(req, {
      action: backTo(c, `/users/${user.id}/password`), user, where: `באתר של ${c.name}`, back: `${backTo(c, '/users')}?q=${encodeURIComponent(user.email)}`,
      mailOn: Boolean(st.online && st.data.mail?.configured), error,
    }));
  };

  app.get('/master/clients/:slug/users/:id/password', requireAdmin, requireMain, withClient(async (req, res, c) => {
    try {
      await sitePasswordPage(req, res, c);
    } catch (err) {
      if (!(err instanceof master.InstanceError)) throw err;
      res.flash('error', err.message);
      res.redirect(backTo(c, '/users'));
    }
  }));

  clientAction('users/:id/password', async (req, res, c) => {
    const password = String(req.body.password || '');
    if (password.length < 8) return sitePasswordPage(req, res, c, 'הסיסמה צריכה להכיל לפחות 8 תווים');
    const r = await master.call(c, 'POST', `/api/manage/users/${Number(req.params.id)}/password`, {
      password, notify: req.body.notify === '1', by: req.user.email,
    });
    audit(req.user.id, 'master.user_password', null, null, `${c.slug}: ${r.user.email}`);
    res.flash('success', `נקבעה סיסמה חדשה ל־${r.user.firstName} ${r.user.lastName} (${r.user.email}) באתר של ${c.name}. כל החיבורים שלו/ה נותקו`
      + `${r.emailed ? ', ונשלח מייל שהסיסמה הוחלפה' : ''}. העבירו לו/ה את הסיסמה החדשה.`);
    res.redirect(303, `${backTo(c, '/users')}?q=${encodeURIComponent(r.user.email)}`);
  }, requireMain);

  clientAction('suspend', async (req, res, c) => {
    await master.call(c, 'POST', '/api/manage/suspend', { suspended: true, message: req.body.message, by: req.user.email });
    audit(req.user.id, 'master.client_suspend', null, null, c.slug);
    res.flash('success', `האתר של ${c.name} הושהה`);
    res.redirect(303, backTo(c, '#suspend'));
  });

  clientAction('resume', async (req, res, c) => {
    await master.call(c, 'POST', '/api/manage/suspend', { suspended: false, by: req.user.email });
    audit(req.user.id, 'master.client_resume', null, null, c.slug);
    res.flash('success', `האתר של ${c.name} חזר לפעילות`);
    res.redirect(303, backTo(c, '#suspend'));
  });

  clientAction('redeploy', async (req, res, c) => {
    await master.redeploy(c);
    audit(req.user.id, 'master.client_redeploy', null, null, c.slug);
    res.flash('success', 'הבנייה מחדש התחילה. האתר יתעדכן בעוד כ־1–2 דקות.');
    res.redirect(303, backTo(c));
  });

  clientAction('install-token', async (req, res, c) => {
    await master.installToken(c);
    audit(req.user.id, 'master.client_token', null, null, c.slug);
    res.flash('success', 'מפתח הניהול הוגדר באתר, והוא נבנה מחדש. רעננו את הדף בעוד כ־1–2 דקות.');
    res.redirect(303, backTo(c));
  });

  clientAction('find-url', async (req, res, c) => {
    const url = await master.discoverUrl(c);
    res.flash(url ? 'success' : 'warning', url ? `נמצאה כתובת האתר: ${url}`
      : 'הכתובת עדיין לא נמצאה. אם האתר כבר נבנה, העתיקו אותה מ־Vercel (הפרויקט ← Domains) ל"פרטי הלקוח".');
    res.redirect(303, backTo(c));
  });

  clientAction('details', async (req, res, c) => {
    const b = req.body;
    const url = String(b.url || '').trim();
    const fields = {
      name: String(b.name || '').trim() || c.name, url: url ? master.normalizeUrl(url) : '', manager_email: String(b.manager_email || '').trim().toLowerCase(),
      vercel_project: String(b.vercel_project || '').trim(), turso_db: String(b.turso_db || '').trim(), notes: String(b.notes || '').trim().slice(0, 1000),
    };
    const errors = [];
    if (url && !fields.url) errors.push('כתובת האתר אינה תקינה');
    if (fields.manager_email && !validEmail(fields.manager_email)) errors.push('כתובת המייל של המנהל/ת אינה תקינה');
    for (const k of ['vercel_project', 'turso_db']) if (fields[k] && !/^[\w.-]{1,100}$/.test(fields[k])) errors.push('שם הפרויקט או מסד הנתונים אינו תקין');
    if (errors.length) {
      res.flash('error', errors.join('. '));
      return res.redirect(303, backTo(c, '#details'));
    }
    if (fields.vercel_project !== (c.vercel_project || '')) fields.vercel_project_id = '';
    if (fields.manager_email !== (c.manager_email || '')) fields.manager_invited_at = '';
    master.update(c.slug, fields);
    audit(req.user.id, 'master.client_details', null, null, c.slug);
    res.flash('success', 'הפרטים נשמרו');
    res.redirect(303, backTo(c, '#details'));
  });

  app.get('/master/clients/:slug/delete', requireAdmin, withClient((req, res, c) => {
    const p = master.providers();
    res.page(`מחיקת ${c.name}`, html`
<div class="narrow">
  ${pageHead(`מחיקת ${c.name}`, { iconName: 'alert' })}
  ${postForm(req, backTo(c, '/delete'), html`
    <label class="check"><input type="radio" name="mode" value="all" ${p.vercel || p.turso ? 'checked' : raw('disabled')}>
      <span><b>מחיקה מלאה:</b> הפרויקט ב־Vercel${c.vercel_project ? html` (<span dir="ltr">${c.vercel_project}</span>)` : ''}
      ומסד הנתונים ב־Turso${c.turso_db ? html` (<span dir="ltr">${c.turso_db}</span>)` : ''}. <b>כל הנתונים של הלקוח יימחקו לצמיתות</b>
      (משתמשים, הזמנות, רישיונות ומסמכים), והאתר יפסיק לפעול.</span></label>
    <label class="check"><input type="radio" name="mode" value="list" ${p.vercel || p.turso ? '' : 'checked'}>
      <span><b>הסרה מהרשימה בלבד:</b> האתר ממשיך לפעול כרגיל, רק לא מנוהל מכאן.</span></label>
    ${field(html`להמשך, הקלידו את המזהה <b dir="ltr">${c.slug}</b>`, html`<input name="confirm" dir="ltr" autocomplete="off" required>`)}
    <button class="btn btn-danger btn-block">מחיקה</button>
    <p class="muted small">לפני מחיקה מלאה אפשר לשמור גיבוי: <code dir="ltr">turso db shell ${c.turso_db || 'car-rental-…'} .dump &gt; backup.sql</code></p>`, 'class="card"')}
  <p><a class="back" href="${backTo(c)}">${icon('arrow', 16)} ביטול</a></p>
</div>`);
  }));

  clientAction('delete', async (req, res, c) => {
    if (String(req.body.confirm || '').trim() !== c.slug) {
      res.flash('error', 'המזהה שהוקלד אינו תואם, ולכן דבר לא נמחק');
      return res.redirect(303, backTo(c, '/delete'));
    }
    const resources = req.body.mode === 'all';
    await master.deleteClient(c, { resources });
    audit(req.user.id, resources ? 'master.client_delete' : 'master.client_unlist', null, null, `${c.slug}: ${c.vercel_project || '-'}, ${c.turso_db || '-'}`);
    res.flash('success', resources ? `${c.name} נמחק, כולל האתר ומסד הנתונים שלו.` : `${c.name} הוסר מהרשימה. האתר עצמו לא שונה.`);
    res.redirect(303, '/master');
  });

  // ---------- The console's own admins ----------
  app.get('/master/admins', requireAdmin, dedicatedOnly, (req, res) => {
    const admins = db.prepare("SELECT * FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id").all();
    const main = mainAdminEmail();
    res.page('מנהלי המרכז', html`
<div class="narrow">
  ${pageHead('מנהלי מרכז הניהול', { iconName: 'shield', sub: 'מי שמנהל את כל הלקוחות. מנהלי כל לקוח מנוהלים בדף הלקוח.' })}
  <section class="card">
    <ul class="plain">${admins.map((a) => html`<li><b>${fullName(a)}</b> <span class="muted" dir="ltr">${a.email}</span>
      ${a.email === main ? badge('admin', 'מנהל/ת ראשי/ת (ADMIN_EMAIL)') : ''}
      ${!a.password_hash && !a.google_sub ? badge('pending', 'ללא סיסמה') : ''}
      ${a.id === req.user.id ? badge('active', 'את/ה') : ''}
      <div class="kv-inline">
        ${isMainAdmin(req.user) ? html`<a class="btn btn-light btn-sm" href="/master/admins/${a.id}/password">${icon('lock', 16)} סיסמה חדשה</a>` : ''}
        ${a.id === req.user.id || a.email === main ? '' : postForm(req, `/master/admins/${a.id}/remove`,
    html`<button class="btn btn-light btn-sm" data-confirm="להסיר את ${a.email} ממנהלי המרכז?">הסרה</button>`, 'class="inline"')}
      </div></li>`)}</ul>
    ${main ? html`<p class="muted small">המנהל/ת הראשי/ת נקבע/ת במשתנה <code>ADMIN_EMAIL</code> של הפרויקט ב־Vercel, ותמיד נשאר/ת מנהל/ת.
      ${!config.smtp ? '' : 'בלי סיסמה אפשר להתחבר עם קוד חד־פעמי שנשלח למייל, או לבחור סיסמה ב"שכחתי סיסמה".'}</p>` : ''}
  </section>
  ${postForm(req, '/master/admins', html`
    <h2 class="section-title">${icon('userplus')} הוספת מנהל/ת למרכז</h2>
    ${field('דואר אלקטרוני', html`<input type="email" name="email" dir="ltr" required>`)}
    <div class="grid2">
      ${field('שם פרטי', html`<input name="first_name" maxlength="60" required>`)}
      ${field('שם משפחה', html`<input name="last_name" maxlength="60">`)}
    </div>
    <button class="btn btn-primary">הוספה ושליחת הזמנה</button>
    <p class="muted small">מנהל/ת המרכז יכול/ה לראות, לנהל ולמחוק את כל הלקוחות.</p>`, 'class="card"')}
</div>`);
  });

  app.post('/master/admins', requireAdmin, dedicatedOnly, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const first = String(req.body.first_name || '').trim().slice(0, 60);
    const last = String(req.body.last_name || '').trim().slice(0, 60);
    if (!validEmail(email) || !first) {
      res.flash('error', 'יש למלא שם פרטי וכתובת דואר אלקטרוני תקינה');
      return res.redirect(303, '/master/admins');
    }
    let u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const now = time.stamp();
    if (u) {
      // An unproven password on this address may not be the owner's: it goes before the account gets console rights.
      if (u.role !== 'admin' || u.status !== 'active') auth.distrustUnverified(u);
      db.prepare("UPDATE users SET role = 'admin', status = 'active', updated_at = ? WHERE id = ?").run(now, u.id);
      u = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
    } else {
      const id = db.prepare(`INSERT INTO users (first_name, last_name, id_number, phone, email, role, status, created_at, updated_at)
        VALUES (?, ?, ?, '', ?, 'admin', 'active', ?, ?)`).run(first, last, `master-${require('node:crypto').randomUUID()}`, email, now, now).lastInsertRowid;
      u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
    }
    audit(req.user.id, 'master.admin_add', 'user', u.id, email);
    if (u.password_hash || u.google_sub) {
      res.flash('success', `${email} הוא/היא עכשיו מנהל/ת המרכז`);
      return res.redirect(303, '/master/admins');
    }
    const token = auth.createPasswordReset(u.id, auth.INVITE_TTL_MS);
    const sent = await mail.invitation(u, token, fullName(req.user)) && Boolean(config.smtp);
    if (sent) auth.markResetDelivered(token);
    res.flash(sent ? 'success' : 'warning', sent ? `נשלח אל ${email} מייל עם קישור לבחירת סיסמה.`
      : `${email} נוסף/ה, אבל ${config.smtp ? 'שליחת המייל נכשלה' : 'לא הוגדר שרת דואר'}. העבירו את הקישור לבחירת סיסמה (תקף ל־7 ימים): `
        + `${config.baseUrl}/password/reset?token=${encodeURIComponent(token)}`);
    res.redirect(303, '/master/admins');
  });

  app.post('/master/admins/:id/remove', requireAdmin, dedicatedOnly, (req, res) => {
    const id = Number(req.params.id);
    const others = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id != ?").get(id).n;
    if (id === req.user.id || !others) {
      res.flash('error', 'אי אפשר להסיר את עצמך');
      return res.redirect(303, '/master/admins');
    }
    if (db.prepare('SELECT email FROM users WHERE id = ?').get(id)?.email === mainAdminEmail()) {
      res.flash('error', 'המנהל/ת הראשי/ת נקבע/ת ב־ADMIN_EMAIL ואי אפשר להסיר אותו/ה מכאן');
      return res.redirect(303, '/master/admins');
    }
    db.prepare("UPDATE users SET role = 'user', status = 'blocked', updated_at = ? WHERE id = ? AND role = 'admin'").run(time.stamp(), id);
    auth.destroyAllSessions(id);
    audit(req.user.id, 'master.admin_remove', 'user', id);
    res.flash('success', 'המנהל/ת הוסר/ה');
    res.redirect(303, '/master/admins');
  });

  // A console admin's password, set by the main admin (also their own, e.g. when they signed in with a code).
  const consoleAdmin = (id) => {
    const a = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'admin'").get(Number(id));
    return a && { id: a.id, firstName: a.first_name, lastName: a.last_name, email: a.email, raw: a };
  };
  const consolePasswordPage = (req, res, a, error) => res.status(error ? 400 : 200).page('סיסמה חדשה', passwordPage(req, {
    action: `/master/admins/${a.id}/password`, user: a, where: 'במרכז הניהול', back: '/master/admins', mailOn: Boolean(config.smtp), error,
  }));

  app.get('/master/admins/:id/password', requireAdmin, dedicatedOnly, requireMain, (req, res) => {
    const a = consoleAdmin(req.params.id);
    if (!a) return res.redirect('/master/admins');
    consolePasswordPage(req, res, a);
  });

  app.post('/master/admins/:id/password', requireAdmin, dedicatedOnly, requireMain, async (req, res) => {
    const a = consoleAdmin(req.params.id);
    if (!a) return res.redirect(303, '/master/admins');
    const password = String(req.body.password || '');
    if (password.length < 8 || password.length > 200) return consolePasswordPage(req, res, a, 'הסיסמה צריכה להכיל לפחות 8 תווים');
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(auth.hashPassword(password), time.stamp(), a.id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(a.id);
    // Everyone signed in with this account is signed out, except the person doing it on their own account.
    if (a.id === req.user.id) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(a.id, req.session.token_hash);
    else auth.destroyAllSessions(a.id);
    audit(req.user.id, 'master.admin_password', 'user', a.id, a.email);
    const emailed = req.body.notify === '1' && a.id !== req.user.id ? Boolean(await mail.passwordSetByAdmin(a.raw)) && Boolean(config.smtp) : false;
    res.flash('success', a.id === req.user.id ? 'הסיסמה שלך עודכנה.'
      : `נקבעה סיסמה חדשה ל־${a.email}${emailed ? ', ונשלח מייל שהסיסמה הוחלפה' : ''}. העבירו לו/ה את הסיסמה החדשה.`);
    res.redirect(303, '/master/admins');
  });

  // ---------- Settings: connections to the hosting services, e-mail, signing in ----------
  const SETTINGS_TABS = [['connections', 'חיבורים', 'wrench'], ['mail', 'מיילים', 'file'], ['signin', 'התחברות ומנהל ראשי', 'shield']];

  function settingsPage(req, checks) {
    const tab = checks ? 'connections' : activeTab(req, SETTINGS_TABS);
    const p = master.providers();
    const e = process.env;
    const main = mainAdminEmail();
    const mainUser = main && db.prepare('SELECT * FROM users WHERE email = ?').get(main);
    const state = (ok, text) => html`${ok ? badge('active', 'מוגדר') : badge('blocked', 'חסר')} ${text || ''}`;
    // Only the variables that are really missing (the page used to name both of a pair when either was).
    const missing = (...names) => names.filter((n) => !provision.clean(e[n])).join(', ');
    const result = (k) => (checks ? html`<br>${checks[k].ok ? badge('active', 'נבדק') : badge('blocked', 'נכשל')} <small>${checks[k].detail}</small>` : '');
    const smtp = master.sharedMailVars();
    return html`
${pageHead('הגדרות', { iconName: 'settings', sub: 'החיבורים שבהם נוצרים אתרי הלקוחות, המיילים של מרכז הניהול וההתחברות אליו.' })}
${pageTabs(SETTINGS_TABS, 'חלקי ההגדרות', tab)}
<div class="tab-panels">
<div class="tab-panel" id="connections" role="tabpanel" ${tab === 'connections' ? '' : raw('hidden')}>
  <section class="card" id="services">
    <h2 class="section-title">${icon('wrench')} השירותים שבהם נוצרים האתרים</h2>
    <dl class="dl">
      <dt>Turso (מסדי נתונים)</dt><dd>${state(p.turso, p.turso ? html`ארגון <code dir="ltr">${provision.clean(e.TURSO_ORG)}</code>` : html`חסר: <code dir="ltr">${missing('TURSO_API_TOKEN', 'TURSO_ORG')}</code>`)}${result('turso')}</dd>
      <dt>Vercel (אתרים)</dt><dd>${state(p.vercel, p.vercel ? (provision.clean(e.VERCEL_TEAM_ID) ? html`צוות <code dir="ltr">${provision.clean(e.VERCEL_TEAM_ID)}</code>` : 'חשבון אישי') : html`חסר: <code dir="ltr">${missing('VERCEL_TOKEN')}</code>`)}${result('vercel')}</dd>
      <dt>מאגר הקוד</dt><dd>${master.clientRepo() ? html`<code dir="ltr">${master.clientRepo()}</code>, ענף <code dir="ltr">${master.clientBranch()}</code>` : state(false, 'CLIENT_REPO')}</dd>
    </dl>
    ${postForm(req, '/master/settings/check', html`<button class="btn btn-light">${icon('check')} בדיקת החיבורים</button>`)}
  </section>
  <section class="card prose">
    <h2>הגדרת החיבורים</h2>
    <p>ב־Vercel ← הפרויקט של מרכז הניהול ← Settings ← Environment Variables (Production), ואחר כך Redeploy:</p>
    <ul>
      <li><code>TURSO_API_TOKEN</code> (Sensitive): ב־app.turso.tech ← Settings ← API Tokens ← Create.</li>
      <li><code>TURSO_ORG</code>: שם הארגון ב־Turso – החלק שאחרי שם מסד הנתונים בכתובת <span dir="ltr">libsql://&lt;db&gt;-&lt;org&gt;.&lt;region&gt;.turso.io</span>.</li>
      <li><code>VERCEL_TOKEN</code> (Sensitive): <a href="${VERCEL_TOKENS_URL}" target="_blank" rel="noopener">vercel.com/account/tokens</a> ← Create, עם הרשאה לצוות.</li>
      <li><code>VERCEL_TEAM_ID</code>: Vercel ← Team Settings ← General ← Team ID (מתחיל ב־<span dir="ltr">team_</span>).</li>
      <li><code>CLIENT_REPO</code> (לא חובה): מאגר הקוד של האתרים, למשל <span dir="ltr">yehonatan21/Car-Rental</span>. ברירת המחדל: המאגר של מרכז הניהול.</li>
    </ul>
    <p class="muted small">מפתח הניהול של כל לקוח נגזר מהסוד של מרכז הניהול (${provision.clean(e.MASTER_SECRET) ? 'MASTER_SECRET' : 'נוצר ונשמר במסד הנתונים של המרכז'}). אין לשנות אותו, אחרת המרכז יאבד את הגישה לאתרים.</p>
  </section>
</div>
<div class="tab-panel" id="mail" role="tabpanel" ${tab === 'mail' ? '' : raw('hidden')}>
  ${emailStatusCard(req, { action: '/master/settings/test-email', recipients: false })}
  <section class="card prose" id="mail-setup">
    <h2>מאיפה מגיעות הגדרות המייל</h2>
    <p>המיילים של מרכז הניהול (הזמנות למנהלי המרכז, קוד התחברות, איפוס סיסמה) נשלחים לפי משתני הסביבה של הפרויקט הזה ב־Vercel:
      <code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_USER</code>, <code>SMTP_PASS</code> (Sensitive), ולא חובה <code>MAIL_FROM_NAME</code> (שם השולח).
      אפשר להעתיק אותם כמו שהם מהפרויקט של האתר הקיים. אחרי שינוי: Redeploy.</p>
    <p>${smtp ? html`${badge('active', 'משותף')} בלקוח חדש אפשר לסמן "שליחת המיילים מתיבת הדואר של מרכז הניהול": האתר שלו יקבל את אותם משתנים,
      והמיילים יישלחו מ־<span dir="ltr">${smtp.MAIL_FROM}</span> בשם הלקוח.` : 'כשהמיילים יוגדרו כאן, אפשר יהיה לתת אותם גם ללקוחות חדשים.'}</p>
  </section>
</div>
<div class="tab-panel" id="signin" role="tabpanel" ${tab === 'signin' ? '' : raw('hidden')}>
  <section class="card" id="main-admin">
    <h2 class="section-title">${icon('shield')} המנהל/ת הראשי/ת</h2>
    ${main ? html`<dl class="dl">
      <dt>מתוך <code>ADMIN_EMAIL</code></dt><dd><span dir="ltr">${main}</span> ${mainUser ? badge('active', 'מנהל/ת פעיל/ה') : badge('pending', 'ייווצר בהפעלה הבאה')}</dd>
      <dt>התחברות</dt><dd>${mainUser?.password_hash ? 'סיסמה' : 'אין סיסמה'}${config.smtp ? ' · קוד חד־פעמי במייל' : ''}${mainUser?.google_sub || master.sharedGoogleVars() ? ' · Google' : ''}</dd>
    </dl>
    <p class="muted small">החשבון הזה תמיד נשאר מנהל/ת פעיל/ה במרכז, ואי אפשר להסיר אותו מכאן. <code>ADMIN_PASSWORD</code> אינו חובה:
      בלעדיו מתחברים עם קוד שנשלח למייל, עם Google, או בוחרים סיסמה ב"שכחתי סיסמה" (כל אלה דורשים שהמיילים יהיו מוגדרים).</p>`
    : html`<p>${badge('blocked', 'חסר')} לא הוגדר <code>ADMIN_EMAIL</code>. הוסיפו אותו (עם המייל שלכם) במשתני הסביבה של הפרויקט ב־Vercel, ואז Redeploy.</p>`}
    ${config.master ? html`<p><a class="btn btn-light btn-sm" href="/master/admins">${icon('users', 16)} כל מנהלי המרכז</a></p>` : ''}
  </section>
  ${googleStatusCard(req)}
</div>
</div>`;
  }

  app.get('/master/settings', requireAdmin, (req, res) => res.page('הגדרות', settingsPage(req)));
  app.post('/master/settings/check', requireAdmin, async (req, res) => res.page('הגדרות', settingsPage(req, await master.checkConnections())));
  app.post('/master/settings/test-email', requireAdmin, async (req, res) => {
    const ok = await mail.test(req.user.email);
    if (!ok) res.flash('error', 'שליחת מייל הבדיקה נכשלה. פרטי השגיאה מופיעים למטה.');
    else if (config.smtp) res.flash('success', `מייל בדיקה נשלח אל ${req.user.email}. אם לא הגיע תוך דקה, בדקו בספאם.`);
    else res.flash('warning', 'המייל לא נשלח: למרכז הניהול לא הוגדר שרת דואר (SMTP_HOST וכו׳). ההוראות מופיעות למטה.');
    res.redirect(303, '/master/settings?tab=mail');
  });
};
