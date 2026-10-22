'use strict';
require('../helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validIsraeliId, normalizePhone, validPhone, safeNext } = require('../../src/routes/public');

test('Israeli ID check digit', () => {
  for (const ok of ['000000018', '123456782', '000000026', '000000034']) assert.ok(validIsraeliId(ok), ok);
  assert.ok(validIsraeliId('18'.padStart(5, '0')), 'short IDs are zero-padded');
  for (const bad of ['123456789', '000000019', '12345678a', '1234567890', '', '1234']) assert.ok(!validIsraeliId(bad), bad);
});

test('phone numbers', () => {
  assert.equal(normalizePhone('050-123 4567'), '0501234567');
  assert.ok(validPhone('0501234567'));
  assert.ok(validPhone('+972501234567'));
  assert.ok(!validPhone('031234567'), 'landline');
  assert.ok(!validPhone('050123456'), 'too short');
  assert.ok(!validPhone(normalizePhone(undefined)));
});

test('safeNext only allows same-origin paths', () => {
  assert.equal(safeNext('/me/bookings?x=1'), '/me/bookings?x=1');
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '', null, ['/me'], '/a\r\nSet-Cookie: x']) {
    assert.equal(safeNext(bad), null, String(bad));
  }
});
