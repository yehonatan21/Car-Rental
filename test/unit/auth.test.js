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

test('a new code does not cancel earlier ones (late e-mails still work); using one cancels all', () => {
  const u = createUser();
  const first = auth.createLoginCode(u.id);
  const second = auth.createLoginCode(u.id);
  const third = auth.createLoginCode(u.id);
  assert.ok(auth.consumeLoginCode(u.id, first), 'earlier code still valid');
  assert.ok(!auth.consumeLoginCode(u.id, second), 'all codes invalidated after a successful login');
  assert.ok(!auth.consumeLoginCode(u.id, third));
});

test('at most 3 codes are active per user', () => {
  const u = createUser();
  const codes = [1, 2, 3, 4].map(() => auth.createLoginCode(u.id));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE user_id = ?').get(u.id).n, 3);
  if (!codes.slice(1).includes(codes[0])) assert.ok(!auth.consumeLoginCode(u.id, codes[0]), 'oldest dropped');
  assert.ok(auth.consumeLoginCode(u.id, codes[3]));
});

test('codes are accepted with spaces or dashes', () => {
  const u = createUser();
  const code = auth.createLoginCode(u.id);
  assert.ok(auth.consumeLoginCode(u.id, ` ${code.slice(0, 3)}-${code.slice(3)} `));
});

test('wrong guesses are limited across all active codes', () => {
  const u = createUser();
  const a = auth.createLoginCode(u.id);
  const b = auth.createLoginCode(u.id);
  let wrong = 0;
  for (let i = 0; wrong < 5; i++) {
    const guess = String(i).padStart(6, '0');
    if (guess === a || guess === b) continue;
    assert.ok(!auth.consumeLoginCode(u.id, guess));
    wrong++;
  }
  assert.ok(!auth.consumeLoginCode(u.id, a), 'locked after 5 wrong guesses in total');
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
