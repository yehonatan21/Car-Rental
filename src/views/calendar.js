'use strict';
// Day / week / month calendar rendering.
const { html, raw } = require('./html');
const time = require('../time');

const startOfWeek = (d) => time.addDays(d, -time.parse(d).getDay()); // weeks start on Sunday

function windowFor(view, date) {
  if (view === 'day') return { from: date, to: time.addDays(date, 1) };
  if (view === 'week') { const s = startOfWeek(date); return { from: s, to: time.addDays(s, 7) }; }
  const first = date.slice(0, 8) + '01';
  const s = startOfWeek(first);
  const nextMonth = time.toDate(new Date(time.parse(first).getFullYear(), time.parse(first).getMonth() + 1, 1));
  const e = time.addDays(startOfWeek(time.addDays(nextMonth, -1)), 7);
  return { from: s, to: e, monthStart: first, monthEnd: nextMonth };
}

function shift(view, date, dir) {
  if (view === 'day') return time.addDays(date, dir);
  if (view === 'week') return time.addDays(date, 7 * dir);
  const d = time.parse(date.slice(0, 8) + '01');
  return time.toDate(new Date(d.getFullYear(), d.getMonth() + dir, 1));
}

function title(view, date, win) {
  if (view === 'day') return time.fmtLong(date).replace(/ \d\d:\d\d$/, '');
  if (view === 'week') return `${time.fmt(win.from)} – ${time.fmt(time.addDays(win.to, -1))}`;
  const d = time.parse(date);
  return `${time.HE_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

const hhmm = (s) => s.slice(11, 16);

function segmentsForDay(entries, day) {
  const dayStart = day + 'T00:00';
  const dayEnd = time.addDays(day, 1) + 'T00:00';
  return entries
    .filter((e) => e.start_at < dayEnd && e.end_at > dayStart)
    .map((e) => {
      const s = e.start_at > dayStart ? e.start_at : dayStart;
      const en = e.end_at < dayEnd ? e.end_at : dayEnd;
      const mins = (x) => (x === dayEnd ? 1440 : Number(x.slice(11, 13)) * 60 + Number(x.slice(14, 16)));
      return { e, top: (mins(s) / 1440) * 100, height: Math.max(((mins(en) - mins(s)) / 1440) * 100, 1.5), s, en };
    });
}

function entryChip(e, linkFor) {
  const href = linkFor(e);
  const inner = html`<span class="t">${hhmm(e.start_at)}–${hhmm(e.end_at)}</span> <span class="l">${e.label}</span>`;
  return href ? html`<a class="ev ${e.cls}" href="${href}">${inner}</a>` : html`<span class="ev ${e.cls}">${inner}</span>`;
}

function timeGrid(days, entries, { linkFor, slotLink, nowStr }) {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  return html`
<div class="cal-scroll"><div class="timegrid" style="--days:${days.length}">
  <div class="tg-head tg-corner"></div>
  ${days.map((d) => html`<div class="tg-head ${d === nowStr.slice(0, 10) ? 'today' : ''}">
    <a href="?view=day&date=${d}">${time.HE_DAYS[time.parse(d).getDay()]}<br><b>${time.fmt(d).slice(0, 5)}</b></a></div>`)}
  <div class="tg-hours">${hours.map((h) => html`<div class="tg-hour">${String(h).padStart(2, '0')}:00</div>`)}</div>
  ${days.map((d) => html`<div class="tg-col">
    ${hours.map((h) => {
      const slot = `${d}T${String(h).padStart(2, '0')}:00`;
      const href = slotLink && time.addMinutes(slot, 60) > nowStr ? slotLink(slot) : null;
      return href ? html`<a class="tg-slot" href="${href}" title="הזמנה מ־${time.fmt(slot)}"></a>` : html`<div class="tg-slot past"></div>`;
    })}
    ${segmentsForDay(entries, d).map(({ e, top, height, s, en }) => {
      const href = linkFor(e);
      const tag = href ? 'a' : 'div';
      return raw(`<${tag} class="ev-block ${e.cls}" style="top:${top.toFixed(3)}%;height:${height.toFixed(3)}%"${href ? ` href="${href}"` : ''}>`
        + html`<span class="t">${hhmm(s)}–${en.endsWith('T00:00') && en > s ? '24:00' : hhmm(en)}</span><span class="l">${e.label}</span>`
        + `</${tag}>`);
    })}
  </div>`)}
</div></div>`;
}

function monthGrid(win, entries, { linkFor, nowStr }) {
  const days = [];
  for (let d = win.from; d < win.to; d = time.addDays(d, 1)) days.push(d);
  return html`
<div class="month">
  ${time.HE_DAYS.map((n) => html`<div class="m-head">${n}</div>`)}
  ${days.map((d) => {
    const dayEntries = entries.filter((e) => e.start_at < time.addDays(d, 1) + 'T00:00' && e.end_at > d + 'T00:00');
    const out = d < win.monthStart || d >= win.monthEnd;
    return html`<div class="m-cell ${out ? 'out' : ''} ${d === nowStr.slice(0, 10) ? 'today' : ''} ${dayEntries.length ? 'has' : 'free'}">
      <a class="m-day" href="?view=day&date=${d}">${Number(d.slice(8))}</a>
      ${dayEntries.slice(0, 3).map((e) => entryChip(e, linkFor))}
      ${dayEntries.length > 3 ? html`<a class="more" href="?view=day&date=${d}">+${dayEntries.length - 3}</a>` : ''}
    </div>`;
  })}
</div>`;
}

/**
 * @param entries calendar items already decorated with {label, cls}
 * @param opts {view, date, linkFor(e) -> href|null, slotLink(slot) -> href|null}
 */
function renderCalendar(entries, opts) {
  const { view, date } = opts;
  const win = windowFor(view, date);
  const nowStr = time.now();
  const nav = html`
<div class="cal-toolbar">
  <div class="cal-nav">
    <a class="btn btn-light" href="?view=${view}&date=${shift(view, date, -1)}" aria-label="הקודם">→</a>
    <a class="btn btn-light" href="?view=${view}&date=${time.today()}">היום</a>
    <a class="btn btn-light" href="?view=${view}&date=${shift(view, date, 1)}" aria-label="הבא">←</a>
    <h2>${title(view, date, win)}</h2>
  </div>
  <div class="tabs">
    ${[['day', 'יום'], ['week', 'שבוע'], ['month', 'חודש']].map(([v, l]) =>
      html`<a href="?view=${v}&date=${date}" class="${v === view ? 'active' : ''}">${l}</a>`)}
  </div>
</div>`;
  let body;
  if (view === 'month') body = monthGrid(win, entries, { ...opts, nowStr });
  else {
    const days = [];
    for (let d = win.from; d < win.to; d = time.addDays(d, 1)) days.push(d);
    body = timeGrid(days, entries, { ...opts, nowStr });
  }
  return html`<section class="calendar">${nav}${body}</section>`;
}

module.exports = { renderCalendar, windowFor };
