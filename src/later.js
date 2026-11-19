'use strict';
// Work that doesn't have to finish before the answer: the e-mails after an approval, a rejection, a cancellation or a
// new request. With SMTP they take 0.5–2 s, so on Vercel the page answers at once and the function is kept alive for
// them (waitUntil). A message that fails is kept in the outbox and retried by the jobs (mail.js). Without Vercel (a
// normal server, the tests) it is simply awaited, so nothing changes there and the result can still be shown.
const config = require('./config');

let waitUntil = null;
try {
  ({ waitUntil } = require('@vercel/functions'));
} catch { /* not installed: everything runs inline */ }

/**
 * Runs fn. Resolves to its result when it ran inline, or to undefined when it was left to finish after the response
 * (only on Vercel with SMTP: without SMTP the messages are only written locally, which is quick).
 */
async function later(fn, label = 'background work') {
  const p = Promise.resolve().then(fn).catch((err) => { console.error(`[later] ${label}:`, err); return undefined; });
  if (config.onVercel && config.smtp && waitUntil) {
    waitUntil(p);
    return undefined;
  }
  return p;
}

module.exports = { later };
