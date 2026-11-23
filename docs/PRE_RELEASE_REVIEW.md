# Pre-release review

*Reviewed 23/11/2026 on top of commit `9dc4ed5`.* Three parts: what has to be checked before a release (with this
code's own open points), the tests added to reach 100% line coverage, and where the code is slow. Part 3 is a report
only: nothing in it was changed.

## 1. What to address before a release

### General checklist

| Area | Before releasing |
|---|---|
| **Correctness** | Every test passes in **both** database modes (local file and hosted libSQL), plus the race test. Lint is clean. New behaviour has tests, and bugs that were fixed have regression tests |
| **Coverage** | Line coverage is enforced in CI. Branches the tests don't reach are known, and each one is either tested or judged safe |
| **Security** | `npm audit` is clean, there are no secrets in the repo, and CSRF, auth, upload and redirect checks are unchanged or reviewed. Error pages leak nothing |
| **Data** | Schema changes upgrade a copy of every client's database. A backup or restore point exists (`docs/restore.md`). A rollback path is known |
| **Configuration** | Every new environment variable is documented and set in every Vercel project. Defaults are safe when a variable is missing |
| **Operations** | Logs, error tracking, the health check and scheduled jobs work after deploy. Alerts reach someone |
| **Performance** | No new N+1 queries or unbounded lists. Cold start and p95 latency are not worse than the previous release |
| **Legal/content** | Policies, privacy text and e-mails are final, not drafts |
| **Release mechanics** | Version bumped, a tag and a changelog. A smoke test on one client before all of them (every push to `main` updates every site at once) |

### What this code base still needs

| # | Priority | Point | Status |
|---|---|---|---|
| 1 | **Blocker** | The **policy and privacy texts are marked as drafts** (README: "יש לעדכן אותם בהתאם להסדר הביטוחי ולייעוץ משפטי"). These are legal texts that users accept | Open: needs the owner and legal advice |
| 2 | **Bug (fixed)** | `npm start` on a port already in use crashed with `TypeError: Cannot read properties of null (reading 'port')` instead of the real error. Express 5 passes the listen error to the callback, which the code treated as success (`src/server.js` `start()`) | **Fixed**, with a test (`test/e2e/startup.test.js`) |
| 3 | High | **The "car in service" rule (decision D2) had no tests.** `test/helpers.js` mentions `test/e2e/vehicle.test.js`, but that file did not exist. The service banner, the "back in service" button, the plate check and automatic approval while in service were never run by a test | **Fixed**: `test/e2e/vehicle.test.js` |
| 4 | High | The release plan requires every test to pass against the hosted database too (`SQLD_BIN=… npm run test:libsql`) and `npm run test:race`. I couldn't run them here: this environment couldn't download `sqld`. CI runs both | Check that the CI jobs `test-libsql` and the race step are green before merging |
| 5 | Medium | Coverage now: **lines 100%**, functions 96.4%, branches 85.8%. The uncovered functions are small error-path callbacks (`.catch(() => [])`, `guarded()` fallbacks). The uncovered branches are mostly template ternaries | CI now fails under 100% lines. Branch coverage is a candidate for the next round |
| 6 | Medium | **No versioning.** `package.json` is `1.0.0`, and there are no tags and no changelog, although the release plan says "tag each release" | Open |
| 7 | Medium | Release plan R5 isn't done: the schema is still set up again whenever `src/db.js` changes (a hash of the file), not through numbered migrations | Open (planned) |
| 8 | Medium | `src/server.js` keeps a long-running server alive after `uncaughtException`. After an unknown error the process may be in a broken state. Not relevant on Vercel (it uses `api/index.js`), but it is relevant for `npm start` deployments | Consider logging the error and exiting under a supervisor |
| 9 | Low | The startup 503 page (`api/index.js`) shows the raw startup error (with tokens redacted) to any visitor. That can reveal the database host or the variable names | Consider showing the detail only in the logs |
| 10 | Low | `master.assertPublicDestination()` resolves the client's host name, and then `fetch` resolves it again. A DNS-rebinding host could answer differently the second time (time-of-check/time-of-use) | Pin the address resolved in the check, or accept the risk (only admins enter client addresses) |
| 11 | Low | When the console has no mail server, a new console admin's password link is shown in the flash message, which travels in a cookie (unsigned, httpOnly) | Acceptable, but showing the link only on the page would be cleaner |
| 12 | Note | Hosted driver: a read that fails as "stale" is prepared and tried again on the **same** connection. A new connection is opened only if preparing also fails (`src/driver.js` `read()`). With Turso preparing goes over the network too, so this is probably fine | Documented by a test in `test/unit/edge-cases.test.js` |
| 13 | Note | In tests, calling Node's `t.mock.property()` twice for the same property in one test makes the test runner exit silently with code 1 (Node 22) | Documented in `test/unit/edge-cases.test.js` |

Already in good shape: `npm audit` finds 0 vulnerabilities, lint is clean, the CI actions are pinned by commit, and
CSRF, Origin, upload-signature and redirect-loop guards are in place.

## 2. Tests added (100% line coverage)

Before: 375 tests, **97.09%** lines. After: 423 tests, **100%** lines (`npm run test:coverage`). CI and
`npm run test:coverage` now fail under 100% lines (they failed under 80% before).

| File | What it covers |
|---|---|
| `test/e2e/vehicle.test.js` | Car in service: refused requests, approvals and automatic approvals; approved bookings kept and listed; back to service; required plate; an empty car on a new site |
| `test/e2e/hosted-fake.test.js` + `test/fixtures/fake-libsql.js` | Hosted-database mode without sqld (a `libsql` stand-in backed by in-memory SQLite): opening it over HTTPS with the key, files stored in 1 MB chunks, the "database made for one deployment" warning in the log and on the settings page, the key's expiry |
| `test/e2e/startup.test.js` + `test/fixtures/{graceful,racing-schema}.js` | `node src/server.js`: what it prints, starting the jobs, surviving a stray error and rejection, a busy port (**the bug above**). The schema upgrade racing another instance (`duplicate column` / `no such column`) |
| `test/e2e/account-gaps.test.js` | Confirming identity with an e-mailed code; failed passkey answers; removing a passkey; the policy form without its box ticked; the availability check on a taken slot; too many sign-in codes; a reset e-mail that fails; the `ADMIN_EMAIL` account can't be deleted; only the owner sets another manager's password |
| `test/e2e/master-gaps.test.js` | Console: unknown client, a site that doesn't answer, key-expiry warnings, managers, a refused logo, key rotation, copying the mailbox (mixed success and failure), finding a site's address, client details, console admins, removing an admin's passkeys, the last console passkey, a health check-in that fails |
| `test/e2e/server-paths.test.js` | On Vercel: a failing visit-triggered job run doesn't break the visit. An unexpected page error gives a 500 page without details, and the error is recorded with its route |
| `test/unit/master-unit.test.js` | Production DNS checks before a token is sent (private v4/v6, mapped, empty, unknown host); the guessed `*.vercel.app` address; automatic mail sharing failing and waiting an hour before trying again |
| `test/unit/edge-cases.test.js` | `later()` with `waitUntil`; recording errors or mail when the database refuses; slow-request logging; malformed loop cookie; a bad Google relay state; push failures; passkey library rejections; a provider that doesn't answer; the job timer; a stale read retry |

## 3. Bottlenecks (report only, not fixed)

Measured locally from the app's own `Server-Timing` header (one user with 30 bookings). On the hosted database every
query is a network round trip of about **8 ms** from Vercel `fra1` to Turso (see `docs/PERFORMANCE_REPORT.md`), so
*queries × 8 ms* is roughly the database time in production.

| Page | Queries | | Page | Queries |
|---|---|---|---|---|
| `/me/bookings` (30 bookings) | **33** | | `/admin/settings?tab=reports` | 13 |
| `/me` | 12 | | `/admin`, `/admin/settings` | 10 |
| `/bookings/new` | 5 | | `/admin/users`, `/admin/bookings`, month calendar | 4–5 |
| Scheduled job run | 23 + mail | | `/login`, `/healthz` | 1 |

Ordered by expected impact:

1. **The hosted database driver is synchronous** (`src/driver.js`, the `libsql` package in remote mode). Every query
   blocks the Node event loop for a whole network round trip. A page waits *queries × ~8 ms*, and with Vercel Fluid
   concurrency every other request on the same instance waits as well. This is the root cause of most points below.
   Release plan R5.4 already plans to measure it and then move to `@libsql/client`.
2. **N+1 query on `/me/bookings`** (`src/routes/user.js:28`). `bookingRow()` calls `getSettings()` once per row, so
   the database is queried once per booking the user ever made, and the list has no paging (`user.js:228` loads every
   booking). That's about 0.26 s of database time in production for 30 bookings, and it keeps growing.
3. **Scheduled jobs send mail one message at a time** (`src/jobs.js` reminder loops, and `mail.drainOutbox()`). Each SMTP
   send takes 0.5–2 s and is awaited inside the loop. A morning with 20 reminders can take 10–40 s, against a 30 s
   `maxDuration` (`vercel.json`) and the console's 20 s timeout per site (`master.runAllJobs`). When a run is cut off,
   the claimed reminders still go out through the outbox, but late.
4. **A visit can wait for the whole job run** (`src/server.js`, the Vercel middleware). When no scheduled run happened
   for 30 minutes, the visitor's request awaits `runJobs()`, including its e-mails.
5. **The site status endpoint is heavy and called often** (`src/routes/manage.js` `status()` and `metrics()`). It runs
   about 25 queries one after another. It also scans the whole `files` table (`COUNT(DISTINCT name)`,
   `SUM(length(data))`), or runs `readdir` + `stat` on every upload. It is called for **every** client on every
   `/master` page load (`routes/master.js:334`, which waits for the slowest site, up to 6 s), on each client page,
   and on every 10-minute alert run (`alerts.js:134`).
6. **Stored files are read whole into memory** (`src/storage.js` `read()`). On the hosted database that means up to
   4–8 MB of 1 MB chunk rows, joined with `Buffer.concat`, for every view of a license or vehicle document. That
   costs memory, latency and Turso rows read.
7. **Synchronous scrypt remains in three handlers**: `routes/admin.js:854`, `routes/manage.js:358` and
   `routes/master.js:1064` (setting someone's password). The lazy dummy hash in `auth.verifyPasswordAsync()` is also
   synchronous. Each blocks the instance for about 35 ms.
8. **Periodic cleanups with no index** (`src/jobs.js`). `DELETE FROM audit_log WHERE at < ?` scans the whole table on
   every run, and `sessions`, `login_codes` and `password_resets` are scanned by `expires_at` the same way. The
   `users` status and `license_expiry` checks are also full scans. All of this runs every 10 minutes per site.
   `forgetIdentifiers()` (`src/db.js`) makes four `instr()` scans of `audit_log` for each deleted user.
9. **The same data is read again within one request**. `getSettings()` and the policy lookups run several times on
   one page (`/me` makes 12 queries). Login and code throttling (`auth.bump()`) takes two round trips (an upsert, then
   a select) where one `RETURNING` would do.
10. **Error recording writes to the database for each error** (`src/errors.js`). During an error storm (for example
    when the database is slow) this adds a write to every failing request.
11. **Cold start**: `src/db.js` reads and hashes its own source file to decide whether the schema is current, and the
    icons and asset hashes are read synchronously on first use. The first start after a deploy also runs about 27
    setup queries (already known and measured in `PERFORMANCE_REPORT.md`).
