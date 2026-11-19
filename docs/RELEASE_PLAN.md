# Car-Rental release plan

*From the external code review of 19/11/2026, checked against the code at commit `c2cbcdc`.*

Ship each release on its own: `main` → all client sites, then tag it (`v1.1`, …). Every item lists the files it
touches, what changes, and when it is done. An item is done only when its tests pass in **both** database modes
(`npm test`, plus `SQLD_BIN=… npm test` for the hosted database) and lint is clean.

## 0. What the review got right, and what is already out of date

| Review point | Checked in the code | Plan |
|---|---|---|
| AI agent can leak personal data through SQL aliases | True for that code, but the agent was **removed** (`da1628e`) | Closed. If it comes back, only fixed reporting queries, never free SQL (R6) |
| Reminders depend on a daily cron and on visits | **True**: `vercel.json` runs once a day (`0 5 * * *`); `server.js` also runs jobs at most every 15 minutes *during a visitor's request, which waits for them* | R1 |
| A failed email loses the reminder | **True**: `jobs.js` sets `pickup_reminded`/`return_reminded` before sending; `send()` catches and logs the failure | R1 |
| The database driver is synchronous; `scryptSync` and `readFileSync` block | **True** | Password hashing and file reads in R5. The database layer only if measurements show it's needed (R5) |
| Multipart forms skip the CSRF check (SEC-004) | **True**, still open | R2 |
| The console sends management tokens to any URL (SEC-005/007) | **True**, still open | R2 |
| The Google relay trusts `<project>.vercel.app` (SEC-006) | **True**, still open | R2 |
| Registration keeps uploads after failed validation (SEC-008) | **True**, still open | R2 |
| A car "in service" can still be booked | **True**: `checkVehicle()` refuses only `disabled` | R3 (needs a decision) |
| A placeholder car (`00-000-00`) is created on first start | **True** | R3 |
| Schema setup tied to a hash of `db.js` | True: added on 19/11 to cut a cold start from 22 queries to 1. Safe, because every setup step is idempotent, but numbered migrations are clearer | R5 |
| Leftover 2FA columns | True, three references; harmless | R6, low |
| Several deployment systems | True: Vercel, plus a Docker image on ghcr.io, plus `deploy.sh` over SSH, all in `ci-cd.yml` | R6 (needs a decision) |
| Route files mix responsibilities | True: `admin.js` is 1,106 lines | R5, one area at a time |

The three critical and high findings (SEC-001 to SEC-003) were fixed on 18/11. The review agrees, and they stay closed.

## Decisions (answered 19/11/2026)

D1 yes (GitHub schedule) · D2 "in service" blocks new requests, approvals and manual bookings · D3 photos of rejected
registrations are deleted after 30 days · D4 Vercel only · D5 (pickup/return) to be decided after R3.

---|---|---|---|
| D1 | May a GitHub Actions scheduled workflow call the console every 10 minutes? Vercel's free plan allows only one cron run a day. | R1 | Yes. It's free, and the console then runs the jobs of every site |
| D2 | Does "in service" (`service`) block new bookings, or only warn? | R3 | Block new requests; keep existing approved bookings and warn the manager about them |
| D3 | How long are license photos kept after an account is rejected or deleted, or a license is replaced? | R2 | Replaced: deleted at once (already the case). Rejected registration: 30 days |
| D4 | Keep the Docker and SSH deployment, or Vercel only? | R6 | Vercel only, unless a client really runs on their own server |
| D5 | Is the pickup/return check-in (odometer, fuel, photos, damage) wanted? | R4 | Decide after R3; it's the largest product item |

---

## R1: v1.1 Reminders that always go out *(P0)*: **done 19/11/2026** (`30b32b4`)

**Goal:** reminders and alerts are sent on time without anyone visiting the site, and a failed email is retried, never lost.

1. **Scheduled run independent of visits**
   - `.github/workflows/jobs.yml`: `schedule: */10 * * * *`, calls the console's `/internal/cron` with its `CRON_SECRET` (a GitHub secret).
   - `src/routes/manage.js`: a `POST /api/manage/run-jobs` endpoint, authorized by `MANAGE_TOKEN`.
   - `src/master.js`: the console's cron runs the jobs of every listed site through that endpoint, in parallel, each with a timeout, and logs a failure per site.
   - `vercel.json`: keep the daily cron as a backup.
2. **Email outbox with retries**
   - New table `mail_outbox` (`id`, `key` UNIQUE, `to`, `subject`, `body`, `status` pending/sent/failed, `attempts`, `next_attempt_at`, `last_error`, `created_at`, `sent_at`).
   - `jobs.js` claims a reminder and **queues** its email in the same transaction. The idempotency key looks like `pickup:<booking id>`, so a duplicate run queues nothing.
   - A sender drains the queue, retrying after 1, 5, 15 and 60 minutes, and marks the email `failed` after 6 attempts.
   - Approval and rejection emails try to send at once and fall back to the queue.
3. **No waiting during visits:** the in-request run (`server.js`) no longer delays a visitor's page. It's started with Vercel's `waitUntil`, or removed once (1) has worked for a week.
4. **Settings → system health:** show the time of the last run and how many emails are waiting or failed, with a "retry now" button.

**Done when:** a reminder 2 hours ahead goes out within 10 minutes of its time on a site nobody visits; with SMTP down, it goes out once SMTP is back, and only once.
**Tests:** SMTP failure, then retry; two job runs at the same time, one email; a duplicate key is ignored; the console fan-out with one site down.

## R2: v1.2 Security hardening, round 2 *(P0/P1)*: **done 19/11/2026** (`5791204`)

1. **SEC-004, CSRF on multipart forms** (`server.js`)
   - Check the Origin header on every POST, PUT, PATCH and DELETE, multipart included.
   - Check the CSRF token after multer on every upload route.
   - Delete the temporary upload file when the request is refused.
   - **Done when** a cross-site multipart POST is refused before anything is stored.
2. **SEC-007 and SEC-005, where the console sends tokens** (`master.js`)
   - Only `https://` addresses; no IP addresses, private ranges, `localhost` or single-label host names. The host must be one of the client's Vercel project domains or its registered URL.
   - The token is shown only to the main admin and never sent to an edited URL until that URL is checked.
3. **SEC-006, the Google relay** (`google.js`): forward only to origins in the console's client list or `GOOGLE_RELAY_ALLOWED`. No more inferred `<project>.vercel.app`.
4. **SEC-008, registration uploads** (`public.js`)
   - Throttle by network address, 10 an hour.
   - Validate the form before keeping the file, and delete the file on every failure path.
   - Check the file's real type from its first bytes (JPEG, PNG, WebP, HEIC, PDF).
5. **Low findings**
   - SEC-013: a malformed cookie is ignored instead of causing a 500.
   - SEC-012: the cron secret is compared in constant time.
   - SEC-011: the upload-error redirect only goes back to the site's own pages; the HTTPS redirect uses `BASE_URL`, not the Host header.
   - SEC-014: `/healthz` shows only `ok` unless the request has the cron secret.
6. **Personal data:** write down how ID numbers and license photos are stored, viewed (already logged) and deleted. Add the D3 clean-up to the jobs.

**Done when:** every SEC item is marked fixed in `docs/archive/analysis/car-rental/SECURITY_FINDINGS.md` and has a test; `/modernize-harden` finds no Medium item open.

## R3: v1.3 Booking rules that match reality *(P1)*: **done 19/11/2026**

1. **D2, the car in service** (`bookings.js`):
   - `checkVehicle()` refuses new requests and approvals while `status = 'service'`.
   - The vehicle page lists the approved bookings that fall in the service period, so the manager can contact those people.
   - "Back in service" is one button.
2. **First start without a fake car:** no `00-000-00` vehicle is created; until a car is entered, the admin dashboard shows "הוספת הרכב" (add the car) and booking is closed.
3. **Requests nobody handles:** escalation emails to every manager after `pending_alert_hours`, and again after twice that time, through the R1 queue.
4. **Concurrency tests on the hosted database:** two managers approving overlapping requests at the same moment; an automatic approval racing a new request; a transaction that times out.

**Done when:** the tests above pass in both modes, and a car in service can't be booked.

## R4: v2.0 Pickup and return (check-in / check-out) *(P1, only if D5 is yes)*

- `bookings`: `picked_up_at`, `returned_at`, `odometer_start` and `odometer_end`, `fuel_start` and `fuel_end`, and `damage_note`.
- New table `booking_photos`, using the existing storage.
- New status `active` (picked up). A booking becomes `completed` on return, not just because its end time passed. Late returns are flagged, and the manager is alerted after 30 minutes.
- Driver screens: "איסוף הרכב" (pick up the car) and "החזרת הרכב" (return the car) on the booking, phone-first, with photos taken by the camera.
- Manager screens: pickup and return details on the booking page; the late-returns list on the dashboard.

**Done when:** every booking from 01/2027 has a confirmed return, or a late-return alert.

## R5: v2.1 Structure and speed *(P1, no visible change)*

1. **Numbered migrations:** `src/db/migrations/001_initial.js`, … and a `schema_migrations` table. The current setup becomes migration 001, and existing databases are marked as being at 001. **Done when** an old production database copy upgrades cleanly, tested with a copy of each client's schema.
2. **Non-blocking password hashing and file reads:** `crypto.scrypt` with a promise instead of `scryptSync`; `fs.promises` in `storage.js`. Small and safe.
3. **Split `admin.js` by area,** one commit per area, tests green after each:
   - `routes/admin/{dashboard,users,bookings,vehicle,settings,audit}.js`;
   - the SQL and rules into `services/users.js` and `services/bookings.js` (bookings is already a module);
   - then the same for `master.js`.
4. **Asynchronous database layer: measure first.**
   - Collect `Server-Timing` and the `[slow]` log lines for two weeks.
   - Only if the database time is a real share of p95 latency: move to `@libsql/client` (async), keeping `BEGIN IMMEDIATE` for approvals.
   - This is the largest and riskiest refactor, so it's done only with evidence.

## R6: v2.2 Simplify and report *(P2)*: **done 19/11/2026** (the old 2FA columns were dropped with the file cleanup)

1. **D4:** if Vercel only, remove the Docker image, SSH deployment, `Dockerfile*`, `docker-compose*`, `Caddyfile` and `deploy.sh` from CI and the docs.
2. **Docs:** a short README (what it is, how to start, links); the details in `docs/`; `analysis/` moved to `docs/archive/` (done) once its open items are in this plan.
3. **Leftovers:** the 2FA columns are no longer read or written, and new databases don't have them. **Next release:**
   drop them from existing databases (`ALTER TABLE … DROP COLUMN`, guarded by `PRAGMA table_info`). It's a separate
   release so that a still-running older instance never meets a missing column during a deploy.
4. **Reports for managers** (the useful part of the removed agent, safely): an "דוחות" (reports) page with utilization, booked hours, idle days, busiest times, approval turnaround, cancellations, late returns (after R4) and the car's downtime. Fixed queries only, with no personal data in exports.

## Operations (alongside R1 and R2)

- **Backups:** confirm the Turso plan's point-in-time restore window for each database; write `docs/restore.md` and test one restore into a new database.
- **Alerts:** a failed scheduled run in GitHub Actions emails the owner; `[slow]` and `[jobs]` errors are visible in the Vercel logs.
- **Latency:** compute p50 and p95 of `Server-Timing` from the logs monthly, and after R5.

## Order and size

| Release | Main risk | Rough size | Depends on |
|---|---|---|---|
| R1 v1.1 | Medium (emails) | 1–2 days | D1 |
| R2 v1.2 | Low | 1–2 days | D3 |
| R3 v1.3 | Low | 1 day | D2 |
| R4 v2.0 | Medium (new flow) | 3–4 days | D5, R1 |
| R5 v2.1 | Medium (internal) | 2–3 days, plus measurement | – |
| R6 v2.2 | Low | 1–2 days | D4, R5.1 |

Not planned, as the review also advises: payments, a CRM, a rewrite, or a new framework.
