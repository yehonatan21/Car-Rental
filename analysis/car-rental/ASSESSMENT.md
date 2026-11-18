# Car-Rental: modernization assessment

*Single-system assessment of `/home/user/car-rental` (commit `57c231c`, 2026-11-18). Case-Manager is out of scope.*

## Executive Summary

Car-Rental is a small, modern Node.js 22 / Express 5 web app (about 5,900 lines of production JavaScript and 4,500 lines of tests) for booking a shared car. It runs one Vercel deployment and one Turso database per client, with a master console that creates and manages those client sites.

It is not legacy code. The stack is current, `npm audit` is clean, and the test suite is strong: 286 tests run against both local SQLite and a hosted libSQL server.

The risk sits in two places:
- **Request path:** a **synchronous database adapter over the network**. Every Turso query blocks the server while it waits.
- **Account and console security:** gaps around who can take over which account. Three were rated high or critical, and six medium.

**Recommendation:** **refactor in place** (same stack). Fix the security findings first, then make the data layer asynchronous and run migrations once per deploy. No rewrite is warranted.

## System Inventory

Measured with the plugin's fallback method (`find` + `wc -l`, decision-keyword counts), because `scc`, `cloc` and `lizard` are not installed.

| Area | Files | Code lines (non-blank, non-comment) |
|---|---|---|
| `src/` (app) | 28 | 5,348 |
| `api/` (Vercel entry) | 1 | 72 |
| `scripts/` | 7 | 298 |
| `public/app.js` (browser) | 1 | 163 |
| **Production total** | **37** | **≈ 5,881** |
| `test/` | 33 | 4,504 |

Most complex files, by decision-keyword count (`if`/`for`/`while`/`case`/`catch`/`&&`/`||`/`?`):

| File | Lines | Decisions |
|---|---|---|
| `src/routes/admin.js` | 1,024 | 334 |
| `src/routes/master.js` | 820 | 325 |
| `src/routes/public.js` | 556 | 156 |
| `src/routes/manage.js` | 315 | 106 |
| `src/routes/user.js` | 366 | 102 |
| `src/master.js` | 294 | 89 |
| `src/server.js` | 276 | 84 |

### Technology fingerprint

- **Runtime:** Node.js ≥ 22.13 (`package.json` engines), CommonJS. CI tests on Node 22 and 24.
- **Web:** Express 5.3, server-rendered HTML through a tagged template with escaping by default (`src/views/html.js`), and a strict CSP. Uploads go through multer 2.5.
- **Data:** SQLite via `node:sqlite` locally, and libSQL/Turso via the `libsql` package in remote mode (`src/driver.js`). The schema and in-place migrations run at startup (`src/db.js`); `master_clients` is created in `src/master.js`. Uploaded files are stored as 1 MB chunks in the `files` table when the database is hosted (`src/storage.js`).
- **Integrations:**
  - SMTP through nodemailer 10.
  - Google OIDC with a relay through the main site (`src/google.js`).
  - The Turso Platform API and the Vercel REST API (`src/provision.js`).
  - An instance management API secured by bearer `MANAGE_TOKEN` (`src/routes/manage.js`).
  - Vercel Cron (`/internal/cron`).
- **Build and deploy:**
  - Vercel (`vercel.json`), with `api/index.js` as the entry and the build filter in `scripts/vercel-ignore-build.js`.
  - Docker images (`Dockerfile`, `Dockerfile.dev`).
  - GitHub Actions (`.github/workflows/ci-cd.yml`): lint, tests on Node 22 and 24, the hosted-libSQL suite, and Docker images.
- **Tests:** `node:test`, unit and end-to-end. CI requires at least 80 % line coverage of `src/`. Every functional domain has tests (see Architecture).

## Architecture-at-a-Glance

`src/server.js` is the composition root. All domains share one database handle and are coupled mainly through the `users`, `bookings` and `app_meta` tables. The diagram is in [`ARCHITECTURE.mmd`](ARCHITECTURE.mmd).

| # | Domain | Main files | Responsibility |
|---|---|---|---|
| 1 | Platform / runtime | `src/server.js`, `api/index.js`, `src/config.js`, `src/redirect-guard.js`, `vercel.json` | Middleware, security headers, sessions, CSRF, uploads, guards, health, cron, Vercel entry |
| 2 | Data layer | `src/db.js`, `src/driver.js`, `src/time.js` | Schema, migrations, seeds, settings, transactions, audit |
| 3 | Identity & access | `src/auth.js`, `src/google.js`, `src/bootstrap.js`, `routes/public.js` (auth part) | Passwords, sessions, email codes, resets, Google sign-in plus relay, registration, env admin |
| 4 | Booking engine | `src/bookings.js`, `routes/user.js` (calendar/booking), `views/calendar.js` | Eligibility, overlap and buffer, request/approve/cancel, blocks, history |
| 5 | Member self-service | `routes/user.js`, `routes/public.js` | Profile, license re-upload, policy acceptance |
| 6 | Instance administration | `routes/admin.js` | Dashboard, users, bookings, vehicle, policies, settings tabs, audit |
| 7 | Vehicle documents | `routes/documents.js` | Vehicle papers, expiry dates, driver-visible docs |
| 8 | Notifications & jobs | `src/mail.js`, `src/jobs.js` | SMTP, templates, .ics, reminders, expiry, clean-up |
| 9 | Branding, storage, views | `src/brand.js`, `src/storage.js`, `src/views/*`, `public/*` | Per-client look, file store, layout |
| 10 | Multi-tenant control plane | `src/master.js`, `routes/master.js`, `src/provision.js`, `routes/manage.js`, `scripts/new-client.js` | Console, provisioning, management API, suspension, SSO |

**Structural observations**
- **Single vehicle in practice:** the schema supports multiple vehicles (`vehicle_id`), but every route goes through `defaultVehicle()`, and nothing creates a second vehicle.
- **Dead schema:** the removed two-factor feature left `users.totp_*` and `sessions.needs_2fa` behind.
- **Schema in two places:** `master_clients` is defined outside `db.js`.

## Production Runtime Profile

No telemetry is available: no APM, and Vercel logs were not exported for this review, so there are no p50/p95/p99 figures.

One measured behaviour, from a test against `sqld` (the server Turso runs) on 2026-11-18:
- A transaction held over the remote `libsql` connection keeps other writers waiting.
- After about **5 s**, the server cancels the held transaction ("Transaction timed out") and lets the other write proceed.

Booking approval (`transaction()` in `src/db.js`) therefore cannot double-book, but under contention the approval fails with a 500 instead of retrying.

Suggested first telemetry: per-route latency and query count on `/admin`, `/master`, `/calendar` and approval, plus cold-start duration.

## Technical Debt (top 10, by remediation value)

| # | Finding | Evidence | Fix |
|---|---|---|---|
| 1 | Synchronous DB adapter: every Turso query blocks the event loop | `src/driver.js` (wrapLibsql); `src/server.js:95-98` makes 2-3 queries per request | Batch and join queries now; then move to async `@libsql/client` behind the `db` facade |
| 2 | Migrations and seeds run on every cold start (~20 remote statements) | `src/db.js:18-250`, `src/master.js:12-31`, `src/server.js:25` | `schema_version` in `app_meta`; migrate once per deploy |
| 3 | Scheduled jobs (including SMTP sends) run inside a user's request on Vercel | `src/server.js:79-88`, `src/jobs.js` | Cron-only, or fire-and-forget with a DB lease |
| 4 | Throttling is in memory and per instance, so the limit multiplies by the number of instances and resets on cold starts | `src/auth.js:130-139` | DB table `throttle(key, count, window_start)` |
| 5 | Set-password, create-user and invite logic copied 4-6 times, and the copies have drifted | `routes/admin.js:661-675`, `routes/manage.js:291-301`, `routes/master.js:725-738`, `routes/user.js:358` | A `users` service with one `validatePassword` |
| 6 | God route files mixing HTML, validation, SQL and mail | `routes/admin.js` (1,024 lines), `routes/master.js` (820) | Split by resource, move views to `src/views/*`, put logic in services |
| 7 | Synchronous scrypt and file I/O on the request path | `src/auth.js:11,19`, `src/storage.js:19-24` | `crypto.scrypt` (async), `fs.promises` |
| 8 | Uploads go through temp disk even when the database is hosted; leftover temp files on errors | `src/server.js:180-187`, `src/storage.js:17-26` | `memoryStorage` in remote mode; clean up in the error handler |
| 9 | Dead columns, and duplicated helpers whose copies already differ | `src/db.js:37-38,48`; `clean()` in 4 files; `fullName` in 3 | Versioned migration to drop them; `util/strings.js` |
| 10 | Hardcoded TTLs and limits, repeated by hand in UI text; placeholder vehicle seeded in production | `src/config.js:160`, `src/auth.js:78,96-98,131`, `src/db.js:248` | Make them configurable and build the UI text from config |

Also: the approval transaction fails under contention (see Runtime Profile), and a failed COMMIT followed by ROLLBACK replaces the original error.

## Security Findings

`npm audit --omit=dev`: **0 vulnerabilities**. No live credentials were found in the source: `.env` is local-only and git-ignored, and the demo password `Pa****` in `scripts/seed.js` and `scripts/tunnel.js` is public and refused in production. No `SECRETS.local.md` was needed.

| ID | Severity | CWE | Finding | Evidence | Fix |
|---|---|---|---|---|---|
| SEC-001 | **Critical** (only with `MASTER_CONSOLE=true`) | CWE-269 | Any admin of the site hosting the console can set the main admin's password (or block or demote them) and then take over the console. **Production exposure removed on 2026-11-18**, when the console moved to its own project; the code path remains. | `routes/admin.js:661-675, 546-559, 614-640`; `routes/master.js:63-69` | Refuse every action that targets the `ADMIN_EMAIL` account unless it's the main admin themselves; add a dedicated console role |
| SEC-002 | High | CWE-307 | The login throttle resets after *any* successful login (e.g. the attacker's own account), giving unlimited guessing. It is also per instance, and `X-Forwarded-For` can be spoofed when the app is exposed directly | `routes/public.js:80-84, 246-256`; `auth.js:129-139`; `server.js:28` | Per-account counters, reset only for the account that signed in, stored in the database |
| SEC-003 | High | CWE-287 | Account pre-hijacking: emails are never verified at registration. Console "sign in as manager", "add manager", Google linking and the `ADMIN_EMAIL` bootstrap all trust an existing account found by email, keeping a password the attacker chose | `routes/public.js:381-449, 359-372`; `routes/manage.js:139-154, 208-252`; `bootstrap.js:29-37` | Verify email before sign-in or matching; reset the password and sessions of unverified accounts before promoting them |
| SEC-004 | Medium | CWE-352 | Every multipart POST skips both the Origin and the token CSRF checks; routes without an upload never check | `server.js:171-176` | Origin check on all POSTs; multipart bypass only for an allowlist of upload routes |
| SEC-005 | Medium | CWE-639 | Any console admin (not only the main admin) can get a client's `MANAGE_TOKEN`: it's displayed, or sent to a URL the admin edited | `routes/master.js:284-287, 576-597`; `master.js:121-131` | Main admin only; pin client URLs through Vercel domains; per-request HMAC |
| SEC-006 | Medium | CWE-601 / CWE-346 | The Google relay also accepts `<vercel_project>.vercel.app`, an origin not proven to be the client's, so a sign-in code could be relayed to an attacker's host | `google.js:145-153`; `routes/public.js:329-339` | Exact origins only (confirmed through the Vercel API, or the allowlist); HMAC-signed relay state |
| SEC-007 | Medium | CWE-918 | Console admins can point client URLs at internal or loopback hosts (SSRF), with the bearer token attached | `master.js:90-103, 121-143` | Block private ranges in production; don't echo remote error text |
| SEC-008 | Medium | CWE-400 | Anonymous `/register` keeps uploads even when validation fails, with no rate limit; temp files are left behind on a CSRF 403 | `routes/public.js:401-430`; `server.js:156, 180-190` | Throttle registration; keep files only after validation passes; clean up on the 403 path |
| SEC-009 | Medium | CWE-522 | Secret sprawl: the console's SMTP password and Google secret are copied into every client; Turso tokens never expire; `MASTER_SECRET` falls back to being stored in the database | `master.js:191-207, 38-44`; `provision.js:75` | Per-client credentials or the relay only; token expiry; require `MASTER_SECRET` from the environment |
| SEC-010 | Low | CWE-538 | `clients/*.env` holds plaintext secrets, isn't in `.dockerignore`, and gets copied into the dev image | `scripts/new-client.js`; `.dockerignore`; `Dockerfile.dev:15` | Ignore `clients/`; `chmod 600` on every write |
| SEC-011 | Low | CWE-601 | Upload-error redirect follows the raw `Referer`; the HTTPS redirect uses the `Host` header | `server.js:239, 34` | `sameSiteReferer`; use `config.baseUrl` |
| SEC-012 | Low | CWE-208 | Cron secret compared with `!==`; login timing reveals which users exist | `server.js:72`; `routes/public.js:251` | `timingSafeEqual`; dummy scrypt for unknown users |
| SEC-013 | Low | CWE-248 | A malformed cookie causes a 500 on every request | `auth.js:55-62` | try/catch around `decodeURIComponent` |
| SEC-014 | Low | CWE-200 | `/healthz` reveals commit, branch and storage id; reset links are placed in the flash cookie | `server.js:55-64`; `routes/admin.js:637-639` | Trim `/healthz`; render links on the page instead |
| SEC-015 | Low | CWE-829 | Actions pinned to tags, not SHAs; SSH trust-on-first-use when known hosts aren't set; the CI downloads a `-pre` sqld package | `ci-cd.yml`; `.github/scripts/deploy.sh:28-33` | Pin SHAs; require known hosts; verify checksums |

Verified sound: parameterised SQL everywhere; HTML escaping and the CSP; session handling; scrypt password storage; reset and invite tokens; email login codes; `safeNext`; one-time SSO links; the management API token check; Google PKCE/state/nonce; file serving behind authorization; upload naming and type checks; provisioning input validation.

## Documentation Gaps (top 5)

1. **Google sign-in relay:** how client sites sign in through the main site (`GOOGLE_RELAY_URL`, `GOOGLE_RELAY_ALLOWED`, the state format, which origins are allowed). Only commit messages describe it.
2. **Management API contract:** the endpoints, payloads, errors and token derivation (`HMAC(MASTER_SECRET, "manage:<slug>")`) of `/api/manage/*`, and the consequence that renaming a slug or changing `MASTER_SECRET` cuts the console off.
3. **Transactions on Turso:** that `transaction()` spans several HTTP calls, the 5 s server timeout, and what happens under contention.
4. **Jobs on Vercel:** jobs run during user requests, the Hobby plan's cron runs once a day, and the effect on reminder timing and request latency.
5. **The single-vehicle assumption and the data model:** which tables belong to which domain, why `vehicle_id` exists but only `defaultVehicle()` is used, and the dead two-factor columns.

## Relative Scale

- **Size:** KSLOC = 5.881 (production code only).
- **COCOMO-II index:** 2.94 × 5.881^1.10 ≈ **20.6**.

These are relative size signals, used only to compare this system with others. They are **not** an estimate of how long modernization would take or what it would cost: the formula assumes traditional human-team productivity, which agentic transformation does not follow. For reference, a COBOL estate of 500 KSLOC scores about 2,800 on the same index.

## Recommended Modernization Pattern

**Refactor (in place, same stack).**

- **No rewrite or re-platforming is needed.** The stack (Node 22/24, Express 5, libSQL) is current and supported, `npm audit` is clean, and the per-client architecture is sound for a small number of clients. Its weaknesses are local and can be fixed with the existing tests as a safety net:
  - a blocking data adapter;
  - start-up migrations;
  - request-path jobs;
  - in-memory throttling;
  - duplicated user logic;
  - a few security gaps.
- **Suggested order:**
  1. Security fixes SEC-001 to SEC-006: account takeover, the throttle, CSRF and the relay.
  2. A `users` service plus a database-backed throttle.
  3. Run migrations once per deploy.
  4. An asynchronous data layer, then splitting `routes/admin.js` and `routes/master.js`.
- **Commands:** this pattern does not need `/modernize-transform` or `/modernize-reimagine`, and there is no version uplift pending for `/modernize-uplift`. The next useful command is **`/modernize-harden`**, which turns the security findings above into a reviewable patch.
