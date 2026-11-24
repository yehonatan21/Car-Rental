'use strict';
// Runs async work on a list a few items at a time. The scheduled jobs send their e-mails this way: one SMTP send takes
// 0.5–2 s, so 20 reminders one after another could take longer than the 30 s a Vercel function may run, while
// sending all at once would open too many connections to the mail server (Gmail refuses after about 10).

/** How many e-mails go out at once (MAIL_CONCURRENCY, default 4). */
const mailConcurrency = () => Math.max(1, Math.min(10, Number.parseInt(process.env.MAIL_CONCURRENCY, 10) || 4));

/**
 * Calls fn(item, index) for every item, at most `limit` at a time, and resolves to the results in the items' order.
 * Like Promise.all, it rejects with the first error (fn is expected to handle its own failures).
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

module.exports = { mapLimit, mailConcurrency };
