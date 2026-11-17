'use strict';
require('../helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { html, raw, markdown, escape } = require('../../src/views/html');

test('html`` escapes interpolated values', () => {
  const evil = '<script>alert("x")</script>';
  assert.equal(String(html`<p>${evil}</p>`), '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>');
  assert.equal(String(html`<a title="${"' onmouseover='x"}">`), '<a title="&#39; onmouseover=&#39;x">');
});

test('html`` handles raw, nesting, arrays and empty values', () => {
  assert.equal(String(html`${raw('<b>ok</b>')}`), '<b>ok</b>');
  assert.equal(String(html`<ul>${['a', '<b>'].map((x) => html`<li>${x}</li>`)}</ul>`), '<ul><li>a</li><li>&lt;b&gt;</li></ul>');
  assert.equal(String(html`[${null}${undefined}${false}${0}${''}]`), '[0]');
});

test('escape covers all HTML-significant characters', () => {
  assert.equal(escape(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('markdown renders the policy subset', () => {
  const out = String(markdown('# כותרת\n\nפסקה **מודגשת**\nהמשך\n\n- א\n- ב\n\n> הערה'));
  assert.match(out, /<h2>כותרת<\/h2>/);
  assert.match(out, /<p>פסקה <strong>מודגשת<\/strong> המשך<\/p>/);
  assert.match(out, /<ul><li>א<\/li><li>ב<\/li><\/ul>/);
  assert.match(out, /<blockquote>הערה<\/blockquote>/);
});

test('markdown escapes HTML in the source', () => {
  const out = String(markdown('## <img src=x onerror=alert(1)>\n\n<script>bad()</script> **<i>x</i>**'));
  assert.doesNotMatch(out, /<img|<script|<i>/);
  assert.match(out, /&lt;script&gt;/);
});

test('style and script addresses carry a hash of the file, so a new version is never shown with a stale cached copy', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { layout: page } = require('../../src/views/html');
  const out = page({ path: '/', query: {} }, 'בדיקה', '');
  for (const name of ['style.css', 'app.js']) {
    const hash = crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, '..', '..', 'public', name))).digest('hex').slice(0, 10);
    assert.ok(out.includes(`/static/${name}?v=${hash}`), `${name} with its current hash`);
  }
});
