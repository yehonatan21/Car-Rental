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
      note.textContent = `הקובץ גדול מדי (${mb(out.size)}). המקסימום הוא ${mb(max)}: צלמו שוב, או העלו צילום מסך או PDF קטן יותר.`;
      note.classList.add('bad');
      return;
    }
    if (out !== file) {
      const dt = new DataTransfer();
      dt.items.add(out);
      input.files = dt.files; // assigning does not fire "change" again
      note.textContent = `התמונה הוקטנה מ־${mb(file.size)} ל־${mb(out.size)}.`;
    } else {
      note.textContent = '';
    }
  });
}
