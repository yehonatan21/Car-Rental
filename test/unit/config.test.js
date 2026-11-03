'use strict';
// SMTP settings derived from environment variables (run in a child process, since config is read at startup).
require('../helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

function smtpFor(env) {
  const out = execFileSync(process.execPath, ['--no-warnings', '-e', 'console.log(JSON.stringify(require("./src/config").smtp))'], {
    cwd: path.join(__dirname, '..', '..'), env: { PATH: process.env.PATH, ...env }, encoding: 'utf8',
  });
  return JSON.parse(out);
}

test('no SMTP_HOST → no SMTP (e-mails go to the outbox)', () => {
  assert.equal(smtpFor({}), null);
});

test('port 465 implies TLS; 587 uses STARTTLS; SMTP_SECURE overrides', () => {
  assert.equal(smtpFor({ SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465' }).secure, true);
  assert.equal(smtpFor({ SMTP_HOST: 'smtp.example.org', SMTP_PORT: '587' }).secure, false);
  assert.equal(smtpFor({ SMTP_HOST: 'smtp.example.org' }).port, 587);
  assert.equal(smtpFor({ SMTP_HOST: 'smtp.example.org', SMTP_PORT: '465', SMTP_SECURE: 'false' }).secure, false);
});

test('Gmail app passwords may be pasted with spaces; other providers keep the password as is', () => {
  const gmail = smtpFor({ SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_USER: ' me@gmail.com ', SMTP_PASS: 'abcd efgh ijkl mnop' });
  assert.equal(gmail.auth.pass, 'abcdefghijklmnop');
  assert.equal(gmail.auth.user, 'me@gmail.com');
  const other = smtpFor({ SMTP_HOST: 'mail.example.org', SMTP_USER: 'u', SMTP_PASS: 'pass with spaces' });
  assert.equal(other.auth.pass, 'pass with spaces');
});

test('timeouts are set so a wrong host fails fast', () => {
  const c = smtpFor({ SMTP_HOST: 'smtp.example.org' });
  assert.ok(c.connectionTimeout <= 15000 && c.socketTimeout <= 30000);
});

test('sender address: MAIL_FROM, else the SMTP login (providers refuse other senders)', () => {
  const fromFor = (env) => JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e',
    'console.log(JSON.stringify(require("./src/config").mailFrom))'],
  { cwd: path.join(__dirname, '..', '..'), env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }));
  assert.equal(fromFor({ SMTP_HOST: 'smtp.gmail.com', SMTP_USER: ' car.app@gmail.com ' }), 'car.app@gmail.com');
  assert.equal(fromFor({ SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'car.app@gmail.com', MAIL_FROM: 'noreply@club.org' }), 'noreply@club.org');
  assert.equal(fromFor({ SMTP_HOST: 'smtp.sendgrid.net', SMTP_USER: 'apikey' }), 'car-booking@localhost', 'a login that is not an address');
  assert.equal(fromFor({}), 'car-booking@localhost');
});

test('sender name: MAIL_FROM_NAME, else the name in "Name <address>", else APP_NAME', () => {
  const sender = (env) => JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e',
    'const c = require("./src/config"); console.log(JSON.stringify([c.mailFromName, c.mailFrom]))'],
  { cwd: path.join(__dirname, '..', '..'), env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }));
  const gmail = { SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'gmach.car.bne.adam@gmail.com' };
  assert.deepEqual(sender({ ...gmail, MAIL_FROM_NAME: ' "גמח רכב בני אדם" ' }), ['גמח רכב בני אדם', 'gmach.car.bne.adam@gmail.com']);
  assert.deepEqual(sender({ ...gmail, MAIL_FROM: 'גמח רכב בני אדם <gmach.car.bne.adam@gmail.com>' }), ['גמח רכב בני אדם', 'gmach.car.bne.adam@gmail.com']);
  assert.deepEqual(sender({ ...gmail, APP_NAME: 'רכב הקהילה' }), ['רכב הקהילה', 'gmach.car.bne.adam@gmail.com']);
  assert.deepEqual(sender(gmail), ['הזמנת רכב', 'gmach.car.bne.adam@gmail.com'], 'never just the bare address');
});
