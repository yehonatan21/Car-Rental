'use strict';
require('../helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const time = require('../../src/time');

test('isValidLocal accepts only real "YYYY-MM-DDTHH:MM" times', () => {
  assert.ok(time.isValidLocal('2026-10-22T14:30'));
  assert.ok(!time.isValidLocal('2026-02-31T10:00'), 'non-existent date');
  assert.ok(!time.isValidLocal('2026-10-22 14:30'), 'space separator');
  assert.ok(!time.isValidLocal('2026-10-22T14:30:00'), 'seconds');
  assert.ok(!time.isValidLocal('2026-10-22T25:00'));
  assert.ok(!time.isValidLocal(''));
  assert.ok(!time.isValidLocal(undefined));
  assert.ok(!time.isValidLocal(['2026-10-22T14:30']), 'arrays from duplicated query params');
});

test('isValidDate', () => {
  assert.ok(time.isValidDate('2028-02-29'), 'leap day');
  assert.ok(!time.isValidDate('2026-02-29'));
  assert.ok(!time.isValidDate('2026-1-01'));
  assert.ok(!time.isValidDate(null));
});

test('Israel daylight-saving transitions are handled', () => {
  // DST starts Friday 27/03/2026 at 02:00 → 03:00, ends Sunday 25/10/2026 at 02:00 → 01:00.
  assert.ok(!time.isValidLocal('2026-03-27T02:30'), 'time inside the spring-forward gap does not exist');
  assert.equal(time.addMinutes('2026-03-27T01:30', 60), '2026-03-27T03:30');
  assert.equal(time.hoursBetween('2026-03-27T00:00', '2026-03-28T00:00'), 23);
  assert.equal(time.hoursBetween('2026-10-25T00:00', '2026-10-26T00:00'), 25);
  assert.equal(time.addDays('2026-03-26', 1), '2026-03-27');
  assert.equal(time.addDays('2026-10-25', 1), '2026-10-26');
});

test('addMinutes / addDays across month and year boundaries', () => {
  assert.equal(time.addMinutes('2026-12-31T23:30', 45), '2027-01-01T00:15');
  assert.equal(time.addMinutes('2026-03-01T00:10', -20), '2026-02-28T23:50');
  assert.equal(time.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(time.addDays('2026-01-01', -1), '2025-12-31');
});

test('now / today use the local format', () => {
  assert.ok(time.isValidLocal(time.now()));
  assert.ok(time.isValidDate(time.today()));
  assert.equal(time.now().slice(0, 10), time.today());
});

test('Hebrew formatting', () => {
  assert.equal(time.fmt('2026-10-22T14:30'), '22/10/2026 14:30');
  assert.equal(time.fmt('2026-10-22'), '22/10/2026');
  assert.equal(time.fmt('2026-10-22 09:05:33'), '22/10/2026 09:05');
  assert.equal(time.fmt(null), '');
  assert.equal(time.fmtLong('2026-10-22T14:30'), 'יום חמישי, 22/10/2026 14:30');
  assert.equal(time.fmtLong('2026-10-24T08:00'), 'יום שבת, 24/10/2026 08:00');
});
