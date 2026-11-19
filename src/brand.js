'use strict';
// The client's own name, look and contact details. Every client runs its own instance of the app (its own
// deployment and database), so these belong to the instance: what the client's admin sets in Settings → Organization
// wins, then the environment variables the instance was created with, then the defaults below.
const config = require('./config');
const { db } = require('./db');

const DEFAULT_COLOR = '#0b7a63';
const DEFAULT_WELCOME = 'בודקים מתי הרכב פנוי, שולחים בקשה ומקבלים אישור מהמנהל – הכל במקום אחד.';
const env = (name) => String(process.env[name] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();

/** The fields an admin can set, with their limits; empty means "use the instance's environment / default". */
const FIELDS = {
  org_name: { max: 60 },
  mail_from_name: { max: 60 },
  brand_color: { max: 7 },
  contact_email: { max: 120 },
  contact_phone: { max: 30 },
  welcome_text: { max: 300 },
  logo_file: { max: 80 },
  // The accessibility coordinator named in the accessibility statement (/accessibility).
  a11y_name: { max: 60 },
  a11y_phone: { max: 30 },
  a11y_email: { max: 120 },
};

const validColor = (c) => /^#[0-9a-f]{6}$/i.test(c);

// Read from the database at most every few seconds per server instance; saving clears it at once here, and other
// instances (Vercel runs several) pick the change up within CACHE_MS.
const CACHE_MS = 5000;
let cache = null;

function stored() {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    cache = { at: Date.now(), values: Object.fromEntries(db.prepare('SELECT key, value FROM branding').all().map((r) => [r.key, r.value])) };
  }
  return cache.values;
}

/** The effective branding of this instance. */
function brand() {
  const s = stored();
  const name = s.org_name || config.appName;
  const color = [s.brand_color, env('BRAND_COLOR')].find(validColor) || DEFAULT_COLOR;
  return {
    name,
    mailFromName: s.mail_from_name || config.mailFromName || name,
    color,
    customColor: color.toLowerCase() !== DEFAULT_COLOR,
    contactEmail: s.contact_email || env('CONTACT_EMAIL'),
    contactPhone: s.contact_phone || env('CONTACT_PHONE'),
    welcomeText: s.welcome_text || env('WELCOME_TEXT') || DEFAULT_WELCOME,
    logoFile: s.logo_file || null,
    a11y: { name: s.a11y_name || '', phone: s.a11y_phone || '', email: s.a11y_email || '' },
    stored: s,
  };
}

/** Saves the admin's values; an empty value removes the override. */
function saveBrand(values) {
  for (const [key, { max }] of Object.entries(FIELDS)) {
    if (!(key in values)) continue;
    const v = String(values[key] ?? '').trim().slice(0, max);
    if (v) db.prepare('INSERT INTO branding (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, v);
    else db.prepare('DELETE FROM branding WHERE key = ?').run(key);
  }
  cache = null;
}

// ---------- Colours: a whole palette (light and dark mode) from the one brand colour ----------
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => '#' + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const DARK_BG = [21, 32, 29];
const PAGE_BG = [243, 246, 245]; // --bg in light mode
function luminance(c) {
  const [r, g, b] = c.map((x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };

/** CSS custom properties for the brand colour, keeping text on it readable (WCAG AA contrast). */
function paletteCss(hex) {
  let c = rgb(hex);
  // A very light colour is darkened until white text on it stays readable; the other way round for dark mode.
  for (let i = 0; i < 10 && contrast(c, WHITE) < 4.5; i++) c = mix(c, BLACK, 0.12);
  // Links and headings in the colour sit on the light grey page too (#f3f6f5): a small extra darkening keeps 4.5:1
  // there (WCAG 1.4.3), so the shade stays the client's own (e.g. #6b7a1a → #687619).
  for (let i = 0; i < 20 && contrast(c, PAGE_BG) < 4.5; i++) c = mix(c, BLACK, 0.03);
  let d = mix(c, WHITE, 0.35);
  for (let i = 0; i < 10 && contrast(d, DARK_BG) < 4.5; i++) d = mix(d, WHITE, 0.15);
  const light = {
    '--primary': toHex(c), '--primary-hover': toHex(mix(c, BLACK, 0.18)), '--primary-ink': '#ffffff',
    '--primary-soft': toHex(mix(c, WHITE, 0.88)), '--primary-soft-ink': toHex(mix(c, BLACK, 0.35)), '--mine': toHex(c),
    '--ring': `0 0 0 3px ${toHex(c)}40`,
  };
  const dark = {
    '--primary': toHex(d), '--primary-hover': toHex(mix(d, WHITE, 0.2)), '--primary-ink': toHex(mix(d, BLACK, 0.85)),
    '--primary-soft': toHex(mix(c, DARK_BG, 0.75)), '--primary-soft-ink': toHex(mix(d, WHITE, 0.5)), '--mine': toHex(d),
    '--ring': `0 0 0 3px ${toHex(d)}59`,
  };
  const vars = (o) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(';');
  return `:root{${vars(light)}}@media (prefers-color-scheme: dark){:root{${vars(dark)}}}`;
}

module.exports = { brand, saveBrand, paletteCss, validColor, FIELDS, DEFAULT_COLOR, contrast, rgb };
