'use strict';
// Helpers for the "YYYY-MM-DDTHH:MM" local-time strings used throughout the app.
require('./config'); // ensures TZ is set before any Date is built

const pad = (n) => String(n).padStart(2, '0');
const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parse(s) {
  return new Date(s.length === 10 ? s + 'T00:00' : s);
}

function isValidLocal(s) {
  if (typeof s !== 'string' || !LOCAL_RE.test(s)) return false;
  return toLocal(parse(s)) === s; // rejects 2026-02-31 and DST gaps
}

function isValidDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && toDate(parse(s)) === s;
}

const now = () => toLocal(new Date());
const today = () => toDate(new Date());

function addMinutes(s, minutes) {
  return toLocal(new Date(parse(s).getTime() + minutes * 60000));
}

function addDays(dateStr, days) {
  const d = parse(dateStr);
  d.setDate(d.getDate() + days);
  return toDate(d);
}

function hoursBetween(a, b) {
  return (parse(b) - parse(a)) / 3600000;
}

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

/** "22/10/2026 14:30" */
function fmt(s) {
  if (!s) return '';
  const [d, t] = s.split(/[T ]/);
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}${t ? ' ' + t.slice(0, 5) : ''}`;
}

/** "יום חמישי, 22/10/2026 14:30" */
function fmtLong(s) {
  return `יום ${HE_DAYS[parse(s).getDay()]}, ${fmt(s)}`;
}

module.exports = {
  toLocal, toDate, parse, isValidLocal, isValidDate, now, today,
  addMinutes, addDays, hoursBetween, fmt, fmtLong, HE_DAYS, HE_MONTHS,
};
