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

module.exports = (req, res) => {
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
