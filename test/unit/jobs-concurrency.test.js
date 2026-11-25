'use strict';
// The scheduled jobs send their e-mails a few at a time (src/pool.js), not one after another: a morning with many
// reminders must fit in one run on Vercel. Each reminder is still claimed just before its own e-mail, so a run that is
// cut off leaves the rest for the next run, and two runs at once never send one twice.
const { createUser, getBooking, db } = require('../helpers');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../src/config');
const mail = require('../../src/mail');
const { runJobs } = require('../../src/jobs');
const time = require('../../src/time');

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  db.exec("DELETE FROM booking_history; DELETE FROM bookings; DELETE FROM mail_outbox; DELETE FROM users WHERE role = 'user'");
});

/** n approved bookings starting within the pickup-reminder window. */
function pickups(n) {
  const u = createUser();
  return Array.from({ length: n }, (_, i) => Number(db.prepare(`INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status)
    VALUES (1, ?, ?, ?, 'approved')`).run(u.id, time.addMinutes(time.now(), 60 + i), time.addMinutes(time.now(), 300 + i)).lastInsertRowid));
}

test('pickup reminders go out 4 at a time, each claimed just before its own e-mail', async (t) => {
  const ids = pickups(10);
  let running = 0;
  let most = 0;
  const claimedAtFirstSend = [];
  const sent = [];
  t.mock.method(mail, 'pickupReminder', async (b) => {
    if (!sent.length) claimedAtFirstSend.push(db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE pickup_reminded = 1').get().n);
    most = Math.max(most, ++running);
    await tick(40);
    running -= 1;
    sent.push(b.id);
    return true;
  });
  const r = await runJobs();
  assert.equal(r.reminders, 10);
  // In parallel, never more than 4 at once. Counted, not timed: a wall-clock limit fails on a busy CI runner.
  assert.equal(most, 4, 'never more than 4 e-mails at once');
  assert.deepEqual([...sent].sort((a, b) => a - b), ids, 'every booking once');
  assert.ok(claimedAtFirstSend[0] <= 4, 'not every reminder is claimed up front');
  assert.ok(ids.every((id) => getBooking(id).pickup_reminded === 1));

  // A second run finds nothing to send.
  sent.length = 0;
  assert.equal((await runJobs()).reminders, 0);
  assert.equal(sent.length, 0);
});

test('two runs at the same moment: every reminder is sent exactly once', async (t) => {
  const ids = pickups(9);
  const sent = [];
  t.mock.method(mail, 'pickupReminder', async (b) => { await tick(10); sent.push(b.id); return true; });
  const [a, b] = await Promise.all([runJobs(), runJobs()]);
  assert.equal(a.reminders + b.reminders, 9);
  assert.deepEqual([...sent].sort((x, y) => x - y), ids);
});

test('the outbox is retried 4 at a time; a failure waits for its next attempt, the others are sent', async (t) => {
  let running = 0;
  let most = 0;
  const saved = config.smtp;
  // A mail server that takes 40 ms per message and refuses one address (a nodemailer transport object).
  config.smtp = {
    name: 'slow', version: '1',
    send(m, done) {
      most = Math.max(most, ++running);
      setTimeout(() => {
        running -= 1;
        if (m.data.to === 'refused@test.org') done(new Error('550 mailbox unavailable'));
        else done(null, { messageId: 'x' });
      }, 40);
    },
  };
  t.after(() => { config.smtp = saved; });
  t.mock.method(console, 'error', () => {});
  const add = (to) => db.prepare(`INSERT INTO mail_outbox (recipients, subject, message, status, attempts, next_attempt_at, created_at)
    VALUES (?, 'retry', ?, 'pending', 1, 0, ?)`).run(JSON.stringify([to]), JSON.stringify({ html: '<p>x</p>', text: 'x' }), time.stamp());
  for (let i = 0; i < 9; i++) add(`r${i}@test.org`);
  add('refused@test.org');

  const r = await mail.drainOutbox();
  assert.equal(most, 4);
  assert.equal(r.sent, 9);
  assert.equal(r.failed, 0);
  assert.equal(r.waiting, 1);
  const refused = db.prepare("SELECT * FROM mail_outbox WHERE recipients LIKE '%refused%'").get();
  assert.equal(refused.status, 'pending');
  assert.equal(refused.attempts, 2);
  assert.match(refused.last_error, /550/);
});
