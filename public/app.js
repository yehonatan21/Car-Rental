'use strict';
// Progressive enhancements only: every page works without JavaScript.

// Vercel Web Analytics queue (same as @vercel/analytics' inject()): lets window.va('event', …) calls made before
// /_vercel/insights/script.js loads be delivered once it does. Harmless where analytics is not enabled.
window.va = window.va || function va(...params) { (window.vaq = window.vaq || []).push(params); };

// Confirmation prompts on destructive buttons.
document.addEventListener('submit', (e) => {
  const btn = e.submitter || e.target.querySelector('[data-confirm]');
  const msg = btn && btn.dataset.confirm;
  if (msg && !window.confirm(msg)) e.preventDefault();
});

// Phones get the day view by default; a whole week is too cramped.
if (location.pathname === '/calendar' && !new URLSearchParams(location.search).has('view') && window.innerWidth < 640) {
  location.replace('/calendar?view=day');
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
    + (withTime ? `<div class="dp-time" title="שעה (24 שעות)">${svg(CLOCK_ICON, 16)}<select aria-label="שעה"></select><b>:</b><select aria-label="דקות"></select></div>` : '')
    + '<div class="dp-pop" role="dialog" aria-label="בחירת תאריך" hidden></div>';
  input.after(wrap);
  input.type = 'hidden';
  // A <label> around the field would send every click inside the picker to the date text field: keep it, but stop that.
  wrap.addEventListener('click', (e) => { if (e.target.closest('button, select')) e.preventDefault(); });
  const text = wrap.querySelector('.dp-field input');
  const toggle = wrap.querySelector('.dp-toggle');
  const pop = wrap.querySelector('.dp-pop');
  const [hourSel, minSel] = wrap.querySelectorAll('select');
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
  };
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
  const render = () => {
    const sel = datePart();
    const today = isoDate(new Date());
    const min = minIso();
    const start = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay());
    let cells = HE_DOW.map((d) => `<span class="dow">${d}</span>`).join('');
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const iso = isoDate(d);
      const cls = [d.getMonth() !== month.getMonth() && 'other', iso === today && 'today', iso === sel && 'sel'].filter(Boolean).join(' ');
      cells += `<button type="button" data-d="${iso}" class="${cls}" ${min && iso < min ? 'disabled' : ''} aria-label="${showDmy(iso)}"${iso === sel ? ' aria-pressed="true"' : ''}>${d.getDate()}</button>`;
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
    (pop.querySelector('.sel') || pop.querySelector('.today:not(:disabled)') || pop.querySelector('.dp-grid button:not(:disabled)'))?.focus();
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
      month = new Date(month.getFullYear(), month.getMonth() + (b.classList.contains('dp-next') ? 1 : -1), 1);
      render();
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
    if (d.getMonth() !== month.getMonth()) { month = new Date(d.getFullYear(), d.getMonth(), 1); render(); }
    pop.querySelector(`[data-d="${iso}"]`)?.focus();
  });
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
  }
  input.addEventListener('dp-sync', sync);
  sync();
}

for (const input of document.querySelectorAll('input[type=date]:not([data-native]), input[type=datetime-local]:not([data-native])')) enhanceDateInput(input);
document.addEventListener('click', (e) => { if (openPicker && !e.target.closest('.dp')) openPicker(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openPicker) openPicker(true); });

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

// Booking form: keep the return time after pickup and show live availability.
const form = document.querySelector('form[data-availability]');
if (form) {
  const start = form.querySelector('[name=start]');
  const end = form.querySelector('[name=end]');
  const box = document.getElementById('availability');
  const dur = document.getElementById('duration');
  const pad = (n) => String(n).padStart(2, '0');
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const showDuration = () => {
    if (!dur) return;
    const mins = start.value && end.value ? Math.round((new Date(end.value) - new Date(start.value)) / 60000) : 0;
    if (mins <= 0) { dur.textContent = ''; return; }
    const d = Math.floor(mins / 1440); const h = Math.floor((mins % 1440) / 60); const m = mins % 60;
    const parts = [d && (d === 1 ? 'יום' : `${d} ימים`), h && (h === 1 ? 'שעה' : `${h} שעות`), m && `${m} דקות`].filter(Boolean);
    dur.textContent = 'משך ההזמנה: ' + parts.join(' ו־');
  };

  const check = async () => {
    showDuration();
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

  start.addEventListener('change', () => {
    end.min = start.value;
    if (start.value && (!end.value || end.value <= start.value)) {
      end.value = local(new Date(new Date(start.value).getTime() + 2 * 3600000));
    }
    end.dispatchEvent(new Event('dp-sync')); // the date picker shows the new return time (and the new earliest date)
    check();
  });
  end.addEventListener('change', check);
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
