# Car-Rental: security findings and remediation

*Hardening pass on `/home/user/car-rental` at commit `0043ca4` (2026-11-18). Case-Manager is out of scope.*

**Method:**
- **Findings:** from the code-modernization security auditor, scanning the code adversarially (assessment of the same day; only docs changed since). Every Critical and High finding was then confirmed by reading the cited code.
- **Patch:** written and tested in a separate worktree. The full suite passes on the patched copy: 291 tests, local SQLite and hosted libSQL (sqld).
- **Review:** an independent security auditor reviewed the patch in 2 rounds.

**Applied** to the source on 2026-11-18 (from [`security_remediation.patch`](security_remediation.patch)).

## Scorecard

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 2 |
| Medium | 6 |
| Low | 6 |
| **Total** | **15** |

**Top CWE categories:** CWE-269 Improper Privilege Management (2), CWE-307 Improper Restriction of Excessive Authentication Attempts, CWE-287 Improper Authentication, CWE-352 CSRF, CWE-601 Open Redirect (2).

**Hardcoded credentials:** none live. The public demo password in `scripts/seed.js` and `scripts/tunnel.js` is documented and refused in production, so no `SECRETS.local.md` or `.local.patch` was needed.

**Injection flags:** none. No instruction-shaped text aimed at automated analysis was found in the source.

## Findings

| ID | Severity | CWE | Finding | Evidence | Status |
|---|---|---|---|---|---|
| SEC-001 | **Critical** (when this site hosts the console: `MASTER_CONSOLE=true`) | CWE-269 | Any admin of the hosting site could set the main admin's password, send a reset link, demote or block them, and so take over the console and every client | `src/routes/admin.js` (`userAction`, `/admin/users/:id/password`) | **Patched.** Production exposure was also removed on 2026-11-18, when the console moved to its own project |
| SEC-002 | High | CWE-307 | The login throttle lived in memory per instance and reset for the whole IP after *any* successful login (e.g. the attacker's own), allowing unlimited guessing; there was no per-account limit | `src/auth.js:129-139`, `src/routes/public.js:80-84, 246-256` | **Patched** |
| SEC-003 | High | CWE-287 | Account pre-hijacking: emails are never verified at registration, and "add manager", the console's "sign in as manager", Google linking and the `ADMIN_EMAIL` bootstrap all promoted or linked an existing account found by email, keeping a password the attacker chose | `src/routes/manage.js` (`ensureAdmin`), `src/routes/public.js` (Google callback), `src/bootstrap.js`, `src/routes/master.js` (`POST /master/admins`) | **Patched** |
| SEC-004 | Medium | CWE-352 | Every multipart POST skips both the Origin and the token CSRF checks; routes without an upload never check | `src/server.js:171-176` | Open |
| SEC-005 | Medium | CWE-639 | Any console admin can get a client's `MANAGE_TOKEN`: it's displayed, or sent to a URL the admin edited | `src/routes/master.js:284-287, 576-597` | Open |
| SEC-006 | Medium | CWE-601 / CWE-346 | The Google relay also accepts `<vercel_project>.vercel.app`, an origin not proven to be the client's | `src/google.js:145-153` | Open |
| SEC-007 | Medium | CWE-918 | SSRF: client URLs may point at internal or loopback hosts, with the bearer token attached | `src/master.js:90-143` | Open |
| SEC-008 | Medium | CWE-400 | Anonymous `/register` keeps uploads even when validation fails, with no rate limit; temp files are left on a CSRF 403 | `src/routes/public.js:401-430`, `src/server.js:156` | Open |
| SEC-009 | Medium | CWE-522 | Secret sprawl: the console's SMTP password and Google secret are copied to every client; Turso tokens never expire; `MASTER_SECRET` can fall back to the database | `src/master.js:191-207`, `src/provision.js:75` | Open |
| SEC-010 | Low | CWE-538 | `clients/*.env` holds plaintext secrets and isn't excluded from the dev image | `scripts/new-client.js`, `.dockerignore` | Open |
| SEC-011 | Low | CWE-601 | Upload-error redirect follows the raw `Referer`; the HTTPS redirect uses the `Host` header | `src/server.js:239, 34` | Open |
| SEC-012 | Low | CWE-208 | Cron secret compared with `!==`; login timing reveals which users exist | `src/server.js:72` | Open |
| SEC-013 | Low | CWE-248 | A malformed cookie causes a 500 on every request | `src/auth.js:55-62` | Open |
| SEC-014 | Low | CWE-200 | `/healthz` reveals commit, branch and storage id; reset links are placed in the flash cookie | `src/server.js:55-64` | Open |
| SEC-015 | Low | CWE-829 | CI actions pinned to tags, not SHAs; SSH trust-on-first-use; the CI downloads a `-pre` sqld package | `.github/workflows/ci-cd.yml` | Open |

## Dependency CVEs

`npm audit --omit=dev`: **0 vulnerabilities** across 101 production packages (express 5.3.0, multer 2.5.0, nodemailer 10.6.0, libsql 0.5.29).

| Package | Installed | CVE | Fixed in |
|---|---|---|---|
| — | — | none | — |

## Remediation Log

Every hunk is in `security_remediation.patch`. There is no `.local.patch`, because no credentials needed removing.

| Finding | Proposed fix |
|---|---|
| SEC-001 | `protectsMainAdmin()` in `src/routes/admin.js`. When the site hosts the console, other managers can't change the `ADMIN_EMAIL` account: password (GET and POST), reset link, role, status and license actions. Emails are compared case-insensitively. |
| SEC-002 | Attempt counters move to a `throttle` table, shared by every server instance. Each attempt is counted before it's checked, so parallel requests can't slip under the limit, and a success gives its count back. `/login` allows 30 failures per network address and 10 per account (by user id) per 15 minutes; a success clears only that account's counter. `/login/code/verify` counts per address only, so a locked password never locks the emailed code. Old counters are purged by the jobs. |
| SEC-003 | `users.email_verified_at` records when the owner proved the address. That happens through a used login code, a reset or invite link **that was actually e-mailed** (`password_resets.delivered`), Google, the bootstrap `ADMIN_EMAIL`, or a Google registration; accounts already linked to Google count as proven. Before promoting or linking an account without that proof (`ensureAdmin`, the Google callback, the `ADMIN_EMAIL` re-promotion, `POST /master/admins`), `distrustUnverified()` removes its password, reset links and sessions. The real owner then sets a password through the invitation or signs in with Google. |
| SEC-004 to SEC-015 | Not in this patch: they are Medium or Low. See the findings table for the fix of each. Suggested next: SEC-004 (CSRF), SEC-006 (relay heuristic) and SEC-005. |

**Behaviour change to announce:** existing accounts start without proof of their address unless they're linked to Google. On the first Google sign-in, or if a console admin promotes such an account to manager, its password is removed. The user sees a message, and managers get an invitation link to set a new one.

## Patch Review

The independent security auditor reviewed the patch in a throwaway copy each round.

| File | Round 1 | Round 2 (final) |
|---|---|---|
| `src/auth.js` | INTRODUCES-RISK: check-then-act race on the counter | **RESOLVES** |
| `src/routes/public.js` | INTRODUCES-RISK: the account lock also blocked the emailed code; a shared IP was never released; unbounded counter keys; Google sign-ups not proven | **RESOLVES** |
| `src/db.js` | PARTIAL: no backfill | **RESOLVES** (Google-linked accounts backfilled; others documented above) |
| `src/bootstrap.js` | RESOLVES (suggested marking the `ADMIN_EMAIL` account proven) | **RESOLVES** |
| `src/routes/admin.js` | RESOLVES (nit: compare emails case-insensitively) | **RESOLVES** |
| `src/routes/manage.js` | RESOLVES | **RESOLVES** |
| `src/routes/master.js` | not covered: still promoted without distrust | **RESOLVES** |
| `src/jobs.js` | RESOLVES | **RESOLVES** |
| `test/e2e/hardening.test.js`, `test/e2e/manage.test.js` | RESOLVES | **RESOLVES** |

No hunk was dropped, and no raw credential values are in the patch.

**Residual risks** (not fixed by this patch; the reviewer found nothing blocking):
1. **Targeted lockout:** about 10 bad passwords per 15 minutes block an account's *password* sign-in. The code, Google and forgot-password routes still work, but without SMTP in production only Google remains.
2. **Spoofable IP:** `trust proxy 1` (`src/server.js:28`) makes per-IP limits bypassable when the app isn't behind a proxy that overwrites `X-Forwarded-For`. Vercel and the Caddy setup are fine.
3. **Login codes per account:** there's no limit on how many codes can be requested for one account (per-IP only). Add a per-account limit on issuing codes.
4. **Existence oracle:** the per-account 429 reveals that an account exists, as registration already does.
5. **Password change:** `/me/security` doesn't throttle the current-password check. It needs a session.
6. **Existing `ADMIN_EMAIL` account:** one created before this patch isn't backfilled. Its first Google link removes the password, with a message explaining it.
