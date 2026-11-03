'use strict';
// Breaks redirect loops. Every redirect is counted in a short-lived cookie together with the last few addresses;
// a real page resets it. If a browser is sent on more than MAX redirects in a row (browsers give up at about 20 with
// ERR_TOO_MANY_REDIRECTS), the app stops redirecting, shows a page with a link home, and logs the chain, so the cause
// can be seen in the hosting logs.
const COOKIE = 'rloop';
const MAX = 8;
const WINDOW_MS = 15000;

function read(req) {
  try {
    const v = JSON.parse(Buffer.from(req.cookies?.[COOKIE] || '', 'base64url').toString() || 'null');
    return v && Date.now() - v.t < WINDOW_MS ? v : null;
  } catch {
    return null;
  }
}

function guard(req, res, next) {
  const redirect = res.redirect.bind(res);
  res.redirect = (...args) => {
    // After a form (POST), always 303 "see other": the browser then opens the page with GET. A 307/308 would make it
    // send the form again to the new address.
    if (typeof args[0] !== 'number' && req.method !== 'GET' && req.method !== 'HEAD') args = [303, args[0]];
    const to = typeof args[0] === 'number' ? args[1] : args[0];
    const prev = read(req);
    // Without the query, so the cookie and the log never carry tokens; with whether this request was signed in.
    const chain = [...(prev?.chain || []), `${req.method} ${req.path.slice(0, 80)} [${req.sessionState || '-'}]`].slice(-6);
    const n = (prev?.n || 0) + 1;
    const cookie = { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: WINDOW_MS };
    if (n > MAX) {
      const target = String(to).split('?')[0];
      console.warn(`[redirect-loop] stopped after ${n - 1} redirects; signed in: ${Boolean(req.user)}, session cookie: `
        + `${Boolean(req.cookies?.sid)}; last: ${chain.join(' → ')} → ${target}`);
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      res.clearCookie(COOKIE, { path: '/', secure: req.secure });
      return res.status(508).type('html').send(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>הדף לא נטען</title></head>
<body style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:12vh auto;padding:0 16px;line-height:1.6">
<h1>הדף לא נטען</h1><p>הדפדפן הופנה שוב ושוב בין דפים. הפרטים נרשמו ביומן השרת.</p>
<p><a href="/">לדף הראשי</a> · <a href="/login">להתחברות מחדש</a></p>
<details><summary>פרטים טכניים</summary><pre dir="ltr" style="white-space:pre-wrap;font-size:13px">${esc(`${chain.join('\n')}\n→ ${target}`)}</pre></details>
</body></html>`);
    }
    res.cookie(COOKIE, Buffer.from(JSON.stringify({ n, t: Date.now(), chain })).toString('base64url'), cookie);
    // A redirect is never stored, by the browser or by Vercel: a reused old one could send the browser in circles.
    res.set('Cache-Control', 'no-store');
    return redirect(...args);
  };
  next();
}

/** A real page was shown: the redirect chain is over. */
function reset(req, res) {
  if (req.cookies?.[COOKIE]) res.clearCookie(COOKIE, { path: '/', secure: req.secure });
}

module.exports = { guard, reset, MAX, COOKIE };
