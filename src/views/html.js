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

function navLinks(user) {
  if (!user) return [['/login', 'התחברות'], ['/register', 'הרשמה'], ['/policy', 'נהלי השאלה']];
  if (user.role === 'admin') {
    return [['/admin', 'לוח בקרה'], ['/admin/bookings', 'הזמנות'], ['/admin/users', 'משתמשים'], ['/calendar', 'יומן'],
      ['/admin/vehicle', 'רכב'], ['/admin/policies', 'נהלים'], ['/admin/settings', 'הגדרות'], ['/me', 'אזור אישי']];
  }
  return [['/calendar', 'יומן הרכב'], ['/bookings/new', 'הזמנה חדשה'], ['/me/bookings', 'ההזמנות שלי'], ['/me', 'אזור אישי'], ['/policy', 'נהלים']];
}

function layout(req, title, body) {
  const user = req.user;
  const links = navLinks(user);
  const flash = req.flash;
  const items = html`
    ${links.map(([href, label]) => html`<a href="${href}" ${req.path === href ? raw('aria-current="page"') : ''}>${label}</a>`)}
    ${user ? html`<form method="post" action="/logout">${csrfField(req)}<button class="linklike">יציאה</button></form>` : ''}`;
  return html`<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${config.appName}</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">🚗 ${config.appName}</a>
  <nav class="nav-desktop">
    ${items}
  </nav>
  <details class="menu">
    <summary aria-label="תפריט">☰</summary>
    <nav>${items}</nav>
  </details>
</header>
<main class="container">
  ${flash ? html`<div class="flash flash-${flash.type}" role="status">${flash.text}</div>` : ''}
  ${body}
</main>
<script src="/static/app.js" defer></script>
</body>
</html>`.toString();
}

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

module.exports = { html, raw, escape, markdown, layout, csrfField, postForm, actionButton, field, badge, USER_STATUS, VEHICLE_STATUS };
