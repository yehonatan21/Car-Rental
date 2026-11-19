'use strict';
// Two server processes on one database, like two Vercel instances: two managers approving overlapping requests at
// the same moment, and automatic approval racing a second request for the same time. Exactly one booking wins.
const { db, createUser, inDays, startServer, Client, dataDir } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setSetting } = require('../../src/db');

let one, two;
function sharedInstance() {
  const env = { ...process.env, DATA_DIR: dataDir, HTTPS: 'false' };
  const child = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '../fixtures/shared-instance.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /LISTENING (\d+)/.exec(out);
      if (m) resolve({ base: `http://127.0.0.1:${m[1]}`, stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); }) });
    });
    child.once('exit', (code) => reject(new Error(`exited ${code}: ${out}`)));
  });
}

before(async () => {
  one = await startServer();
  two = await sharedInstance();
});
after(async () => {
  await two.stop();
  await one.close();
});

const pending = (userId, from, to) => db.prepare("INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status, kind, created_at) VALUES (1, ?, ?, ?, 'pending', 'booking', datetime('now','localtime'))")
  .run(userId, from, to).lastInsertRowid;

test('two managers on two instances approve overlapping requests at the same moment: one is approved, the other is told why', async () => {
  createUser({ role: 'admin', email: 'race-a@test.org' });
  createUser({ role: 'admin', email: 'race-b@test.org' });
  const a = new Client(one.base); await a.login('race-a@test.org');
  const b = new Client(two.base); await b.login('race-b@test.org');
  const x = pending(createUser().id, inDays(30, '09:00'), inDays(30, '12:00'));
  const y = pending(createUser().id, inDays(30, '10:00'), inDays(30, '13:00'));
  const results = await Promise.all([
    a.post(`/admin/bookings/${x}/approve`, {}, `/admin/bookings/${x}`),
    b.post(`/admin/bookings/${y}/approve`, {}, `/admin/bookings/${y}`),
  ]);
  for (const r of results) assert.ok([302, 303].includes(r.status), 'both answered, neither crashed');
  const statuses = [x, y].map((id) => db.prepare('SELECT status FROM bookings WHERE id = ?').get(id).status).sort();
  assert.deepEqual(statuses, ['approved', 'pending'], 'exactly one approved');
  const messages = [a.flash()?.text, b.flash()?.text].join(' | ');
  assert.match(messages, /הרכב תפוס|מתנגש/, 'the other manager is told the time is taken');
});

test('automatic approval: two requests for the same time sent at once to two instances, at most one approved', async () => {
  setSetting('auto_approve', 1);
  try {
    const u1 = createUser({ email: 'auto-race-1@test.org' });
    const u2 = createUser({ email: 'auto-race-2@test.org' });
    const c1 = new Client(one.base); await c1.login(u1.email);
    const c2 = new Client(two.base); await c2.login(u2.email);
    const body = { start: inDays(31, '09:00'), end: inDays(31, '11:00'), accept_rules: '1' };
    const [r1, r2] = await Promise.all([c1.post('/bookings/new', body, '/bookings/new'), c2.post('/bookings/new', body, '/bookings/new')]);
    for (const r of [r1, r2]) assert.ok(r.status < 500, 'no crash');
    const rows = db.prepare('SELECT status FROM bookings WHERE user_id IN (?, ?)').all(u1.id, u2.id).map((r) => r.status);
    assert.ok(rows.filter((s) => s === 'approved').length <= 1, `never two approved: ${rows}`);
    assert.ok(rows.length >= 1, 'at least one request was taken');
  } finally {
    setSetting('auto_approve', 0);
  }
});
