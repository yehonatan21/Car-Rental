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
