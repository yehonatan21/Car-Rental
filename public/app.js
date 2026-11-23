'use strict';
// Progressive enhancements only: every page works without JavaScript.

// Vercel Web Analytics queue (same as @vercel/analytics' inject()): lets window.va('event', …) calls made before
// /_vercel/insights/script.js loads be delivered once it does. Harmless where analytics is not enabled.
window.va = window.va || function va(...params) { (window.vaq = window.vaq || []).push(params); };

// Confirmation prompts on destructive buttons.
// Confirmation before an action (data-confirm on the button): the site's own dialog, in Hebrew, with a button that
// names the action, instead of the browser's plain box (whose buttons can be in English).
const confirmed = new WeakSet();
document.addEventListener('submit', (e) => {
  const form = e.target;
  const btn = e.submitter || form.querySelector('[data-confirm]');
  const msg = btn?.dataset.confirm;
  if (confirmed.has(form)) { confirmed.delete(form); return; } // the confirmed submit itself: ask again next time
  if (!msg) return;
  e.preventDefault();
  const go = () => { confirmed.add(form); btn.matches('button, input') ? form.requestSubmit(btn) : form.requestSubmit(); };
  if (typeof HTMLDialogElement !== 'function') { if (window.confirm(msg)) go(); return; }
  const danger = btn.matches('.btn-danger, .btn-danger-text, .btn-reject') || /מחיק|הסר|ביטול|חסימ|דחי/.test(btn.textContent);
  const d = document.createElement('dialog');
  d.className = 'confirm-dialog';
  d.setAttribute('aria-labelledby', 'confirm-text');
  const p = document.createElement('p'); p.id = 'confirm-text'; p.textContent = msg;
  const row = document.createElement('div'); row.className = 'confirm-actions';
  const ok = document.createElement('button'); ok.type = 'button'; ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  ok.textContent = (btn.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) || 'אישור';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-light'; cancel.textContent = 'חזרה';
  row.append(ok, cancel); d.append(p, row); document.body.append(d);
  const close = () => { d.close(); d.remove(); btn.focus?.(); };
  cancel.addEventListener('click', close);
  d.addEventListener('cancel', (ev) => { ev.preventDefault(); close(); });
  ok.addEventListener('click', () => { d.close(); d.remove(); go(); });
  d.showModal();
  cancel.focus();
});

// While a form is being sent: its button shows a spinner and cannot be pressed again (a slow upload looked frozen
// and invited a second tap). Disabled only after the browser has taken the form, so the button's own value is sent.
document.addEventListener('submit', (e) => {
  if (e.defaultPrevented || e.target.method === 'get' || e.target.target === '_blank') return;
  const btn = e.submitter;
  if (!btn || btn.matches('.linklike')) return;
  setTimeout(() => { btn.disabled = true; btn.classList.add('busy'); btn.setAttribute('aria-busy', 'true'); }, 0);
});
// Back to a page from the browser history: its buttons work again.
window.addEventListener('pageshow', () => {
  for (const b of document.querySelectorAll('button.busy')) { b.disabled = false; b.classList.remove('busy'); b.removeAttribute('aria-busy'); }
});

// Phones get the day view by default; a whole week is too cramped. The server picks it from the "narrow" cookie, so
// only the very first visit on a phone needs this redirect.
{
  const narrow = window.innerWidth < 640 ? '1' : '0';
  const known = document.cookie.split('; ').find((c) => c.startsWith('narrow='))?.slice(7);
  if (known !== narrow) document.cookie = `narrow=${narrow}; path=/; max-age=31536000; samesite=lax`;
  if (!known && narrow === '1' && location.pathname === '/calendar' && !new URLSearchParams(location.search).has('view')) {
    location.replace('/calendar?view=day');
  }
}

// Close the mobile menu when clicking outside it.
document.addEventListener('click', (e) => {
  const menu = document.querySelector('details.menu');
  if (menu && menu.open && !menu.contains(e.target)) menu.open = false;
});

// ---------- Date & time fields: DD/MM/YYYY and 24-hour time, whatever language the browser is set to ----------
// The browser's own date fields follow its language (an English Chrome shows mm/dd/yyyy and AM/PM). Each
// <input type=date|datetime-local> becomes a hidden field with the same name and value (what the server reads: still
// YYYY-MM-DD / YYYY-MM-DDTHH:MM), a text field for the date with a month picker, and hour / minute lists (00-23).
// Code that sets such a field's value from outside dispatches "dp-sync" on it to update what is shown.
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const HE_DOW = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const p2 = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const svg = (path, size = 18) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const CAL_ICON = '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>';
const CLOCK_ICON = '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>';
const ARROW_ICON = '<path d="M15 6l-6 6 6 6"/>';
let openPicker = null;

/** "31/12/2026" (also 31.12.26, 31-12-2026, 3112 2026…) → "2026-12-31", or "" when it is not a real date. */
function parseDmy(text) {
  const m = /^\s*(\d{1,2})\D+(\d{1,2})\D+(\d{2}|\d{4})\s*$/.exec(text) || /^\s*(\d{2})(\d{2})(\d{4}|\d{2})\s*$/.exec(text);
  if (!m) return '';
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const d = new Date(y, Number(m[2]) - 1, Number(m[1]));
  return d.getDate() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 ? isoDate(d) : '';
}
const showDmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

function enhanceDateInput(input) {
  const withTime = input.type === 'datetime-local';
  const label = input.closest('label');
  const required = input.required;
  const wrap = document.createElement('div');
  wrap.className = 'dp';
  wrap.innerHTML = `<div class="dp-field"><input type="text" inputmode="numeric" autocomplete="off" placeholder="DD/MM/YYYY" maxlength="10" aria-label="${(label?.querySelector('span')?.textContent || 'תאריך').trim()} (יום/חודש/שנה)">`
    + `<button type="button" class="dp-toggle" aria-label="בחירה מלוח שנה" aria-haspopup="dialog" aria-expanded="false">${svg(CAL_ICON)}</button></div>`
    // The time: a button that opens all the hours and minutes at once (no scrolling list). The two lists stay, hidden,
    // as what holds the chosen values.
    + (withTime ? `<div class="dp-time"><button type="button" class="dp-time-btn" aria-haspopup="dialog" aria-expanded="false">${svg(CLOCK_ICON, 16)}<span></span></button>`
      + '<select hidden aria-hidden="true" tabindex="-1"></select><select hidden aria-hidden="true" tabindex="-1"></select>'
      + '<div class="dp-tpop" role="dialog" aria-label="בחירת שעה" hidden></div></div>' : '')
    + '<div class="dp-pop" role="dialog" aria-label="בחירת תאריך" hidden></div>';
  input.after(wrap);
  input.type = 'hidden';
  // A <label> around the field would send every click inside the picker to the date text field: keep it, but stop that.
  wrap.addEventListener('click', (e) => { if (e.target.closest('button, select')) e.preventDefault(); });
  const text = wrap.querySelector('.dp-field input');
  const toggle = wrap.querySelector('.dp-toggle');
  const pop = wrap.querySelector('.dp-pop');
  const [hourSel, minSel] = wrap.querySelectorAll('select');
  const timeBtn = wrap.querySelector('.dp-time-btn');
  const tpop = wrap.querySelector('.dp-tpop');
  text.required = required;
  if (input.id) { text.id = input.id; input.removeAttribute('id'); }
  if (input.autofocus) text.autofocus = true;

  const datePart = () => input.value.slice(0, 10);
  const timePart = () => (withTime ? input.value.slice(11, 16) : '');
  const minIso = () => (input.getAttribute('min') || '').slice(0, 10);
  const fillTime = () => {
    if (!withTime) return;
    const [h, m] = (timePart() || '09:00').split(':').map(Number);
    hourSel.innerHTML = Array.from({ length: 24 }, (_, i) => `<option value="${p2(i)}"${i === h ? ' selected' : ''}>${p2(i)}</option>`).join('');
    const mins = new Set([0, 15, 30, 45, m]);
    minSel.innerHTML = [...mins].sort((a, b) => a - b).map((i) => `<option value="${p2(i)}"${i === m ? ' selected' : ''}>${p2(i)}</option>`).join('');
    showTime();
  };
  function showTime() {
    if (!withTime) return;
    timeBtn.querySelector('span').textContent = `${hourSel.value}:${minSel.value}`;
    timeBtn.setAttribute('aria-label', `שעה: ${hourSel.value}:${minSel.value}. לשינוי`);
  }
  const sync = () => { text.value = showDmy(datePart()); fillTime(); validate(); };
  const validate = () => {
    let msg = '';
    if (text.value && !parseDmy(text.value)) msg = 'יש להזין תאריך בפורמט יום/חודש/שנה, למשל 31/12/2026';
    else if (datePart() && minIso() && datePart() < minIso()) msg = `התאריך המוקדם ביותר הוא ${showDmy(minIso())}`;
    text.setCustomValidity(msg);
  };
  const commit = (iso) => {
    const before = input.value;
    input.value = iso ? (withTime ? `${iso}T${hourSel.value}:${minSel.value}` : iso) : '';
    text.value = showDmy(iso);
    validate();
    if (input.value !== before) input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  let month; // first day of the month on show
  // One day is a tab stop (the selected one, else today, else the first available); arrows move between days.
  const render = (focusIso) => {
    const sel = datePart();
    const today = isoDate(new Date());
    const min = minIso();
    const inMonth = (iso) => iso.slice(0, 7) === isoDate(month).slice(0, 7);
    let stop = [focusIso, sel, today].find((x) => x && inMonth(x) && !(min && x < min));
    const start = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay());
    let cells = HE_DOW.map((d) => `<span class="dow">${d}</span>`).join('');
    if (!stop) {
      for (let i = 1; i <= 31 && !stop; i++) {
        const iso = isoDate(new Date(month.getFullYear(), month.getMonth(), i));
        if (inMonth(iso) && !(min && iso < min)) stop = iso;
      }
    }
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const iso = isoDate(d);
      const cls = [d.getMonth() !== month.getMonth() && 'other', iso === today && 'today', iso === sel && 'sel'].filter(Boolean).join(' ');
      // The name starts with the number shown ("10 בדצמבר 2026"), so voice control finds it (WCAG 2.5.3).
      const name = `${d.getDate()} ב${HE_MONTHS[d.getMonth()]} ${d.getFullYear()}${iso === today ? ', היום' : ''}`;
      cells += `<button type="button" data-d="${iso}" class="${cls}" ${min && iso < min ? 'disabled' : ''} aria-label="${name}"`
        + ` tabindex="${iso === stop ? 0 : -1}"${iso === sel ? ' aria-pressed="true"' : ''}>${d.getDate()}</button>`;
    }
    pop.innerHTML = `<div class="dp-head"><button type="button" class="dp-prev" aria-label="החודש הקודם">${svg(ARROW_ICON)}</button>`
      + `<b>${HE_MONTHS[month.getMonth()]} ${month.getFullYear()}</b><button type="button" class="dp-next" aria-label="החודש הבא">${svg(ARROW_ICON)}</button></div>`
      + `<div class="dp-grid">${cells}</div><div class="dp-foot"><button type="button" data-d="${today}" ${min && today < min ? 'disabled' : ''}>היום</button>`
      + `${required ? '' : '<button type="button" data-clear>ניקוי</button>'}</div>`;
  };
  const open = () => {
    if (openPicker && openPicker !== close) openPicker();
    const base = datePart() || (minIso() > isoDate(new Date()) ? minIso() : isoDate(new Date()));
    month = new Date(Number(base.slice(0, 4)), Number(base.slice(5, 7)) - 1, 1);
    render();
    pop.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    openPicker = close;
    pop.querySelector('.dp-grid button[tabindex="0"]')?.focus();
  };
  function close(focus) {
    pop.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (openPicker === close) openPicker = null;
    if (focus) text.focus();
  }
  toggle.addEventListener('click', () => (pop.hidden ? open() : close()));
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.classList.contains('dp-prev') || b.classList.contains('dp-next')) {
      const which = b.classList.contains('dp-next') ? '.dp-next' : '.dp-prev';
      month = new Date(month.getFullYear(), month.getMonth() + (which === '.dp-next' ? 1 : -1), 1);
      render();
      pop.querySelector(which).focus(); // the button was redrawn: keep the focus on it
      return;
    }
    if (b.hasAttribute('data-clear')) { commit(''); close(true); return; }
    if (b.dataset.d) { commit(b.dataset.d); close(true); }
  });
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    const cur = e.target.closest('.dp-grid button');
    const step = { ArrowLeft: 1, ArrowRight: -1, ArrowDown: 7, ArrowUp: -7 }[e.key]; // right-to-left
    if (!cur || !step) return;
    e.preventDefault();
    const [y, m, day] = cur.dataset.d.split('-').map(Number);
    const d = new Date(y, m - 1, day + step);
    const iso = isoDate(d);
    if (d.getMonth() !== month.getMonth()) { month = new Date(d.getFullYear(), d.getMonth(), 1); render(iso); }
    const next = pop.querySelector(`[data-d="${iso}"]`);
    if (!next || next.disabled) return;
    for (const x of pop.querySelectorAll('.dp-grid button[tabindex="0"]')) x.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  });
  // Focus leaving the picker (Tab past its last button, or elsewhere) closes it.
  wrap.addEventListener('focusout', () => setTimeout(() => {
    if (!pop.hidden && !wrap.contains(document.activeElement)) close();
  }, 0));
  // Typing: "3112" → "31/12/", digits only, slashes added as you go.
  text.addEventListener('input', (e) => {
    if (e.inputType && e.inputType.startsWith('delete')) return;
    const digits = text.value.replace(/\D/g, '').slice(0, 8);
    if (/^\d+$/.test(text.value.replace(/\//g, ''))) {
      text.value = digits.length > 4 ? `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}` : digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
    }
    const iso = parseDmy(text.value);
    if (iso && text.value.length >= 8) commit(iso); else text.setCustomValidity('');
  });
  text.addEventListener('change', () => {
    const iso = parseDmy(text.value);
    if (iso) commit(iso); else if (!text.value) commit(''); else validate();
  });
  text.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); open(); } });
  if (withTime) {
    const onTime = () => {
      const iso = datePart() || parseDmy(text.value);
      if (iso) commit(iso);
    };
    hourSel.addEventListener('change', onTime);
    minSel.addEventListener('change', onTime);
    // The time panel: 24 hours in a grid, then the minutes. An hour keeps it open (for the minutes); a minute closes it.
    const renderTime = () => {
      const btn = (kind, v, on) => `<button type="button" data-${kind}="${v}"${on ? ' class="sel" aria-pressed="true"' : ' aria-pressed="false"'}>${v}</button>`;
      tpop.innerHTML = '<div class="dp-tlabel">שעה</div><div class="dp-hours">'
        + [...hourSel.options].map((o) => btn('h', o.value, o.value === hourSel.value)).join('')
        + '</div><div class="dp-tlabel">דקות</div><div class="dp-mins">'
        + [...minSel.options].map((o) => btn('m', o.value, o.value === minSel.value)).join('') + '</div>';
    };
    const closeTime = (focus) => {
      tpop.hidden = true;
      timeBtn.setAttribute('aria-expanded', 'false');
      if (openPicker === closeTime) openPicker = null;
      if (focus) timeBtn.focus();
    };
    timeBtn.addEventListener('click', () => {
      if (!tpop.hidden) { closeTime(); return; }
      if (openPicker) openPicker();
      renderTime();
      tpop.hidden = false;
      timeBtn.setAttribute('aria-expanded', 'true');
      openPicker = closeTime;
      tpop.querySelector('.sel')?.focus();
    });
    tpop.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.h) {
        hourSel.value = b.dataset.h; onTime(); showTime();
        // Mark the choice in place (redrawing would detach the clicked button, and the page's click handler would
        // then take the click as one outside the picker and close it).
        for (const x of tpop.querySelectorAll('[data-h]')) { const on = x === b; x.classList.toggle('sel', on); x.setAttribute('aria-pressed', String(on)); }
        tpop.querySelector('.dp-mins .sel')?.focus();
      }
      if (b.dataset.m) { minSel.value = b.dataset.m; onTime(); showTime(); closeTime(true); }
    });
    tpop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeTime(true); } });
    wrap.querySelector('.dp-time').addEventListener('focusout', () => setTimeout(() => {
      if (!tpop.hidden && !wrap.querySelector('.dp-time').contains(document.activeElement)) closeTime();
    }, 0));
  }
  input.addEventListener('dp-sync', sync);
  sync();
}

for (const input of document.querySelectorAll('input[type=date]:not([data-native]), input[type=datetime-local]:not([data-native])')) enhanceDateInput(input);
document.addEventListener('click', (e) => { if (openPicker && !e.target.closest('.dp')) openPicker(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (openPicker) { openPicker(true); return; }
  // The phone menu closes on Escape too, and the focus goes back to its button.
  const menu = document.querySelector('details.menu[open]');
  if (menu) { menu.open = false; menu.querySelector('summary').focus(); }
});

// A form that came back with errors: the list of errors gets the focus, so screen readers read it at once, and the
// fields each error is about are marked invalid and pointed at their message (WCAG 3.3.1). Correcting a field clears
// its mark. A date field's visible part is the one marked (the named input is hidden, see enhanceDateInput).
const summary = document.querySelector('[data-error-summary]');
if (summary) {
  const scope = summary.parentElement.querySelector('form') || document;
  for (const li of summary.querySelectorAll('li[data-fields]')) {
    for (const name of li.dataset.fields.split(' ')) {
      for (const el of scope.querySelectorAll(`[name="${CSS.escape(name)}"]`)) {
        const target = el.type === 'hidden' ? el.nextElementSibling?.querySelector('.dp-field input') : el;
        if (!target) continue;
        target.setAttribute('aria-invalid', 'true');
        const ids = new Set((target.getAttribute('aria-describedby') || '').split(' ').filter(Boolean));
        ids.add(li.id);
        target.setAttribute('aria-describedby', [...ids].join(' '));
        const clear = () => target.removeAttribute('aria-invalid');
        target.addEventListener('input', clear, { once: true });
        target.addEventListener('change', clear, { once: true });
      }
    }
  }
  summary.focus();
}

// ---------- Calendar ----------
// Day / week: open the 24-hour grid at the morning (or the first booking of the shown days), not at midnight.
for (const box of document.querySelectorAll('.cal-scroll[data-scroll-hour]')) {
  const slot = box.querySelector('.tg-slot');
  if (slot) box.scrollTop = Number(box.dataset.scrollHour) * slot.offsetHeight;
}
// Admins: a booking opens a window with its details (and approve / reject for a request) instead of a new page.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-dialog]');
  const dlg = a && document.getElementById(a.dataset.dialog);
  if (!dlg || typeof dlg.showModal !== 'function' || e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  dlg.showModal();
});
for (const dlg of document.querySelectorAll('dialog.ev-dialog')) {
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // a click on the backdrop
}

// Booking forms (data-times): the return follows the pickup, keeping the chosen length (2 hours to start with);
// duration buttons set the return in one tap; the user's form also shows live availability (data-availability).
for (const form of document.querySelectorAll('form[data-times]')) {
  const start = form.querySelector('[name=start]');
  const end = form.querySelector('[name=end]');
  const box = document.getElementById('availability');
  const dur = document.getElementById('duration');
  const chips = form.querySelector('.duration-chips');
  const pad = (n) => String(n).padStart(2, '0');
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const plus = (v, mins) => local(new Date(new Date(v).getTime() + mins * 60000));
  const minutes = () => (start.value && end.value ? Math.round((new Date(end.value) - new Date(start.value)) / 60000) : 0);
  let length = minutes() > 0 ? minutes() : 120;

  const showDuration = () => {
    const mins = minutes();
    for (const c of chips?.querySelectorAll('[data-dur]') || []) c.setAttribute('aria-pressed', String(Number(c.dataset.dur) === mins));
    if (!dur) return;
    if (mins <= 0) { dur.textContent = ''; return; }
    const d = Math.floor(mins / 1440); const h = Math.floor((mins % 1440) / 60); const m = mins % 60;
    const parts = [d && (d === 1 ? 'יום' : `${d} ימים`), h && (h === 1 ? 'שעה' : `${h} שעות`), m && `${m} דקות`].filter(Boolean);
    dur.textContent = 'משך ההזמנה: ' + parts.join(' ו־');
  };

  const check = async () => {
    showDuration();
    if (!box || !form.dataset.availability) return;
    if (!start.value || !end.value || end.value <= start.value) {
      box.textContent = end.value && start.value ? 'מועד ההחזרה חייב להיות אחרי מועד האיסוף' : '';
      box.className = 'availability' + (box.textContent ? ' bad' : '');
      return;
    }
    try {
      const r = await fetch(`${form.dataset.availability}?start=${encodeURIComponent(start.value)}&end=${encodeURIComponent(end.value)}`);
      const data = await r.json();
      box.textContent = data.message;
      box.className = 'availability ' + (data.ok ? 'good' : 'bad');
    } catch { /* offline: the server validates anyway */ }
  };
  const setEnd = (v) => { end.value = v; end.dispatchEvent(new Event('dp-sync')); };

  start.addEventListener('change', () => {
    end.min = start.value;
    if (start.value) setEnd(plus(start.value, length)); // the return moves with the pickup, same length
    else end.dispatchEvent(new Event('dp-sync'));
    check();
  });
  end.addEventListener('change', () => { if (minutes() > 0) length = minutes(); check(); });
  if (chips) {
    chips.hidden = false;
    chips.addEventListener('click', (e) => {
      const c = e.target.closest('[data-dur]');
      if (!c) return;
      length = Number(c.dataset.dur);
      if (start.value) { setEnd(plus(start.value, length)); check(); } else showDuration();
    });
  }
  check();
}

// License uploads: shrink large photos in the browser (phone photos are often 4-12 MB) and refuse files that are
// still over the limit, which the hosting platform would otherwise cut off with a bare error page.
const mb = (n) => `${(n / 1048576).toFixed(1).replace(/\.0$/, '')}MB`;

async function shrinkImage(file, maxSide = 2400, quality = 0.85) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
}

// File fields in Hebrew: the browser's own button and "no file chosen" follow its language (an English browser says
// "Choose File / No file chosen"). The real input stays in the form, hidden but focusable and still validated; a
// button opens it, the chosen file's name is shown, and a file can also be dropped onto the field.
for (const input of document.querySelectorAll('input[type=file]')) {
  const box = document.createElement('div');
  box.className = 'file-pick';
  box.innerHTML = `<button type="button" class="btn btn-light btn-sm file-pick-btn">${svg('<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>', 16)} בחירת קובץ</button>`
    + '<span class="file-pick-name" dir="auto">לא נבחר קובץ</span><small class="file-pick-drop">או גררו קובץ לכאן</small>';
  input.before(box);
  box.prepend(input);
  input.classList.add('file-pick-input');
  const name = box.querySelector('.file-pick-name');
  const show = () => {
    const f = input.files && input.files[0];
    // The name in its own direction and the extension apart, so "רישיון-רכב-2027.pdf" doesn't come out as
    // "pdf.2027-רישיון-רכב" (text, never HTML: a file name is not trusted).
    name.replaceChildren();
    name.dir = 'rtl'; // set, not "auto": the pieces below are isolated, so "auto" would find no letters and go LTR
    if (!f) { name.textContent = 'לא נבחר קובץ'; } else {
      const dot = f.name.lastIndexOf('.');
      const base = document.createElement('bdi');
      base.textContent = dot > 0 ? f.name.slice(0, dot) : f.name;
      name.append(base);
      if (dot > 0) {
        const ext = document.createElement('bdi');
        ext.dir = 'ltr';
        ext.className = 'file-pick-ext';
        ext.textContent = f.name.slice(dot);
        name.append(ext);
      }
    }
    box.classList.toggle('has-file', Boolean(f));
  };
  box.querySelector('.file-pick-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', show);
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
  box.addEventListener('dragleave', () => box.classList.remove('drag'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('drag');
    if (!e.dataTransfer.files.length) return;
    input.files = e.dataTransfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  input.form?.addEventListener('reset', () => setTimeout(show, 0));
  input.addEventListener('file-pick-sync', show); // after app.js swaps in a smaller photo
}

for (const input of document.querySelectorAll('input[type=file][data-max-bytes]')) {
  const max = Number(input.dataset.maxBytes);
  const note = document.createElement('small');
  note.className = 'upload-note';
  note.setAttribute('aria-live', 'polite');
  input.after(note);
  input.addEventListener('change', async () => {
    const file = input.files[0];
    note.textContent = '';
    note.classList.remove('bad');
    if (!file) return;
    let out = file;
    if (/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type) && file.size > 1.5 * 1048576) {
      note.textContent = 'מקטין את התמונה…';
      try { out = await shrinkImage(file); } catch { out = file; } // e.g. a format this browser can't decode
    }
    if (out.size > max) {
      input.value = '';
      input.dispatchEvent(new Event('file-pick-sync'));
      note.textContent = `הקובץ גדול מדי (${mb(out.size)}). המקסימום הוא ${mb(max)}: צלמו שוב, או העלו צילום מסך או PDF קטן יותר.`;
      note.classList.add('bad');
      return;
    }
    if (out !== file) {
      const dt = new DataTransfer();
      dt.items.add(out);
      input.files = dt.files; // assigning does not fire "change" again
      input.dispatchEvent(new Event('file-pick-sync'));
      note.textContent = `התמונה הוקטנה מ־${mb(file.size)} ל־${mb(out.size)}.`;
    } else {
      note.textContent = '';
    }
  });
}

// Tabs between the sections of one page (settings). The server already shows the tab of ?tab=…; here a click switches
// at once without reloading (and the address keeps ?tab=… for a reload or the Back button), and an old "#section"
// address opens the tab that holds that section.
const tablist = document.querySelector('[data-tabs]');
if (tablist) {
  const tabs = [...tablist.querySelectorAll('a[data-tab]')];
  const panels = tabs.map((t) => document.getElementById(t.dataset.tab)).filter(Boolean);
  const panelFor = (hash) => {
    let el = null;
    try { el = hash.length > 1 && document.getElementById(decodeURIComponent(hash.slice(1))); } catch { /* bad hash */ }
    return el ? panels.find((p) => p === el || p.contains(el)) : null;
  };
  const show = (panel, focus) => {
    // A panel the server fills only when asked (Settings → Reports): load it.
    if (panel.hasAttribute('data-load')) { location.href = `?tab=${encodeURIComponent(panel.id)}`; return; }
    for (const p of panels) p.hidden = p !== panel;
    for (const t of tabs) {
      const on = t.dataset.tab === panel.id;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on) {
        t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (focus) t.focus();
      }
    }
  };
  const remember = (id) => {
    const u = new URL(location.href);
    u.searchParams.set('tab', id);
    u.hash = '';
    history.replaceState(null, '', u.pathname + u.search);
  };
  const toTop = () => window.scrollTo(0, 0);
  const fromHash = panelFor(location.hash);
  show(fromHash || panels.find((p) => !p.hidden) || panels[0]);
  if (fromHash) {
    // Start at the top (title, the message about what was just saved, the tabs), not at the anchor.
    requestAnimationFrame(toTop);
    window.addEventListener('load', () => setTimeout(toTop, 0));
  }
  tablist.addEventListener('click', (e) => {
    const t = e.target.closest('a[data-tab]');
    if (!t || e.ctrlKey || e.metaKey || e.shiftKey) return; // a new tab/window: let the browser open ?tab=…
    e.preventDefault();
    show(document.getElementById(t.dataset.tab));
    remember(t.dataset.tab);
  });
  // Arrow keys move between tabs (right-to-left: the right arrow goes back).
  tablist.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowLeft' ? 1 : -1) + tabs.length) % tabs.length;
    show(document.getElementById(tabs[n].dataset.tab), true);
    remember(tabs[n].dataset.tab);
  });
  window.addEventListener('hashchange', () => {
    const p = panelFor(location.hash);
    if (p) { show(p); toTop(); }
  });
}

// "Suggest a password": fills the field with a strong random one (shown, so the admin can pass it on).
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-generate-password]');
  const input = btn && btn.closest('form')?.querySelector('[data-password-target]');
  if (!input) return;
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes (l/1, O/0)
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let pw = [...bytes].map((b) => abc[b % abc.length]).join('');
  if (!/\d/.test(pw)) pw = pw.slice(0, -1) + '23456789'[bytes[0] % 8];
  input.value = pw;
  input.select();
});

// Passkeys (src/passkeys.js): adding one (/me/security) and proving it (signing in, confirming a sensitive action).
// The server sends WebAuthn options as JSON; the device's answer goes back in the form's "credential" field.
{
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer;
  const creationOptions = (o) => (window.PublicKeyCredential?.parseCreationOptionsFromJSON ? PublicKeyCredential.parseCreationOptionsFromJSON(o) : {
    ...o, challenge: unb64(o.challenge), user: { ...o.user, id: unb64(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: unb64(c.id) })),
  });
  const requestOptions = (o) => (window.PublicKeyCredential?.parseRequestOptionsFromJSON ? PublicKeyCredential.parseRequestOptionsFromJSON(o) : {
    ...o, challenge: unb64(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: unb64(c.id) })),
  });
  const toJSON = (cred) => {
    if (typeof cred.toJSON === 'function') { try { return cred.toJSON(); } catch { /* older browsers: by hand below */ } }
    const r = cred.response;
    const response = r.attestationObject
      ? { clientDataJSON: b64(r.clientDataJSON), attestationObject: b64(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] }
      : { clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature), userHandle: r.userHandle ? b64(r.userHandle) : undefined };
    return { id: cred.id, rawId: b64(cred.rawId), type: cred.type, response, clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment || undefined };
  };
  const MESSAGES = {
    NotAllowedError: 'הפעולה בוטלה או שפג הזמן. נסו שוב.',
    InvalidStateError: 'המפתח הזה כבר רשום לחשבון.',
    NotSupportedError: 'המכשיר או הדפדפן אינם תומכים במפתחות גישה.',
    SecurityError: 'הדפדפן חסם את הפעולה בכתובת הזו.',
  };
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-passkey]');
    if (!btn) return;
    const form = btn.closest('form');
    const error = form.querySelector('[data-passkey-error]');
    if (!window.PublicKeyCredential) { error.textContent = MESSAGES.NotSupportedError; return; }
    btn.disabled = true;
    error.textContent = '';
    try {
      let cred;
      if (btn.dataset.passkey === 'create') {
        const body = new URLSearchParams({ _csrf: form.querySelector('[name=_csrf]')?.value || '' });
        const r = await fetch(btn.dataset.optionsUrl, { method: 'POST', body, credentials: 'same-origin' });
        if (!r.ok) throw new Error('לא ניתן להתחיל כרגע. רעננו את הדף ונסו שוב.');
        const { token, options } = await r.json();
        form.querySelector('[name=token]').value = token;
        cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
      } else {
        cred = await navigator.credentials.get({ publicKey: requestOptions(JSON.parse(btn.dataset.options)) });
      }
      form.querySelector('[name=credential]').value = JSON.stringify(toJSON(cred));
      form.submit();
    } catch (err) {
      error.textContent = MESSAGES[err.name] || err.message || 'הפעולה נכשלה. נסו שוב.';
      btn.disabled = false;
    }
  });
}

// Show/hide a password (the eye button beside the field).
for (const b of document.querySelectorAll('[data-reveal]')) {
  b.hidden = false;
  b.addEventListener('click', () => {
    const input = document.getElementById(b.dataset.reveal);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.setAttribute('aria-pressed', String(show));
    b.setAttribute('aria-label', show ? 'הסתרת הסיסמה' : 'הצגת הסיסמה');
  });
}

// Phones: a list's filters start folded (unless one is on), so the list comes first.
if (window.innerWidth <= 680) for (const d of document.querySelectorAll('details.filter-box:not([data-active])')) d.open = false;

// ---------- The installable app (PWA, src/routes/pwa.js) ----------
// The service worker keeps only the shared files (stylesheet, script, icons) and the "no connection" page; pages
// themselves always come from the network.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

// "Install the app" on the personal page: Android's install prompt, or the steps on an iPhone. Not in the installed
// app itself, and not again for a month after "Not now".
(() => {
  const card = document.querySelector('[data-install]');
  if (!card) return;
  const installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  let snoozed = false;
  try { snoozed = Date.now() < Number(localStorage.getItem('install-snooze') || 0); } catch { /* private mode */ }
  if (installed || snoozed) return;
  card.querySelector('[data-install-dismiss]').addEventListener('click', () => {
    try { localStorage.setItem('install-snooze', String(Date.now() + 30 * 86400000)); } catch { /* private mode */ }
    card.hidden = true;
  });
  // iPhone / iPad Safari: no install prompt, the Share menu instead (other iOS browsers can't install).
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && /safari/i.test(navigator.userAgent) && !/crios|fxios|edgios/i.test(navigator.userAgent)) {
    card.querySelector('[data-install-ios]').hidden = false;
    card.hidden = false;
    return;
  }
  let prompt = null;
  const button = card.querySelector('[data-install-button]');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    prompt = e;
    button.hidden = false;
    card.hidden = false;
  });
  button.addEventListener('click', async () => {
    if (!prompt) return;
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    prompt = null;
    if (outcome === 'accepted') card.hidden = true;
  });
  window.addEventListener('appinstalled', () => { card.hidden = true; });
})();

// ---------- Phone notifications (src/push.js) ----------
// The card on the personal page turns them on or off for this device. On an iPhone they work only inside the
// installed app (Add to Home Screen), so there the card says that first.
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64ToBytes = (s) => {
  const raw = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const bytesToB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function pushPost(url, form, fields) {
  const body = new URLSearchParams({ _csrf: form.querySelector('[name=_csrf]').value, ...fields });
  const r = await fetch(url, { method: 'POST', body, credentials: 'same-origin', headers: { accept: 'application/json' } });
  return r.ok && (await r.json()).ok;
}
(() => {
  const card = document.querySelector('[data-push]');
  if (!card) return;
  const state = card.querySelector('[data-push-state]');
  const on = card.querySelector('[data-push-on]');
  const off = card.querySelector('[data-push-off]');
  const form = card.querySelector('[data-push-form]');
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (!pushSupported()) {
    if (ios && !installed) {
      state.textContent = 'באייפון ההתראות פועלות רק מתוך האפליקציה: קודם מתקינים אותה (הוספה למסך הבית), ואז מפעילים כאן.';
      card.hidden = false;
    }
    return;
  }
  card.hidden = false;
  const show = (sub) => {
    const blocked = Notification.permission === 'denied';
    on.hidden = Boolean(sub) || blocked;
    off.hidden = !sub;
    state.textContent = sub ? '✓ ההתראות פעילות בטלפון הזה.'
      : blocked ? 'ההתראות חסומות בדפדפן לאתר הזה. אפשר לאשר אותן בהגדרות האתר בדפדפן (סמל המנעול ליד הכתובת), ואז לרענן את הדף.'
        : 'ההתראות כבויות בטלפון הזה.';
  };
  navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then(show).catch(() => show(null));
  on.addEventListener('click', async () => {
    on.disabled = true;
    try {
      if (await Notification.requestPermission() !== 'granted') { show(null); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(card.dataset.key) });
      const ok = await pushPost('/me/push', form, { endpoint: sub.endpoint, p256dh: bytesToB64(sub.getKey('p256dh')), auth: bytesToB64(sub.getKey('auth')) });
      if (!ok) { await sub.unsubscribe(); state.textContent = 'לא ניתן היה להפעיל את ההתראות. נסו שוב מאוחר יותר.'; return; }
      show(sub);
    } catch {
      state.textContent = 'לא ניתן היה להפעיל את ההתראות בדפדפן הזה.';
    } finally {
      on.disabled = false;
    }
  });
  off.addEventListener('click', async () => {
    off.disabled = true;
    try {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (sub) { await pushPost('/me/push/remove', form, { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      show(null);
    } finally {
      off.disabled = false;
    }
  });
})();

// Signing out on a phone: its notifications stop too, so the next person to use it doesn't get them.
document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (!form.matches('form[action="/logout"]') || form.dataset.pushDone || !pushSupported()) return;
  e.preventDefault();
  form.dataset.pushDone = '1';
  try {
    const reg = await Promise.race([navigator.serviceWorker.getRegistration(), new Promise((r) => { setTimeout(r, 1000); })]);
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) {
      await Promise.race([pushPost('/me/push/remove', form, { endpoint: sub.endpoint }), new Promise((r) => { setTimeout(r, 1500); })]);
      await sub.unsubscribe();
    }
  } catch { /* sign out anyway */ }
  form.submit();
});
