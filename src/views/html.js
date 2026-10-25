'use strict';
// Tagged-template HTML with automatic escaping. Interpolated values are escaped unless wrapped in raw(),
// arrays are joined, and null/undefined/false render as nothing.
const config = require('../config');

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(String(s));

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return escape(v);
}

function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Raw(out);
}

/** Tiny Markdown subset for the policy page: #/##/### headings, lists, > quotes, **bold**, paragraphs. */
function markdown(src) {
  const inline = (t) => escape(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const out = [];
  let list = null, para = [];
  const flush = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
    if (list) { out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`); list = null; }
  };
  for (const line of String(src).split(/\r?\n/)) {
    const t = line.trim();
    let m;
    if (!t) flush();
    else if ((m = t.match(/^(#{1,3})\s+(.*)$/))) { flush(); const n = m[1].length + 1; out.push(`<h${n}>${inline(m[2])}</h${n}>`); }
    else if ((m = t.match(/^[-*]\s+(.*)$/))) { if (para.length) flush(); (list ||= []).push(m[1]); }
    else if ((m = t.match(/^>\s?(.*)$/))) { flush(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); }
    else { if (list) flush(); para.push(t); }
  }
  flush();
  return raw(out.join('\n'));
}

const USER_STATUS = {
  pending: 'ממתין לאישור',
  active: 'פעיל',
  license_update: 'ממתין לעדכון רישיון',
  blocked: 'חסום',
  rejected: 'נדחה',
};

const VEHICLE_STATUS = { available: 'זמין', service: 'בטיפול', disabled: 'מושבת' };

const badge = (kind, label) => html`<span class="badge badge-${kind}">${label}</span>`;

// Inline stroke icons (24-px grid, drawn with currentColor). Decorative: aria-hidden.
const ICON_PATHS = {
  car: '<path d="M5 17h14v-5l-2-5H7l-2 5v5z"/><path d="M5 12h14"/><circle cx="8" cy="17" r="2"/><circle cx="16" cy="17" r="2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.5 2.4 3.5 5.2"/>',
  dashboard: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"/>',
  logout: '<path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
  login: '<path d="M9 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3"/><path d="M14 8l4 4-4 4M18 12H8"/>',
  userplus: '<circle cx="10" cy="8" r="4"/><path d="M3 21c0-4 3.5-6 7-6 1.5 0 3 .4 4.2 1"/><path d="M19 15v6M16 18h6"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.5"/>',
  id: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.2"/><path d="M5.5 16c.6-1.6 2-2.4 3.5-2.4s2.9.8 3.5 2.4M14.5 10h4M14.5 13.5h3"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  wrench: '<path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3z"/><path d="M14.5 6.5l3-3a4 4 0 0 0-5 5"/>',
  arrow: '<path d="M15 6l-6 6 6 6"/>',
};
const icon = (name, size = 20) => raw(`<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`);

/** Navigation: [href, label, icon]; the first ones also form the phone tab bar. */
function navLinks(user) {
  if (!user) return [['/login', 'התחברות', 'login'], ['/register', 'הרשמה', 'userplus'], ['/policy', 'נהלי השאלה', 'file']];
  if (user.role === 'admin') {
    return [['/admin', 'לוח בקרה', 'dashboard'], ['/admin/bookings', 'הזמנות', 'list'], ['/calendar', 'יומן', 'calendar'],
      ['/admin/users', 'משתמשים', 'users'], ['/admin/vehicle', 'רכב', 'car'], ['/admin/policies', 'נהלים', 'file'],
      ['/admin/settings', 'הגדרות', 'settings'], ['/me', 'אזור אישי', 'user']];
  }
  return [['/calendar', 'יומן הרכב', 'calendar'], ['/bookings/new', 'הזמנה חדשה', 'plus'], ['/me/bookings', 'ההזמנות שלי', 'list'],
    ['/me', 'אזור אישי', 'user'], ['/policy', 'נהלים', 'file']];
}

/** Is this nav link the current section? (exact page, or a sub-page of an admin section) */
function isCurrent(req, href) {
  if (req.path === href) return true;
  return href !== '/admin' && href.startsWith('/admin/') && req.path.startsWith(href + '/');
}

function layout(req, title, body) {
  const user = req.user;
  const links = navLinks(user);
  const flash = req.flash;
  const link = ([href, label, ic]) => html`<a href="${href}" ${isCurrent(req, href) ? raw('aria-current="page"') : ''}>${icon(ic)}<span>${label}</span></a>`;
  const logout = user ? html`<form method="post" action="/logout">${csrfField(req)}<button class="linklike">${icon('logout')}<span>יציאה</span></button></form>` : '';
  const tabs = links.slice(0, 4);
  const rest = links.slice(4);
  return html`<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b7a63">
<title>${title} · ${config.appName}</title>
<link rel="preload" href="/static/fonts/rubik-hebrew-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/style.css">
</head>
<body class="${user ? 'signed-in' : 'signed-out'}">
<a class="skip" href="#main">דילוג לתוכן</a>
<header class="topbar">
  <a class="brand" href="/"><span class="brand-mark">${icon('car', 22)}</span><span>${config.appName}</span></a>
  <nav class="nav-desktop" aria-label="ניווט ראשי">
    ${links.map(link)}
  </nav>
  ${user ? html`<div class="user-chip" title="${user.email}"><span class="avatar" aria-hidden="true">${(user.first_name || '?').slice(0, 1)}</span>
    <span class="who"><b>${user.first_name} ${user.last_name}</b><small>${user.role === 'admin' ? 'מנהל/ת' : 'משתמש/ת'}</small></span></div>` : ''}
  <div class="desktop-logout">${logout}</div>
  <details class="menu">
    <summary aria-label="תפריט">${icon('more', 24)}</summary>
    <nav aria-label="תפריט נוסף">${(user ? rest : links).map(link)}${logout}</nav>
  </details>
</header>
${config.ephemeral ? html`<div class="demo-banner" role="note">סביבת הדגמה: הנתונים (משתמשים, הזמנות וקבצים) זמניים ונמחקים מעת לעת.</div>` : ''}
<main class="container" id="main">
  ${flash ? html`<div class="flash flash-${flash.type}" role="status">${flash.text}</div>` : ''}
  ${body}
</main>
${user ? html`<nav class="tabbar" aria-label="ניווט מהיר">${tabs.map(link)}</nav>` : ''}
<script src="/static/app.js" defer></script>
${config.vercelAnalytics ? raw('<script defer src="/_vercel/insights/script.js"></script>') : ''}
</body>
</html>`.toString();
}

/** Page title row: heading, optional subtitle and actions. */
const pageHead = (title, { sub, actions, iconName } = {}) => html`
<div class="page-head">
  <div class="page-title">${iconName ? html`<span class="title-icon">${icon(iconName, 22)}</span>` : ''}<div><h1>${title}</h1>${sub ? html`<p class="muted">${sub}</p>` : ''}</div></div>
  ${actions ? html`<div class="page-actions">${actions}</div>` : ''}
</div>`;

const csrfField = (req) => req.session ? html`<input type="hidden" name="_csrf" value="${req.session.csrf}">` : '';

/** A POST form with the CSRF token already included. */
const postForm = (req, action, inner, attrs = '') =>
  html`<form method="post" action="${action}" ${raw(attrs)}>${csrfField(req)}${inner}</form>`;

/** Inline single-button POST form, optionally asking for confirmation. */
const actionButton = (req, action, label, { cls = '', confirm, note } = {}) => postForm(req, action, html`
  ${note ? html`<input name="note" placeholder="הערה (אופציונלי)" class="inline-note">` : ''}
  <button class="btn ${cls}" ${confirm ? html`data-confirm="${confirm}"` : ''}>${label}</button>`, 'class="inline"');

function field(label, input, hint) {
  return html`<label class="field"><span>${label}</span>${input}${hint ? html`<small>${hint}</small>` : ''}</label>`;
}

module.exports = {
  html, raw, escape, markdown, layout, csrfField, postForm, actionButton, field, badge, icon, pageHead, USER_STATUS, VEHICLE_STATUS,
};
