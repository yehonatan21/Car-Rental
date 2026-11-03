'use strict';
// The redirect-loop breaker: a browser bounced between pages is stopped with a page and a log line, well before the
// browser itself gives up with ERR_TOO_MANY_REDIRECTS (about 20 hops). Normal use (a few redirects, then a page) is
// never affected.
require('../helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const guard = require('../../src/redirect-guard');

/** A fake request/response pair that carries cookies from one hop to the next like a browser. */
function hop(jar, url) {
  const req = { method: 'GET', originalUrl: url, secure: true, cookies: { ...jar }, user: null };
  const res = {
    statusCode: 200, body: null, location: null,
    cookie(name, value) { jar[name] = value; return this; },
    clearCookie(name) { delete jar[name]; return this; },
    redirect(...args) { this.statusCode = typeof args[0] === 'number' ? args[0] : 302; this.location = args.at(-1); return this; },
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    send(body) { this.body = body; return this; },
  };
  guard.guard(req, res, () => {});
  return { req, res };
}

test('an endless redirect loop is stopped with a page and logged', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const jar = {};
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const { res } = hop(jar, i % 2 ? '/login?next=%2Fadmin' : '/admin/bookings/new?start=2026-11-04T14%3A10');
    res.redirect(i % 2 ? '/admin/bookings/new' : '/login?next=%2Fadmin');
    statuses.push(res.statusCode);
    if (res.statusCode === 508) {
      assert.match(res.body, /הדף לא נטען/);
      assert.match(res.body, /href="\/"/);
      break;
    }
  }
  assert.equal(statuses.length, guard.MAX + 1, 'stopped right after MAX redirects, long before the browser limit');
  assert.ok(statuses.slice(0, -1).every((s) => s === 302));
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /\[redirect-loop\] stopped after 8 redirects[\s\S]*\/login\?next/);
  assert.equal(jar[guard.COOKIE], undefined, 'and starts counting afresh');
});

test('normal use: a real page resets the count, so many separate redirects never trip it', () => {
  const jar = {};
  for (let i = 0; i < 30; i++) {
    const { res } = hop(jar, '/admin/settings/test-email');
    res.redirect('/admin/settings#email');
    assert.equal(res.statusCode, 302, `redirect ${i + 1}`);
    const page = hop(jar, '/admin/settings');
    guard.reset(page.req, page.res); // what res.page() does
  }
});

test('no extra HTTPS redirect from the app on Vercel (Vercel enforces HTTPS itself)', () => {
  const flags = (env) => JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e',
    'console.log(JSON.stringify(require("./src/config").forceHttps))'],
  { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }));
  assert.equal(flags({ NODE_ENV: 'production', VERCEL: '1', ALLOW_TEMPORARY_DATA: 'true' }), false);
  assert.equal(flags({ NODE_ENV: 'production' }), true, 'still on a normal server behind a proxy');
});
