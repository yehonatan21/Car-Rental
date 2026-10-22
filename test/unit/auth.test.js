'use strict';
const { createUser, db } = require('../helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../../src/auth');

test('password hashing uses a random salt and verifies correctly', () => {
  const a = auth.hashPassword('Correct horse');
  const b = auth.hashPassword('Correct horse');
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$/);
  assert.ok(auth.verifyPassword('Correct horse', a));
  assert.ok(!auth.verifyPassword('correct horse', a));
  assert.ok(!auth.verifyPassword('anything', null), 'accounts without a password cannot log in with one');
});

test('TOTP matches the RFC 6238 SHA-1 test vectors', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  // [unix time, 8-digit value from the RFC] → we use the last 6 digits
  for (const [t, code] of [[59, '94287082'], [1111111109, '07081804'], [1234567890, '89005924'], [2000000000, '69279037']]) {
    assert.equal(auth.totpAt(secret, Math.floor(t / 30)), code.slice(2), `T=${t}`);
  }
});

test('TOTP accepts ±1 time step and rejects others', () => {
  const secret = auth.newTotpSecret();
  const now = 1_800_000_000_000;
  const step = Math.floor(now / 30000);
  assert.ok(auth.verifyTotp(secret, auth.totpAt(secret, step), now));
  assert.ok(auth.verifyTotp(secret, auth.totpAt(secret, step - 1), now));
  assert.ok(auth.verifyTotp(secret, auth.totpAt(secret, step + 1), now));
  assert.ok(!auth.verifyTotp(secret, auth.totpAt(secret, step + 3), now));
  assert.ok(auth.verifyTotp(secret, auth.totpAt(secret, step).replace(/(\d{3})/, '$1 '), now), 'spaces are ignored');
  assert.ok(!auth.verifyTotp(secret, '', now));
});

test('one-time login codes: single use, limited attempts, expiry', () => {
  const u = createUser();
  const code = auth.createLoginCode(u.id);
  assert.match(code, /^\d{6}$/);
  assert.ok(auth.consumeLoginCode(u.id, code));
  assert.ok(!auth.consumeLoginCode(u.id, code), 'cannot be reused');

  const code2 = auth.createLoginCode(u.id);
  const wrong = code2 === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.ok(!auth.consumeLoginCode(u.id, wrong));
  assert.ok(!auth.consumeLoginCode(u.id, code2), 'locked after 5 wrong attempts');

  const code3 = auth.createLoginCode(u.id);
  db.prepare('UPDATE login_codes SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1, u.id);
  assert.ok(!auth.consumeLoginCode(u.id, code3), 'expired');
});

test('requesting a new code invalidates the previous one', () => {
  const u = createUser();
  const first = auth.createLoginCode(u.id);
  const second = auth.createLoginCode(u.id);
  if (first !== second) assert.ok(!auth.consumeLoginCode(u.id, first));
  assert.ok(auth.consumeLoginCode(u.id, second));
});

test('throttling counts per key and resets', () => {
  for (let i = 0; i < 3; i++) assert.ok(!auth.throttled('t:a', 3));
  assert.ok(auth.throttled('t:a', 3));
  assert.ok(!auth.throttled('t:b', 3), 'other keys unaffected');
  auth.resetThrottle('t:a');
  assert.ok(!auth.throttled('t:a', 3));
});

test('cookie parsing', () => {
  assert.deepEqual(auth.parseCookies('a=1; sid=abc%3D; empty='), { a: '1', sid: 'abc=', empty: '' });
  assert.deepEqual(auth.parseCookies(undefined), {});
});
