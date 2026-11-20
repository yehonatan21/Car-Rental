'use strict';
// The console's monitoring: the hosting accounts (Turso, Vercel: plan, usage against its limits, balance) and the
// daily e-mail volume of the shared mailbox, with a verdict for each number: ok, warn (from 80%) or bad (from 95%).
// The sites' own numbers come with their status (routes/manage.js metrics()); this adds what only the console sees.
const provision = require('./provision');
const time = require('./time');

const env = () => process.env;
const fetchImpl = (...a) => globalThis.fetch(...a);

// Vercel's Hobby plan (free). Its API gives the usage but not the limits; these are the plan's published monthly
// limits (vercel.com/docs/limits). VERCEL_LIMITS='{"requests":…}' overrides them, e.g. on Pro.
const HOBBY = { requests: 1000000, invocations: 1000000, bandwidthBytes: 100e9, gbHours: 100 };
const vercelLimits = () => {
  try { return { ...HOBBY, ...JSON.parse(env().VERCEL_LIMITS || '{}') }; } catch { return HOBBY; }
};
// The shared mailbox's daily limit in recipients (Gmail: about 500 a day). MAIL_DAILY_LIMIT changes it.
const mailDailyLimit = () => Number(env().MAIL_DAILY_LIMIT) || 500;

/** ok / warn / bad for a share of a limit. */
const level = (used, limit) => (!limit ? 'ok' : used / limit >= 0.95 ? 'bad' : used / limit >= 0.8 ? 'warn' : 'ok');
const meter = (used, limit) => ({ used, limit, pct: limit ? Math.round((used / limit) * 1000) / 10 : null, level: level(used, limit) });

async function tursoAccount(names) {
  const { call, org } = provision.turso(env(), fetchImpl);
  const [o, sub, plans, inv, usage, ...each] = await Promise.all([
    call('GET', `/organizations/${org}`), call('GET', `/organizations/${org}/subscription`), call('GET', `/organizations/${org}/plans`),
    call('GET', `/organizations/${org}/invoices`), call('GET', `/organizations/${org}/usage`),
    ...names.map((n) => call('GET', `/organizations/${org}/databases/${encodeURIComponent(n)}/usage`).catch(() => null)),
  ]);
  const s = sub.data?.subscription || {};
  const quota = (plans.data?.plans || []).find((p) => p.name === s.plan)?.quotas || {};
  const u = usage.data?.organization?.usage || {};
  const perDb = Object.fromEntries(names.map((n, i) => [n, each[i]?.data?.database?.usage || null]).filter(([, u]) => u));
  const org_ = o.data?.organization || {};
  return {
    plan: s.plan || org_.plan_id || null,
    period: { start: s.current_billing_period_start || null, end: s.current_billing_period_end || null },
    balance: inv.data?.credit_balance ?? null,
    unpaidInvoices: (inv.data?.invoices || []).filter((i) => i.status && !['paid', 'void'].includes(i.status)).length,
    blocked: { reads: Boolean(org_.blocked_reads), writes: Boolean(org_.blocked_writes) },
    paymentFailing: Boolean(org_.payment_failing_since?.Valid),
    overages: Boolean(s.overages ?? org_.overages),
    meters: {
      rowsRead: meter(u.rows_read || 0, quota.rowsRead), rowsWritten: meter(u.rows_written || 0, quota.rowsWritten),
      storage: meter(u.storage_bytes || 0, quota.storage), databases: meter(u.databases || 0, quota.databases),
    },
    perDb,
  };
}

async function vercelAccount() {
  const { call, q } = provision.vercel(env(), fetchImpl);
  const from = `${time.today().slice(0, 8)}01T00:00:00.000Z`; // this calendar month (Hobby's limits are monthly)
  const to = new Date().toISOString();
  const [user, usage] = await Promise.all([
    call('GET', '/v2/user'),
    call('GET', `/v2/usage${q(`type=requests&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)}`),
  ]);
  const u = user.data?.user || {};
  const days = usage.data?.data || [];
  const sum = (k) => days.reduce((t, d) => t + (Number(d[k]) || 0), 0);
  const requests = sum('request_hit_count') + sum('request_miss_count');
  const invocations = sum('function_invocation_successful_count') + sum('function_invocation_error_count') + sum('function_invocation_timeout_count');
  const errors = sum('function_invocation_error_count') + sum('function_invocation_timeout_count');
  const bandwidth = sum('bandwidth_outgoing_bytes');
  const gbHours = sum('function_execution_successful_gb_hours') + sum('function_execution_error_gb_hours') + sum('function_execution_timeout_gb_hours');
  // Per project: each day's requests split by the share Vercel gives per project.
  const perProject = {};
  for (const d of days) {
    const dayRequests = (Number(d.request_hit_count) || 0) + (Number(d.request_miss_count) || 0);
    for (const p of d.breakdown?.requests || []) perProject[p.name] = (perProject[p.name] || 0) + Math.round((dayRequests * (p.percent || 0)) / 100);
  }
  const limits = vercelLimits();
  return {
    plan: u.billing?.plan || null,
    status: u.billing?.status || null,
    blocked: Boolean(u.softBlock),
    blockReason: u.softBlock?.reason || null,
    since: from.slice(0, 10),
    meters: {
      requests: meter(requests, limits.requests), invocations: meter(invocations, limits.invocations),
      bandwidth: meter(bandwidth, limits.bandwidthBytes), gbHours: meter(Math.round(gbHours * 1000) / 1000, limits.gbHours),
    },
    errors, errorRate: invocations ? Math.round((errors / invocations) * 1000) / 10 : 0,
    perProject,
  };
}

let cache = null;
const CACHE_MS = 5 * 60000;

/**
 * Both accounts, each { ok, data } or { ok: false, error } (a missing key or a failing API never breaks the page).
 * Cached 5 minutes per console instance; fresh: true asks again.
 */
async function accounts({ fresh = false, databases = [] } = {}) {
  const names = [...new Set(databases.filter(Boolean))].sort();
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS && cache.names === names.join()) return cache.value;
  const p = provision.providers(env());
  const one = async (configured, fn) => {
    if (!configured) return { ok: false, error: 'not_configured' };
    try { return { ok: true, data: await fn() }; } catch (err) { return { ok: false, error: err.message }; }
  };
  const [turso, vercel] = await Promise.all([one(p.turso, () => tursoAccount(names)), one(p.vercel, vercelAccount)]);
  const value = { at: new Date().toISOString(), turso, vercel };
  cache = { at: Date.now(), value, names: names.join() };
  return value;
}

/**
 * Verdicts for one site from its status (or null when it did not answer): response time, scheduled jobs, e-mail,
 * database key. Each { level, text }.
 */
function siteChecks(st, ms) {
  const d = st.online ? st.data : null;
  if (!d) return [{ level: 'bad', key: 'online', text: 'לא עונה' }];
  const out = [];
  out.push({ key: 'response', level: ms > 3000 ? 'bad' : ms > 1500 ? 'warn' : 'ok', text: `${ms} ms` });
  const m = d.metrics;
  if (m?.jobs) {
    // Stamps are in the app's time zone, the same on every instance (config sets TZ), so they parse as local time.
    const age = m.jobs.lastRun ? (Date.now() - new Date(m.jobs.lastRun.replace(' ', 'T')).getTime()) / 60000 : Infinity;
    out.push({ key: 'jobs', level: age > 180 ? 'bad' : age > 30 ? 'warn' : 'ok', text: m.jobs.lastRun ? `${Math.max(0, Math.round(age))} דק׳` : 'אף פעם' });
  }
  if (m?.errors) out.push({ key: 'errors', level: m.errors.new24h ? 'warn' : 'ok', text: m.errors.kinds24h ? `${m.errors.kinds24h} ב־24 שעות` : 'אין' });
  if (m?.mail) out.push({ key: 'mail', level: m.mail.failed || m.mail.today.failed ? 'warn' : 'ok', text: `${m.mail.today.recipients} היום` });
  const exp = d.storage?.keyExpiresAt;
  if (d.storage?.kind === 'hosted') {
    const days = exp ? Math.floor((new Date(exp) - Date.now()) / 86400000) : null;
    out.push({ key: 'key', level: days == null ? 'warn' : days < 0 ? 'bad' : days <= 30 ? 'warn' : 'ok', text: days == null ? 'ללא תפוגה' : `${days} ימים` });
  }
  return out;
}

module.exports = { accounts, siteChecks, meter, level, mailDailyLimit, vercelLimits, HOBBY };
