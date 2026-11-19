'use strict';
// Password rules, the same everywhere a password is chosen (registration, reset, change, set by a manager or the
// console). At least 8 characters, at most 200, and not one people commonly use: the 10,000 most common leaked
// passwords, also with a short ending added ("Dragon2024!"), and nothing built from the person's e-mail or name (S-04).
const fs = require('node:fs');
const path = require('node:path');

let common = null;
function commonSet() {
  if (!common) {
    common = new Set(fs.readFileSync(path.join(__dirname, 'common-passwords.txt'), 'utf8')
      .split('\n').filter((l) => l && !l.startsWith('#')));
  }
  return common;
}

const MIN = 8;
const MAX = 200;

/**
 * Why `password` is not acceptable (a sentence in Hebrew), or null when it is.
 * @param {object} [who] { email, first_name, last_name } of the person, when known
 */
function passwordProblem(password, who = {}) {
  const p = String(password || '');
  if (p.length < MIN) return `הסיסמה חייבת להכיל לפחות ${MIN} תווים`;
  if (p.length > MAX) return `הסיסמה ארוכה מדי (עד ${MAX} תווים)`;
  const lower = p.toLowerCase();
  const stem = lower.replace(/[0-9!@#$%^&*.,?~+=_-]{1,6}$/, ''); // "Dragon2024!" → "dragon"
  if (/^(.)\1+$/.test(p) || commonSet().has(lower) || (stem.length >= 4 && commonSet().has(stem))) {
    return 'הסיסמה הזו נפוצה מדי וקל לנחש אותה. בחרו סיסמה אחרת, למשל כמה מילים יחד';
  }
  const parts = [String(who.email || '').split('@')[0], who.first_name, who.last_name]
    .map((s) => String(s || '').toLowerCase()).filter((s) => s.length >= 3);
  if (parts.some((s) => lower.includes(s))) return 'הסיסמה לא יכולה להכיל את השם או את כתובת המייל';
  return null;
}

module.exports = { passwordProblem, MIN, MAX };
