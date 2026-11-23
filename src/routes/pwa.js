'use strict';
// The site as an installable app (PWA): the manifest (name, colours, icons), the icons in the site's own colour, a
// service worker, and the page shown when there is no connection.
//
// The service worker keeps only what is the same for everyone: the stylesheet, the script, the font, the icons and the
// "no connection" page. Pages are never stored on the phone (they hold personal data and must be current), so it
// only steps in when the network fails, with the "no connection" page.
const crypto = require('node:crypto');
const config = require('../config');
const { brand } = require('../brand');
const icons = require('../icons');
const { asset, escape } = require('../views/html');

const FONT = '/static/fonts/rubik-hebrew-wght-normal.woff2';
const colorTag = () => brand().color.replace('#', '');
const iconUrl = (kind, size) => `/icons/${kind}-${size}.png?v=${colorTag()}`;

/** <head> tags for the installed app (manifest, iPhone home screen). */
function headTags() {
  const b = brand();
  return `<link rel="manifest" href="/manifest.webmanifest?v=${colorTag()}">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${escape(shortName(b.name))}">
<meta name="apple-mobile-web-app-status-bar-style" content="default">`;
}

// Home screens show about 12 characters under the icon.
const shortName = (name) => (name.length <= 12 ? name : name.split(/\s+/).reduce((s, w) => ((`${s} ${w}`).trim().length <= 12 ? `${s} ${w}`.trim() : s), '') || name.slice(0, 12));

function manifest() {
  const b = brand();
  return {
    id: '/',
    name: b.name,
    short_name: shortName(b.name),
    description: config.master ? 'מרכז הניהול של אתרי הזמנת הרכב' : `הזמנת הרכב המשותף של ${b.name}`,
    lang: 'he',
    dir: 'rtl',
    start_url: config.master ? '/master' : '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f3f6f5',
    theme_color: b.color,
    icons: [
      { src: iconUrl('any', 192), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: iconUrl('any', 512), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: iconUrl('maskable', 192), sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: iconUrl('maskable', 512), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    ...(config.master ? {} : {
      shortcuts: [
        { name: 'הזמנה חדשה', url: '/bookings/new', icons: [{ src: iconUrl('any', 192), sizes: '192x192', type: 'image/png' }] },
        { name: 'ההזמנות שלי', url: '/me', icons: [{ src: iconUrl('any', 192), sizes: '192x192', type: 'image/png' }] },
      ],
    }),
  };
}

/** What the service worker keeps: the same for everyone, versioned by the files' contents and the site's colour. */
function precache() {
  return ['/offline', asset('style.css'), asset('app.js'), FONT, iconUrl('any', 192)];
}

function serviceWorker() {
  const files = precache();
  const version = crypto.createHash('sha1').update(files.join('|')).digest('hex').slice(0, 10);
  return `'use strict';
// The site's service worker (src/routes/pwa.js). Keeps only the shared files; pages always come from the network,
// and the "no connection" page stands in for one when there is none.
const CACHE = 'car-rental-${version}';
const FILES = ${JSON.stringify(files)};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { credentials: 'omit' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('car-rental-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline')));
    return;
  }
  // Versioned shared files (?v=…) never change: from the phone first.
  if ((url.pathname.startsWith('/static/') || url.pathname.startsWith('/icons/')) && (url.searchParams.has('v') || url.pathname === ${JSON.stringify(FONT)})) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});

// Phone notifications (src/push.js): show them, and open the page they point to when tapped.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || ${JSON.stringify(brand().name)}, {
    body: d.body || '', tag: d.tag, renotify: Boolean(d.tag), dir: 'rtl', lang: 'he',
    icon: ${JSON.stringify(iconUrl('any', 192))}, badge: ${JSON.stringify(iconUrl('any', 192))},
    data: { url: typeof d.url === 'string' && d.url.startsWith('/') ? d.url : '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const same = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (same) return same.navigate(url).then((w) => (w || same).focus()).catch(() => self.clients.openWindow(url));
    return self.clients.openWindow(url);
  }));
});
`;
}

function offlinePage() {
  const b = brand();
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${escape(b.color)}">
<title>אין חיבור לאינטרנט · ${escape(b.name)}</title>
<link rel="stylesheet" href="${asset('style.css')}">
</head>
<body class="signed-out">
<main class="container offline-page" id="main">
  <section class="card">
    <img src="${iconUrl('any', 192)}" alt="" width="72" height="72">
    <h1>אין חיבור לאינטרנט</h1>
    <p>לא ניתן להגיע ל${escape(b.name)} כרגע. בדקו את החיבור ונסו שוב.</p>
    <p class="muted small">ההזמנות שלכם שמורות באתר, וההזמנה הבאה תופיע ברגע שהחיבור יחזור.</p>
    <p><a class="btn btn-primary" href="/">ניסיון חוזר</a></p>
  </section>
</main>
</body>
</html>`;
}

module.exports = function pwaRoutes(app) {
  app.get('/manifest.webmanifest', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').type('application/manifest+json').send(JSON.stringify(manifest()));
  });
  app.get('/icons/:kind-:size.png', (req, res) => {
    const png = icons.icon(req.params.kind, Number(req.params.size), brand().color);
    if (!png) return res.status(404).type('text/plain').send('Not found');
    res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=86400').type('image/png').send(png);
  });
  // At the site's root, so it may look after every page; always checked for a newer version.
  app.get('/sw.js', (req, res) => {
    res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }).type('application/javascript').send(serviceWorker());
  });
  // The same for everyone (no user, no personal data), so the service worker may keep it.
  app.get('/offline', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').type('html').send(offlinePage());
  });
};
module.exports.headTags = headTags;
module.exports.manifest = manifest;
