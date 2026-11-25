'use strict';
// Alerts by e-mail: on each scheduled run the console looks at what the monitoring page shows (each site, the Turso
// and Vercel accounts, the shared mailbox) and e-mails its admins when something goes wrong, gets worse, or is fixed.
// A problem that stays open is repeated once a day, so a missed e-mail is not the end of it. ALERT_EMAIL sends them
// elsewhere (comma-separated addresses) or turns them off ("off").
const { db } = require('./db');
const master = require('./master');
const monitoring = require('./monitoring');
const time = require('./time');

const REMIND_MS = 24 * 3600000;
const pct = (m) => `${m.pct}%`;

/** Who gets the alerts: ALERT_EMAIL, or the console's active admins. [] when switched off. */
function recipients() {
  const v = String(process.env.ALERT_EMAIL || '').trim();
  if (v.toLowerCase() === 'off') return [];
  if (v) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return db.prepare("SELECT email FROM users WHERE role = 'admin' AND status = 'active'").all().map((r) => r.email);
}

/**
 * The problems in a monitoring snapshot: [{ key, level: 'warn'|'bad', text }]. Only what needs someone to act; the
 * key names the problem (not its numbers), so the same problem is recognised from run to run.
 */
function problems({ clients, statuses, acc, own }) {
  const out = [];
  const add = (key, level, text) => out.push({ key, level, text });
  let mailToday = own?.mail?.today?.recipients || 0;
  // A new kind of server error (first seen in the last 24 hours): told once, not repeated or "fixed" (src/errors.js).
  // One marked as handled is left out, until it happens again after that: then told once more, as having come back.
  const since = time.stamp(new Date(Date.now() - 24 * 3600000));
  const handled = handledErrors();
  const newErrors = (slug, name, e) => {
    const what = (x) => `\u2066${x.name}: ${x.message}${x.route ? ` · ${x.route}` : ''}${x.frame ? ` · ${x.frame}` : ''}\u2069`;
    let n = 0;
    for (const x of e?.recent || []) {
      const state = errorState(handled, slug, x);
      if (n >= 3 || state === 'handled') continue;
      if (state === 'again') { add(`error:${slug}:${x.fp}:again:${handled.get(`${slug}:${x.fp}`)}`, 'warn', `${name}: שגיאת שרת חזרה אחרי שסומנה כטופלה: ${what(x)}`); n++; }
      else if (x.first_at >= since) { add(`error:${slug}:${x.fp}`, 'warn', `${name}: שגיאת שרת חדשה${x.count > 1 ? ` (${x.count} פעמים)` : ''}: ${what(x)}`); n++; }
    }
  };
  statuses.forEach((st, i) => {
    const c = clients[i];
    const name = c.name || c.slug;
    if (!st.online) return add(`site:${c.slug}:online`, 'bad', `${name}: האתר לא עונה${st.error ? ` – ${String(st.error).replace(/\.$/, '')}` : ''}.`);
    const m = st.data?.metrics;
    mailToday += m?.mail?.today?.recipients || 0;
    for (const ch of monitoring.siteChecks(st, st.ms)) {
      if (ch.level === 'ok') continue;
      if (ch.key === 'jobs') add(`site:${c.slug}:jobs`, ch.level, `${name}: המשימות המתוזמנות לא רצו ${ch.text === 'אף פעם' ? 'אף פעם' : `כבר ${ch.text}`} (תזכורות ומיילים יוצאים באיחור).`);
      if (ch.key === 'key') add(`site:${c.slug}:key`, ch.level, `${name}: מפתח מסד הנתונים ${ch.text === 'ללא תפוגה' ? 'ללא תאריך תפוגה' : /^-/.test(ch.text) ? 'פג' : `יפוג בעוד ${ch.text}`}. מחליפים בדף הלקוח ← "החלפת מפתח".`);
      if (ch.key === 'response' && ch.level === 'bad') add(`site:${c.slug}:slow`, 'warn', `${name}: האתר עונה לאט (${ch.text}).`);
    }
    if (m?.mail?.failed) add(`site:${c.slug}:mail`, 'warn', `${name}: ${m.mail.failed} מיילים נכשלו סופית ולא יישלחו.`);
    newErrors(c.slug, name, m?.errors);
  });
  newErrors('console', 'מרכז הניהול', own?.errors);

  const t = acc.turso;
  if (t.ok) {
    const d = t.data;
    if (d.blocked.reads || d.blocked.writes) add('turso:blocked', 'bad', `Turso חסם ${d.blocked.writes ? 'כתיבה' : 'קריאה'} בחשבון: האתרים לא יכולים לשמור נתונים.`);
    if (d.paymentFailing) add('turso:payment', 'bad', 'Turso: התשלום נכשל. עדכנו אמצעי תשלום.');
    if (d.unpaidInvoices) add('turso:invoices', 'warn', `Turso: ${d.unpaidInvoices} חשבוניות לא שולמו.`);
    const names = { rowsRead: 'שורות שנקראו החודש', rowsWritten: 'שורות שנכתבו החודש', storage: 'אחסון', databases: 'מסדי נתונים' };
    for (const [k, label] of Object.entries(names)) {
      const m = d.meters[k];
      if (m.level !== 'ok') add(`turso:${k}`, m.level, `Turso: ${label} ב־${pct(m)} מהמגבלה של תוכנית ${d.plan}.`);
    }
  } else if (t.error !== 'not_configured') add('turso:api', 'warn', `לא ניתן לקרוא את חשבון Turso: ${t.error}`);

  const v = acc.vercel;
  if (v.ok) {
    const d = v.data;
    if (d.blocked) add('vercel:blocked', 'bad', `Vercel חסם את החשבון${d.blockReason ? ` (${d.blockReason})` : ''}: האתרים לא זמינים.`);
    const names = { requests: 'בקשות החודש', invocations: 'הפעלות שרת', bandwidth: 'תעבורה יוצאת', gbHours: 'זמן שרת' };
    for (const [k, label] of Object.entries(names)) {
      const m = d.meters[k];
      if (m.level !== 'ok') add(`vercel:${k}`, m.level, `Vercel: ${label} ב־${pct(m)} מהמגבלה של תוכנית ${d.plan}.`);
    }
    if (d.errorRate >= 5 && d.errors >= 20) add('vercel:errors', 'warn', `Vercel: ${d.errorRate}% מהפעלות השרת החודש נכשלו (${d.errors}).`);
  } else if (v.error !== 'not_configured') add('vercel:api', 'warn', `לא ניתן לקרוא את חשבון Vercel: ${v.error}`);

  const mail = monitoring.meter(mailToday, monitoring.mailDailyLimit());
  if (mail.level !== 'ok') add('mail:daily', mail.level, `המייל המשותף: ${mailToday} נמענים היום, ${pct(mail)} מהמגבלה היומית (${mail.limit}).`);
  return out;
}

/** The errors marked as handled: "site:fp" → when. */
const handledErrors = () => new Map(db.prepare('SELECT site, fp, handled_at FROM error_handled').all().map((r) => [`${r.site}:${r.fp}`, r.handled_at]));
/** 'open', 'handled' (marked, and not seen since), or 'again' (seen after it was marked). */
function errorState(handled, site, e) {
  const at = handled.get(`${site}:${e.fp}`);
  return !at ? 'open' : e.last_at > at ? 'again' : 'handled';
}
/** Marks error kinds as handled ([{ site, fp }]); their open alerts are dropped quietly. */
function markHandled(list, userId) {
  const stamp = time.stamp();
  const put = db.prepare(`INSERT INTO error_handled (site, fp, handled_at, handled_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(site, fp) DO UPDATE SET handled_at = excluded.handled_at, handled_by = excluded.handled_by`);
  for (const { site, fp } of list) {
    put.run(site, fp, stamp, userId ?? null);
    db.prepare("DELETE FROM alerts WHERE key = ? OR key LIKE ?").run(`error:${site}:${fp}`, `error:${site}:${fp}:again:%`);
  }
  return list.length;
}

/** What to tell, given the problems now and the alerts open from before. Pure: the tests drive it directly. */
const once = (key) => key.startsWith('error:');
function diff(now, open, at = Date.now()) {
  const before = new Map(open.map((a) => [a.key, a]));
  const found = new Set(now.map((p) => p.key));
  const fresh = []; const worse = []; const still = [];
  for (const p of now) {
    const o = before.get(p.key);
    if (!o) fresh.push(p);
    else if (p.level === 'bad' && o.level === 'warn') worse.push(p);
    else if (at - o.sent_at >= REMIND_MS && !once(p.key)) still.push(p);
  }
  // A new error kind is news once; when it leaves the 24-hour window it is forgotten quietly (it was not "fixed").
  const fixed = open.filter((a) => !found.has(a.key) && !once(a.key));
  const gone = open.filter((a) => !found.has(a.key) && once(a.key));
  return { fresh, worse, still, fixed, gone };
}

/** The alerts open now, for the monitoring page. */
const open = () => db.prepare('SELECT * FROM alerts ORDER BY level DESC, since').all();

/**
 * One snapshot of everything the monitoring page shows (the page and the alerts read the same). `live`: every site is
 * asked now, never a status the client list saw a few seconds ago (the alerts, and the page's "refresh").
 */
async function snapshot({ fresh = false, live = fresh } = {}) {
  const clients = master.list();
  const statuses = await master.statusAll(clients, live ? { maxAgeMs: 0 } : {});
  const ownDb = master.databaseName({}, require('./db').storageInfo().host);
  const dbNames = statuses.map((st, i) => master.databaseName(clients[i], (st.online ? st.data : st.last)?.storage?.host)).concat(ownDb);
  const acc = await monitoring.accounts({ fresh, databases: dbNames });
  let own = null;
  try { own = require('./routes/manage').metrics(); } catch { /* the console's own numbers are optional */ }
  return { clients, statuses, acc, own, ownDb };
}

/**
 * Checks and, when there is news, sends one e-mail. Several runs at once (GitHub's schedule and Vercel's cron) are
 * kept apart by claiming the run in job_state; at most one check every 5 minutes. Returns what it did.
 */
async function run({ snap, send = require('./mail').send } = {}) {
  const now = Date.now();
  const last = db.prepare("SELECT value FROM job_state WHERE key = 'alerts_at'").get()?.value;
  if (last && now - Number(last) < 5 * 60000) return { skipped: 'recent' };
  const claimed = last
    ? db.prepare("UPDATE job_state SET value = ? WHERE key = 'alerts_at' AND value = ?").run(String(now), last).changes
    : db.prepare("INSERT INTO job_state (key, value) VALUES ('alerts_at', ?) ON CONFLICT(key) DO NOTHING").run(String(now)).changes;
  if (!claimed) return { skipped: 'running' };

  const list = problems(snap || await snapshot({ live: true }));
  const d = diff(list, open(), now);
  const to = recipients();
  const news = d.fresh.length + d.worse.length + d.still.length + d.fixed.length;
  let sent = false;
  if (news && to.length) {
    const li = (items) => items.map((p) => `<br>${p.level === 'bad' ? '🔴' : '🟠'} ${escape(p.text)}`).join('');
    const parts = [];
    if (d.fresh.length || d.worse.length) parts.push(`<b>בעיות חדשות${d.worse.length ? ' או שהחמירו' : ''}:</b>${li([...d.worse, ...d.fresh])}`);
    if (d.still.length) parts.push(`<b>עדיין פתוח:</b>${li(d.still)}`);
    if (d.fixed.length) parts.push(`<b>נפתר:</b>${d.fixed.map((a) => `<br>✅ ${escape(a.text)}`).join('')}`);
    const bad = list.filter((p) => p.level === 'bad').length;
    const subject = !list.length ? 'מרכז הניהול: כל הבעיות נפתרו'
      : bad === list.length ? `מרכז הניהול: ${bad === 1 ? 'בעיה דחופה אחת' : `${bad} בעיות דחופות`}`
        : `מרכז הניהול: ${list.length === 1 ? 'בעיה אחת' : `${list.length} בעיות`}${bad ? ` (${bad === 1 ? 'אחת דחופה' : `${bad} דחופות`})` : ''}`;
    sent = await send(to, subject, [...parts, '<small>נשלח ממרכז הניהול. ההתראות נשלחות כשמשהו משתנה, ותזכורת פעם ביום כל עוד הבעיה פתוחה.</small>'],
      { href: '/master/metrics', label: 'לדף הניטור' }, { retry: false }); // not queued: the next run says it again, up to date
  }
  // Remember what was said only when it was said (or when nobody is to be told), so a failed e-mail is tried again.
  if (sent || !to.length) {
    const stamp = time.stamp();
    const upsert = db.prepare(`INSERT INTO alerts (key, level, text, since, sent_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET level = excluded.level, text = excluded.text, sent_at = excluded.sent_at`);
    for (const p of [...d.fresh, ...d.worse, ...d.still]) upsert.run(p.key, p.level, p.text, stamp, now);
    for (const a of d.fixed) db.prepare('DELETE FROM alerts WHERE key = ?').run(a.key);
  }
  for (const a of d.gone) db.prepare('DELETE FROM alerts WHERE key = ?').run(a.key);
  const keep = db.prepare('UPDATE alerts SET text = ? WHERE key = ?'); // the numbers move; the page shows the latest
  for (const p of list) keep.run(p.text, p.key);
  if (news) console.log(`[alerts] ${list.length} open; new ${d.fresh.length}, worse ${d.worse.length}, reminded ${d.still.length}, fixed ${d.fixed.length}; ${sent ? 'e-mailed' : to.length ? 'e-mail failed' : 'nobody to tell'}`);
  return { open: list.length, fresh: d.fresh.length, worse: d.worse.length, still: d.still.length, fixed: d.fixed.length, sent, to: to.length };
}

const escape = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

module.exports = { run, problems, diff, open, recipients, snapshot, handledErrors, errorState, markHandled };
