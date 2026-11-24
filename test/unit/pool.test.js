'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapLimit, mailConcurrency } = require('../../src/pool');

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('mapLimit: at most `limit` at a time, results in the items\' order', async () => {
  let running = 0;
  let most = 0;
  const out = await mapLimit([30, 5, 20, 1, 10, 2, 7], 3, async (ms, i) => {
    most = Math.max(most, ++running);
    await tick(ms);
    running -= 1;
    return `${i}:${ms}`;
  });
  assert.equal(most, 3);
  assert.deepEqual(out, ['0:30', '1:5', '2:20', '3:1', '4:10', '5:2', '6:7']);
});

test('mapLimit: an empty list, a limit below 1, and an error', async () => {
  assert.deepEqual(await mapLimit([], 4, async () => { throw new Error('never called'); }), []);
  assert.deepEqual(await mapLimit([1, 2], 0, async (x) => x * 2), [2, 4], 'a limit below 1 still runs one at a time');
  await assert.rejects(mapLimit([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error('two'); return x; }), /two/);
});

test('MAIL_CONCURRENCY: 4 by default, between 1 and 10', () => {
  const at = (v) => {
    if (v === undefined) delete process.env.MAIL_CONCURRENCY; else process.env.MAIL_CONCURRENCY = v;
    return mailConcurrency();
  };
  try {
    assert.equal(at(undefined), 4);
    assert.equal(at('2'), 2);
    assert.equal(at('50'), 10);
    assert.equal(at('-3'), 1);
    assert.equal(at('lots'), 4);
  } finally {
    delete process.env.MAIL_CONCURRENCY;
  }
});
