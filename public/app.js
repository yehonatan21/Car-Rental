'use strict';
// Progressive enhancements only: every page works without JavaScript.

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
  const pad = (n) => String(n).padStart(2, '0');
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const check = async () => {
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
