'use strict';
// Every action the app writes to the action log has a Hebrew name on the log pages.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LABELS, actionLabel } = require('../../src/views/audit-labels');

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name))
    : e.name.endsWith('.js') ? [fs.readFileSync(path.join(dir, e.name), 'utf8')] : []));
}

test('every audited action has a Hebrew label', () => {
  const code = sources(path.join(__dirname, '../../src')).join('\n');
  const actions = new Set([...code.matchAll(/'((?:admin|block|booking|license|mail|manage|master|policy|settings|user|vehicle)\.[a-z_]+)'/g)].map((m) => m[1]));
  const missing = [...actions].filter((a) => !LABELS[a]);
  assert.deepEqual(missing, [], `add these to src/views/audit-labels.js: ${missing.join(', ')}`);
  assert.equal(actionLabel('booking.approve'), 'אישור הזמנה');
  assert.equal(actionLabel('something.new'), 'something.new', 'an unknown action shows its code');
});
