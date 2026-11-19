'use strict';
// The chief-of-staff agent (agent/): its scripts read a site's database read-only and never print personal data; its
// SDK options keep it to those scripts. The agent itself (the Claude API) is not called here.
const { createUser, inDays, db, dataDir } = require('../helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const AGENT = path.join(__dirname, '../../agent');
function script(name, ...args) {
  let out;
  try {
    out = execFileSync(process.execPath, ['--no-warnings', path.join(AGENT, 'scripts', name), ...args],
      { cwd: AGENT, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' });
  } catch (err) {
    out = err.stdout;
  }
  return JSON.parse(out);
}

test('scripts: overview, bookings, utilization and users read the site', () => {
  const u = createUser({ email: 'cos@test.org', first_name: 'אורי', last_name: 'כהן', phone: '0549998877' });
  const add = (day, from, to, status) => db.prepare("INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status, kind) VALUES (1, ?, ?, ?, ?, 'booking')")
    .run(u.id, inDays(day, from), inDays(day, to), status);
  add(-3, '08:00', '12:00', 'completed');
  add(2, '09:00', '10:00', 'pending');
  const o = script('overview.js');
  assert.ok(o.waiting.booking_requests.some((b) => b.user === 'אורי כהן'));
  assert.ok(o.last_30_days.booked_hours >= 4);
  const b = script('bookings.js', '--days', '7');
  assert.ok(b.totals.bookings >= 1);
  assert.ok(b.top_users.some((x) => x.user === 'אורי כהן'));
  const ut = script('utilization.js', '--days', '7');
  assert.ok(ut.booked_hours >= 4 && ut.utilization_pct > 0);
  const us = script('users.js');
  assert.ok(Array.isArray(us.top_users));
  assert.doesNotMatch(JSON.stringify([o, b, ut, us]), /0549998877/, 'no phone numbers anywhere');
});

test('sql.js: only one SELECT, never personal columns, SELECT * comes back without them', () => {
  createUser({ email: 'cos-sql@test.org', phone: '0541112233' });
  assert.match(script('sql.js', 'DELETE FROM users').error, /Only SELECT/);
  assert.match(script('sql.js', "SELECT 1; DELETE FROM users").error, /one statement/);
  assert.match(script('sql.js', 'WITH x AS (SELECT 1) DELETE FROM users').error, /could change data/);
  assert.match(script('sql.js', 'SELECT phone FROM users').error, /phone/);
  const r = script('sql.js', "SELECT * FROM users WHERE email = 'cos-sql@test.org'");
  assert.equal(r.count, 1);
  assert.equal(r.rows[0].phone, undefined);
  assert.equal(r.rows[0].id_number, undefined);
  assert.equal(r.rows[0].password_hash, undefined);
  assert.ok(db.prepare("SELECT 1 FROM users WHERE email = 'cos-sql@test.org'").get(), 'nothing was deleted');
});

test('agent options: the project folder only, read-only scripts, reports, no web, a budget', () => {
  const { optionsFor, parseArgs } = require(path.join(AGENT, 'agent.js'));
  const o = optionsFor(parseArgs(['--plan', '/weekly-report']));
  assert.equal(o.cwd, AGENT);
  assert.deepEqual(o.settingSources, ['project']);
  assert.equal(o.permissionMode, 'plan');
  assert.equal(optionsFor(parseArgs(['hi'])).permissionMode, 'dontAsk');
  assert.ok(o.allowedTools.includes('Bash(node scripts/*)'));
  assert.ok(!o.allowedTools.includes('Bash'), 'not every shell command');
  assert.ok(o.disallowedTools.includes('WebFetch'));
  assert.ok(o.maxBudgetUsd > 0);
  assert.equal(o.settings.outputStyle, 'executive');
});
