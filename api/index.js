'use strict';
// Vercel serverless entry point: every request is routed here (see vercel.json) and handled by the Express app.
// Background jobs (reminders, closing finished bookings) do not run on Vercel; see docs/vercel.md.
//
// If the app cannot start (most often: the hosted database URL or token is wrong, or the database is gone),
// a plain require() would throw on every request and Vercel would only show "500 FUNCTION_INVOCATION_FAILED".
// Instead the error is logged and explained on a 503 page, and the next request tries to start again
// (a module that throws while loading is not cached, so a passing network problem heals by itself).

let app;

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The error message without anything that looks like a credential (JWT tokens, user:password@ in URLs). */
const redact = (msg) => String(msg)
  .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]')
  .replace(/\/\/[^/@\s]+@/g, '//[credentials]@')
  .slice(0, 400);

function hint(err) {
  const msg = String(err && err.message);
  if (/^No database is connected/.test(msg)) {
    return {
      he: 'לא מחובר מסד נתונים לפריסה הזו, ולכן כל הנתונים היו נמחקים בכל גרסה חדשה. ב־Vercel ← Storage ← Turso: חברו את מסד הנתונים '
        + 'לפרויקט וסמנו את הסביבה הזו (Production / Preview), או הוסיפו ב־Settings ← Environment Variables את TURSO_DATABASE_URL ו־TURSO_AUTH_TOKEN. '
        + 'אחר כך Redeploy.',
      en: 'No database is connected to this deployment, so all data would be lost on every new version. In Vercel → Storage → '
        + 'Turso connect the database to this project for this environment, or add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, then redeploy.',
    };
  }
  const variable = /^(BASE_URL|TURSO_DATABASE_URL|LIBSQL_URL) is not a valid address/.exec(msg)?.[1];
  if (variable) {
    return {
      he: `הערך של ${variable} אינו כתובת תקינה. ב־Vercel ← Settings ← Environment Variables יש לתקן אותו לכתובת המלאה `
        + `(למשל ${variable === 'BASE_URL' ? 'https://car-rental.vercel.app' : 'libsql://car-rental-<org>.turso.io'}, בלי מרכאות), או למחוק אותו, ואז Redeploy.`,
      en: `${variable} is not a valid address. In Vercel → Settings → Environment Variables fix it to the full address `
        + '(no quotes) or delete it, then redeploy.',
    };
  }
  if (/Hrana|libsql|sqld|turso|dns error|tcp connect|401|403|Unauthorized|token/i.test(msg)) {
    return {
      he: 'לא ניתן להתחבר למסד הנתונים (Turso). בדקו ב־Vercel ← Settings ← Environment Variables את TURSO_DATABASE_URL ו־TURSO_AUTH_TOKEN '
        + '(בלי רווחים מיותרים, וששניהם שייכים לאותו מסד נתונים שעדיין קיים ב־Turso), ואז Redeploy.',
      en: 'Cannot connect to the database (Turso). In Vercel → Settings → Environment Variables check TURSO_DATABASE_URL and '
        + 'TURSO_AUTH_TOKEN (no extra spaces, both for the same database, which must still exist in Turso), then redeploy.',
    };
  }
  return {
    he: 'השרת לא הצליח לעלות. בדקו את משתני הסביבה שהוגדרו לאחרונה ב־Vercel, ואת ה־Logs של הפריסה.',
    en: 'The server failed to start. Check the environment variables changed most recently in Vercel, and the deployment logs.',
  };
}

function startupFailed(res, err) {
  const h = hint(err);
  res.statusCode = 503;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Retry-After', '30');
  res.end(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>השירות אינו זמין</title>
<style>body{margin:0;font-family:system-ui,Arial,sans-serif;background:#f3f6f5;color:#10201b}
main{max-width:640px;margin:10vh auto;padding:24px;background:#fff;border:1px solid #dde5e1;border-radius:14px}
h1{margin-top:0;font-size:1.4rem}code{display:block;direction:ltr;text-align:left;white-space:pre-wrap;background:#f7faf9;
border:1px solid #dde5e1;border-radius:8px;padding:10px;font-size:.85rem}.en{direction:ltr;text-align:left;color:#55655e}</style>
</head><body><main><h1>השירות אינו זמין כרגע</h1><p>${escape(h.he)}</p><p class="en">${escape(h.en)}</p>
<code>${escape(redact(err && err.message))}</code></main></body></html>`);
}

/**
 * Vercel's Node.js runtime adds its own helpers to every request before the app sees it: res.redirect, res.status,
 * res.send, res.json, and lazy req.body, req.query, req.cookies. They are own properties, so they hide Express's
 * methods of the same name, and Vercel's res.redirect(url) answers 307, not 302. A 307 after a form makes the browser
 * send the same form again to the new address: on the live site every form (test e-mail, manual booking, vehicle,
 * "add user") bounced between POSTs until the browser gave up. Removing the helpers lets Express handle everything
 * exactly as it does locally and in the tests.
 */
function withoutVercelHelpers(req, res) {
  for (const k of ['body', 'query', 'cookies']) if (Object.hasOwn(req, k)) delete req[k];
  for (const k of ['redirect', 'status', 'send', 'json']) if (Object.hasOwn(res, k)) delete res[k];
}

module.exports = (req, res) => {
  withoutVercelHelpers(req, res);
  if (!app) {
    try {
      app = require('../src/server').app;
    } catch (err) {
      console.error('[startup] The app failed to start:', err);
      return startupFailed(res, err);
    }
  }
  return app(req, res);
};

module.exports.withoutVercelHelpers = withoutVercelHelpers;
