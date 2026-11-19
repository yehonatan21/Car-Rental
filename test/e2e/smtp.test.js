'use strict';
// Real SMTP delivery (login codes, test e-mail, failures) against a minimal in-process SMTP server.
const { createUser, startServer, Client, inDays, db } = require('../helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const config = require('../../src/config');
const mail = require('../../src/mail');

let srv, smtp, smtpPort;
const received = []; // { from, to: [], data, user }
const ACCOUNT = { user: 'sender@test.org', pass: 'app-password' };

/** Just enough SMTP (EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA) for nodemailer. */
function startSmtp() {
  const server = net.createServer((sock) => {
    let msg = { to: [] };
    let mode = 'cmd';
    let buf = '';
    let loginUser = null;
    const reply = (line) => sock.write(line + '\r\n');
    const checkAuth = (user, pass) => {
      if (user === ACCOUNT.user && pass === ACCOUNT.pass) { msg.user = user; return reply('235 2.7.0 Authentication successful'); }
      reply('535 5.7.8 Username and Password not accepted');
    };
    reply('220 fake-smtp ready');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (mode === 'data') {
          if (line === '.') { received.push(msg); msg = { to: [], user: msg.user }; mode = 'cmd'; reply('250 2.0.0 queued'); } else msg.data = (msg.data || '') + line + '\n';
          continue;
        }
        if (mode === 'login-user') { loginUser = Buffer.from(line, 'base64').toString(); mode = 'login-pass'; reply('334 UGFzc3dvcmQ6'); continue; }
        if (mode === 'login-pass') { mode = 'cmd'; checkAuth(loginUser, Buffer.from(line, 'base64').toString()); continue; }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') { sock.write('250-fake-smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n'); }
        else if (cmd === 'HELO') reply('250 fake-smtp');
        else if (/^AUTH PLAIN /i.test(line)) {
          const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString().split('\0');
          checkAuth(user, pass);
        } else if (/^AUTH LOGIN/i.test(line)) { mode = 'login-user'; reply('334 VXNlcm5hbWU6'); }
        else if (cmd === 'MAIL') { msg.from = line; reply('250 OK'); }
        else if (cmd === 'RCPT') { msg.to.push(/<(.*)>/.exec(line)[1]); reply('250 OK'); }
        else if (cmd === 'DATA') { mode = 'data'; reply('354 go ahead'); }
        else if (cmd === 'RSET' || cmd === 'NOOP') reply('250 OK');
        else if (cmd === 'QUIT') { reply('221 bye'); sock.end(); }
        else reply('502 unknown');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const smtpConfig = (pass = ACCOUNT.pass) => ({
  host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true, auth: { user: ACCOUNT.user, pass },
  connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 3000,
});

before(async () => {
  smtp = await startSmtp();
  smtpPort = smtp.address().port;
  config.smtp = smtpConfig();
  srv = await startServer();
});
after(async () => {
  config.smtp = null;
  await srv.close();
  smtp.close();
});

test('login code is delivered by SMTP and works', async () => {
  createUser({ email: 'smtp-user@test.org' });
  const c = new Client(srv.base);
  const page = await c.post('/login/code', { email: 'smtp-user@test.org' });
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /הקוד מודפס בחלון השרת/, 'no development hint when SMTP is configured');
  const m = received.findLast((x) => x.to.includes('smtp-user@test.org'));
  assert.ok(m, 'delivered');
  assert.equal(m.user, ACCOUNT.user, 'authenticated');
  // Read the code from the base64 text part (the subject is RFC 2047-encoded).
  const body = Buffer.from(/Content-Transfer-Encoding: base64\n\n([\s\S]*?)\n\n/.exec(m.data)?.[1]?.replace(/\n/g, '') || '', 'base64').toString();
  const found = /(\d{6})/.exec(body)?.[1];
  assert.ok(found, 'code in the message');
  const r = await c.post('/login/code/verify', { email: 'smtp-user@test.org', code: found });
  assert.equal(r.location, '/calendar');
});

test('startup check reports a good SMTP login', async () => {
  await mail.verifyTransport();
  assert.equal(mail.status().verified, true);
});

test('wrong SMTP password: user is told the code was not sent; admin sees the reason', async () => {
  config.smtp = smtpConfig('wrong-password');
  try {
    createUser({ email: 'smtp-fail@test.org' });
    const r = await new Client(srv.base).post('/login/code', { email: 'smtp-fail@test.org' });
    assert.equal(r.status, 503);
    assert.match(r.text, /שליחת המייל נכשלה/);
    await mail.verifyTransport();
    assert.equal(mail.status().verified, false);

    const admin = createUser({ role: 'admin', email: 'smtp-admin@test.org' });
    const ac = new Client(srv.base);
    await ac.login(admin.email);
    const page = (await ac.get('/admin/settings')).text;
    assert.match(page, /Username and Password not accepted/);
    assert.match(page, /App password/);
    await ac.post('/admin/settings/test-email', {}, '/admin/settings');
    assert.match(ac.flash().text, /נכשלה/);
  } finally {
    config.smtp = smtpConfig();
  }
});

test('mail server unreachable: clear message, no long hang', async () => {
  config.smtp = { ...smtpConfig(), port: 9 };
  try {
    createUser({ email: 'smtp-down@test.org' });
    const t = Date.now();
    const r = await new Client(srv.base).post('/login/code', { email: 'smtp-down@test.org' });
    assert.equal(r.status, 503);
    assert.ok(Date.now() - t < 10000);
  } finally {
    config.smtp = smtpConfig();
  }
});

test('admin test e-mail is delivered', async () => {
  const admin = createUser({ role: 'admin', email: 'smtp-admin2@test.org' });
  const ac = new Client(srv.base);
  await ac.login(admin.email);
  await ac.post('/admin/settings/test-email', {}, '/admin/settings');
  assert.match(ac.flash().text, /מייל בדיקה נשלח אל smtp-admin2@test.org/);
  assert.ok(received.some((x) => x.to.includes('smtp-admin2@test.org')));
});

/** Decoded text of a received message (subjects are RFC 2047-encoded, bodies base64). */
const textOf = (m) => [...m.data.matchAll(/Content-Transfer-Encoding: base64\n\n([\s\S]*?)\n\n/g)]
  .map((x) => Buffer.from(x[1].replace(/\n/g, ''), 'base64').toString()).join('\n');

test('reservation: admin is e-mailed the pending request, client is e-mailed the approval', async () => {
  const admin = createUser({ role: 'admin', email: 'res-admin@test.org' });
  const client = createUser({ email: 'res-client@test.org', first_name: 'רינה' });
  const uc = new Client(srv.base);
  await uc.login(client.email);
  const start = inDays(6, '09:00');
  const r = await uc.post('/bookings/new', { start, end: inDays(6, '12:00'), purpose: 'סידורים', accept_rules: '1' });
  assert.equal(r.status, 200);
  const b = db.prepare('SELECT * FROM bookings WHERE user_id = ?').get(client.id);
  assert.equal(b.status, 'pending');

  const notice = received.findLast((x) => x.to.includes('res-admin@test.org'));
  assert.ok(notice, 'the admin got the pending-approval e-mail');
  assert.match(notice.from, /sender@test\.org|car-booking/);
  assert.match(textOf(notice), /הבקשה ממתינה לאישור מנהל/);
  const fromHeader = /^From: (.*)$/m.exec(notice.data)?.[1] || '';
  const fromName = fromHeader.replace(/\?=\s+=\?UTF-8\?B\?/gi, '?==?UTF-8?B?') // RFC 2047: no space between adjacent words
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, x) => Buffer.from(x, 'base64').toString('utf8'));
  assert.match(fromName, new RegExp(`${config.mailFromName}"? <`), 'sent with the sender name over SMTP');
  assert.ok(textOf(notice).includes(`/admin/bookings/${b.id}`));
  assert.ok(!received.some((x) => x.to.includes('res-client@test.org') && /אושרה סופית/.test(textOf(x))), 'no confirmation yet');

  const ac = new Client(srv.base);
  await ac.login(admin.email);
  await ac.post(`/admin/bookings/${b.id}/approve`, {}, `/admin/bookings/${b.id}`);
  const flash = ac.flash();
  assert.equal(flash.type, 'success');
  assert.match(flash.text, /נשלח מייל אישור אל res-client@test.org/);
  const confirmation = received.findLast((x) => x.to.includes('res-client@test.org'));
  assert.match(textOf(confirmation), /אושרה סופית/);
  assert.match(confirmation.data, /text\/calendar/, 'calendar invite attached');
});

test('approval when the mail server rejects the login: booking approved, admin told the e-mail failed', async () => {
  const admin = createUser({ role: 'admin', email: 'res-admin2@test.org' });
  const client = createUser({ email: 'res-client2@test.org' });
  const uc = new Client(srv.base);
  await uc.login(client.email);
  await uc.post('/bookings/new', { start: inDays(8, '09:00'), end: inDays(8, '11:00'), accept_rules: '1' });
  const b = db.prepare('SELECT * FROM bookings WHERE user_id = ?').get(client.id);

  config.smtp = smtpConfig('wrong-password');
  try {
    const ac = new Client(srv.base);
    await ac.login(admin.email);
    await ac.post(`/admin/bookings/${b.id}/approve`, {}, `/admin/bookings/${b.id}`);
    const flash = ac.flash();
    assert.equal(flash.type, 'warning');
    assert.match(flash.text, /שליחת מייל האישור אל res-client2@test.org נכשלה/);
    assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(b.id).status, 'approved');
    // Recorded in the database, so the settings page shows it even when served by another instance (Vercel).
    const logged = db.prepare("SELECT details FROM audit_log WHERE action = 'mail.failed' AND details LIKE '%res-client2@test.org%'").get();
    assert.ok(logged, 'failure written to the audit log');
    assert.match(logged.details, /^ההזמנה אושרה → res-client2@test.org: .*Username and Password not accepted/);
  } finally {
    config.smtp = smtpConfig();
  }
});

// ---------- The outbox: failed e-mails are retried, reminders go out once ----------
const jobs = require('../../src/jobs');
const outbox = (where = '1') => db.prepare(`SELECT * FROM mail_outbox WHERE ${where} ORDER BY id`).all();
function approvedBooking(email, hoursFromNow) {
  const u = createUser({ email });
  const start = new Date(Date.now() + hoursFromNow * 3600000);
  const local = (d) => require('../../src/time').toLocal(d);
  const id = db.prepare("INSERT INTO bookings (vehicle_id, user_id, start_at, end_at, status, kind) VALUES (1, ?, ?, ?, 'approved', 'booking')")
    .run(u.id, local(start), local(new Date(start.getTime() + 2 * 3600000))).lastInsertRowid;
  return { u, id };
}

test('a reminder that fails waits in the outbox and goes out when the mail server works again', async () => {
  const { id } = approvedBooking('retry-me@test.org', 3);
  config.smtp = smtpConfig('wrong-password');
  try {
    await jobs.runJobs({ by: 'cron' });
  } finally {
    config.smtp = smtpConfig();
  }
  const [row] = outbox(`key = 'pickup:${id}:' || (SELECT start_at FROM bookings WHERE id = ${id})`);
  assert.equal(row.status, 'pending', 'kept for a retry, not lost');
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /535|Authentication|Invalid login/i);
  assert.equal(db.prepare('SELECT pickup_reminded FROM bookings WHERE id = ?').get(id).pickup_reminded, 1);

  const before = received.length;
  await jobs.runJobs({ by: 'cron' });
  assert.equal(received.length, before, 'not before its retry time');
  db.prepare('UPDATE mail_outbox SET next_attempt_at = 0 WHERE id = ?').run(row.id);
  const r = await jobs.runJobs({ by: 'cron' });
  assert.ok(received.slice(before).some((m) => m.to.includes('retry-me@test.org')), 'sent on the retry');
  assert.ok(r.mail_sent >= 1);
  const after = outbox(`id = ${row.id}`)[0];
  assert.equal(after.status, 'sent');
  assert.equal(after.message, '{}', 'the content is not kept once sent');
  assert.equal(jobs.lastRun().by, 'cron');
});

test('the same reminder is sent once, even when asked twice', async () => {
  const { id } = approvedBooking('once@test.org', 3);
  const b = { ...db.prepare('SELECT b.*, u.first_name, u.email FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.id = ?').get(id), plate: '1', make: '', model: '' };
  const before = received.length;
  assert.equal(await mail.pickupReminder(b), true);
  assert.equal(await mail.pickupReminder(b), true);
  assert.equal(received.slice(before).filter((m) => m.to.includes('once@test.org')).length, 1);
});

test('a login code is never stored for a retry; a message gives up after 6 attempts and can be retried by hand', async () => {
  config.smtp = smtpConfig('wrong-password');
  try {
    await mail.loginCode({ email: 'code@test.org', first_name: 'x' }, '123456');
    assert.equal(outbox("recipients LIKE '%code@test.org%'").length, 0, 'codes expire: nothing kept');
    await mail.userApproved({ email: 'approved@test.org', first_name: 'x' });
    const [m] = outbox("recipients LIKE '%approved@test.org%'");
    assert.equal(m.status, 'pending');
    for (let i = 0; i < 6; i++) {
      db.prepare('UPDATE mail_outbox SET next_attempt_at = 0 WHERE id = ?').run(m.id);
      await mail.drainOutbox();
    }
    const done = outbox(`id = ${m.id}`)[0];
    assert.equal(done.status, 'failed');
    assert.equal(done.attempts, 6);
  } finally {
    config.smtp = smtpConfig();
  }
  // Settings → health shows it; "retry now" sends it.
  const admin = new Client(srv.base);
  createUser({ email: 'outbox-admin@test.org', role: 'admin' });
  await admin.login('outbox-admin@test.org');
  assert.match((await admin.get('/admin/settings?tab=health')).text, /id="jobs"[\s\S]*approved@test.org[\s\S]*שליחה חוזרת עכשיו/);
  const before = received.length;
  await admin.post('/admin/settings/outbox-retry', {}, '/admin/settings?tab=health');
  assert.ok(received.slice(before).some((m) => m.to.includes('approved@test.org')));
  assert.equal(outbox("recipients LIKE '%approved@test.org%'")[0].status, 'sent');
});

test('/internal/cron: only with the secret; answers with what it did', async () => {
  process.env.CRON_SECRET = 'c'.repeat(32);
  try {
    assert.equal((await fetch(srv.base + '/internal/cron', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const r = await fetch(srv.base + '/internal/cron', { headers: { authorization: `Bearer ${'c'.repeat(32)}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.reminders, 'number');
    assert.equal(body.sites, undefined, 'a client site runs only its own jobs');
  } finally {
    delete process.env.CRON_SECRET;
  }
});
