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
