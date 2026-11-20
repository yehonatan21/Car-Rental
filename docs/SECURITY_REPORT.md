# Security report

*Reviewed 19/11/2026 on commit `8d0c3c6`: all four live sites and the console, the source code, the Vercel projects and
the GitHub workflows. Earlier pass: [archive/analysis/car-rental/SECURITY_FINDINGS.md](archive/analysis/car-rental/SECURITY_FINDINGS.md) (SEC-001 to SEC-015).*

**How it was checked**
- **Code review:** every route and its guard (85 routes), sign-in, sessions, codes, password links, Google sign-in,
  the console's management API, uploads, file serving, HTML and e-mail escaping, SQL, redirects, logging.
- **Attack tests against a local copy:** a regular user calling manager pages and actions, cancelling someone else's
  booking, posting without a token or from another site, script in names, redirects to other sites, a disguised
  upload, a 100,000-character name, sessions after logout and after a password change, sign-in timing.
- **Live sites:** security headers, exposed files, `/healthz`, the management API and cron without a key, Vercel's
  deployment protection and how secrets are stored.
- **Dependencies:** `npm audit`, production and development.

## Status: all findings fixed (19/11/2026, commit after `343c61c`)

| ID | Fix |
|---|---|
| S-01 | Every site's database key was **replaced** (the old never-expiring keys, and any copy of them, no longer work). New keys expire on 25/11/2027; each site reports its key's expiry, the console shows it on the client page and warns a month before, and **Replace database key** there makes a new one (tested against the database before it is saved). `SMTP_PASS` on `car-rental` is now *sensitive*; `ADMIN_PASSWORD` was removed from `car-rental` and the console. Still shared: the console's SMTP mailbox (a separate mailbox per client is a business choice) |
| S-02 | A manager's or console admin's right password is followed by a 6-digit code sent by e-mail (where SMTP is set); Google sign-in counts as both. `ADMIN_SECOND_STEP=false` turns it off |
| S-03 | Unknown addresses take as long as wrong passwords; registration gives one message for a taken e-mail **or** ID number, and only once the rest of the form is valid. (Registration can still confirm "one of the two is taken"; hiding even that needs an e-mail confirmation before the account exists) |
| S-04 | The 10,000 most common leaked passwords (also with a short ending, e.g. `Dragon2024!`) and passwords containing the person's name or e-mail are refused, everywhere a password is chosen |
| S-05 | Per account: 5 e-mailed codes and 3 reset links an hour, from any address; more are silently not sent |
| S-06 | Names 60 characters, purpose 200, notes and instructions 5,000, other fields 1,000, on every form |
| S-07 | `docs/privacy.md` now says what the console's main admin can see |
| S-08 | A session ends after 8 hours without activity for managers, 14 days for others; each visit extends it |
| S-09 | Registrations nobody approved or rejected for 90 days are deleted with their license photo; the action log keeps 2 years |
| S-10 | CSP adds `base-uri 'none'; object-src 'none'`; `Permissions-Policy` turns off camera, microphone, location, payment and USB |
| S-11 | The CI's actions are pinned to commit SHAs (Dependabot updates them). The pre-release `sqld` stays: it is only a test server in CI, pinned to an exact version |

**Service interruption during the key replacement:** each site was unavailable for about 30 seconds while it was
rebuilt with its new key; `lapidot`, the first, for a few minutes, because its first new key was refused by the
database. The console's button now tests every key before saving it.

## Cross-check with an external review (19/11/2026)

An external source review of `bcf35ed` (before the fixes above) listed the same S-01 to S-11 and four more points:

| Point | Status |
|---|---|
| A. Deleting a user left their name and e-mail in the action log | **Fixed:** deletion removes the person's name, e-mail, phone and ID number from every log entry (the entries stay, as "[נמחק]") and drops mail waiting for them; the deletion entry itself holds only the id and the booking count |
| B. The privacy document said the console never receives phone numbers | **Fixed:** the document says what the console's main admin sees (S-07); the console can no longer search users by ID number |
| C. "Sign in as manager" from the console was a GET link with side effects | **Fixed:** it is a form post with the session's token; the old address only shows the button |
| D. Administrator roles are broad (no owner / read-only roles) | **Fixed:** owner / manager / read-only on sites; main-admin-only actions on the console (below) |
| An e-mailed code is not a true second factor while code-only sign-in exists | **Fixed with passkeys:** an account with a passkey needs it on every way in; required for console admins (below) |
| Restore not demonstrated | **Done:** procedure in [restore.md](restore.md); drill run on 19/11/2026, a copy from an hour earlier was readable in 12 seconds and matched |
| GitHub branch rules, secret scanning, CodeQL; SMTP domain authentication (SPF/DKIM); monitoring of privilege changes | **Open:** repository and mail-account settings, outside the code |

**Decisions taken and done (19/11/2026)**
1. **Passkeys** (WebAuthn, `src/passkeys.js`), **switched off for now at the owner's request (20/11/2026)**: managers and
   console admins sign in with the password and an e-mailed code. `PASSKEYS=on` switches them back on. When on: any manager or console admin can add one; once an account has one,
   every way in (password, e-mailed code, Google) also needs it, so neither a stolen password nor a taken-over mailbox
   is enough. **Required for console admins.** Recovery: a site's owner or the console's main admin removes them;
   `PASSKEY_RESET` for the main admin.
2. **Roles:** site *owner* / *manager* / *read-only*; only an owner adds or removes managers, changes levels, deletes
   users, sets a manager's password or removes passkeys (a site without an owner works as before). On the console,
   deleting a client, replacing a database key and setting passwords are the main admin's alone.
3. **Confirming identity** (passkey, else password, else e-mailed code) before those actions when the last
   confirmation is more than 10 minutes old.

The findings as they were found:

## Summary

| Severity | Open |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 9 |

No way was found for an outsider or a regular user to read other people's data, act as a manager, or take over an
account. The two medium findings are about what happens **if a manager's password or a hosting key leaks**: there is
no second factor for managers, and the database keys never expire and are copied to many places.

## What held up (tested)

| Area | Result |
|---|---|
| Manager pages and actions as a regular user | All refused (403), including "block", "make admin" and the license photo |
| Another user's booking | Cancel refused; the calendar shows others only "תפוס" (taken), never names |
| Forged requests (CSRF) | Refused from another site (403), and without the session token |
| Script injection (XSS) | Names like `<script>` and `"><img onerror>` are escaped on every manager page and in e-mails. A strict CSP (`script-src 'self'`, no inline scripts) is a second barrier |
| SQL injection | Every query uses parameters. The few built queries use fixed table/column lists |
| Redirects after sign-in | Only to the site's own pages (`//evil.example` and `/\evil.example` are ignored) |
| Sessions | 256-bit random token, stored only as a hash; `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS. Logout and a password change end the session on the server (old cookie → 401) |
| Passwords | scrypt with a random salt, compared in constant time; now off the main thread |
| Sign-in limits | Per address and per account, kept in the database (shared by all server instances) |
| Codes and password links | Codes: 6 digits, 10 minutes, 5 wrong tries. Links: 256-bit, 1 hour, single use. Only hashes are stored |
| Google sign-in | PKCE, state and nonce; issuer, audience, expiry and verified e-mail checked; the relay forwards only to known client sites |
| Uploads | Only JPG/PNG/WEBP/HEIC/PDF, checked by the file's first bytes (an HTML page renamed `.png` is deleted); random names; licenses served only to managers with `no-store`, every view logged |
| Console ↔ sites | A 32+ character key per site, compared in constant time; the console only calls public HTTPS addresses |
| Live headers (all 4 sites) | CSP, HSTS (1 year), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: same-origin` |
| Exposed files | `/package.json`, `/.env`, `/src/…`, `/api/index.js` → 404. `/healthz` says only `ok`. Management API and cron without a key → 401 |
| Old deployments | Vercel Authentication protects every deployment address except the public one, so old code is not reachable |
| Dependencies | `npm audit`: **0 vulnerabilities** (production and development) |
| Earlier findings | SEC-001 to SEC-008 and SEC-011 to SEC-014 stay fixed. SEC-010 is moot: the Docker image and SSH deployment were removed |

## Findings

| ID | Severity | Finding | Effect | Recommendation |
|---|---|---|---|---|
| S-01 | **Medium** | **Secrets spread and never expire** (SEC-009, still open). Each site's Turso key is full-access and `expiration=never`; the console's SMTP password is copied into every site; on `car-rental` some secrets (`SMTP_PASS`, `SMTP_USER`, `SMTP_HOST`…) are stored as "encrypted", which team members can read in the Vercel dashboard, not "sensitive"; `ADMIN_PASSWORD` stays in the `car-rental` and console projects after first use | One leaked key gives the whole database of a site, for ever | Mark every secret "sensitive"; delete `ADMIN_PASSWORD` once the admin exists; rotate the Turso keys with an expiry (e.g. 1 year) and a reminder; give each site its own SMTP account or app password |
| S-02 | **Medium** | **No second factor for managers or the console.** A manager sees ID numbers, phones and license photos of every user; a console admin controls every site. Both are protected by a password (or an e-mailed code, or Google) only | A phished or reused password exposes all personal data | Require Google sign-in or an e-mailed code in addition to the password for managers and console admins (the 2FA removed earlier, in a simpler form) |
| S-03 | Low | **Who is registered can be found out.** Registration says "this e-mail already has an account" and "this ID number belongs to another account"; a password sign-in for a real account takes ~35 ms, for an unknown one ~3 ms | Confirms that a person (or an ID number) is a member; limited to 20 registrations an hour per address | Same message for both on registration ("check your details or sign in"); run a dummy password check for unknown addresses |
| S-04 | Low | **Weak passwords are accepted:** 8 characters minimum, no check against common passwords | `Password1` is allowed. Guessing is slowed by the per-account limit (10 per 15 minutes) | Refuse the ~10,000 most common passwords and passwords containing the e-mail or name |
| S-05 | Low | **No per-account limit on e-mailed codes and reset links**, only per network address (5 per 15 minutes) | From many addresses: a flood of e-mails to one person, and more code guesses (5 per 3 codes requested) | Also limit per account, e.g. 5 codes and 3 reset links an hour |
| S-06 | Low | **No length limits on text fields** (name, notes, purpose): a 100,000-character first name was accepted | Pages and e-mails to managers become huge; storage use | Limit names to 60 characters, notes and purpose to 1,000 |
| S-07 | Low | **The privacy page understates what the console sees.** `docs/privacy.md` says the console sees only counts and managers; its main admin can also list every user's name, e-mail and phone, and search by ID number | The privacy statement is inaccurate | Correct the document, or hide phone and ID-number search from the console |
| S-08 | Low | **Sessions last 14 days regardless of activity**, also for managers | A forgotten session on a shared computer stays signed in | Managers: end the session after 8 hours without activity; everyone: 14 days without activity rather than fixed |
| S-09 | Low | **Some data is kept with no end date:** the action log, and pending accounts that nobody approved or rejected (with their license photo) | More personal data than needed | Pending accounts: remind managers after 14 days, delete after 90; action log: keep 2 years |
| S-10 | Low | **Security headers could be tighter:** the CSP has no `base-uri`; no `Permissions-Policy`; HSTS without `includeSubDomains` (not needed on `vercel.app`, needed on a custom domain) | Defence in depth only | Add `base-uri 'none'; object-src 'none'` and `Permissions-Policy: camera=(), microphone=(), geolocation=()` |
| S-11 | Low | **CI supply chain** (SEC-015, partly open): GitHub actions pinned by tag, not commit; the CI downloads a pre-release `sqld` | Only CI is affected, not the live sites | Pin the actions by commit SHA (Dependabot can update them) |

**Information (no change needed now)**
- License PDFs open in the browser (`inline`) on the site's own address. Browsers show PDFs in an isolated viewer, and
  the CSP still applies.
- All managers of a site have equal rights, so any manager can remove another. That is by design; an "owner" role
  would be a product decision.
- Backups rely on Turso's point-in-time history; the restore procedure is in [restore.md](restore.md) (rehearsed 19/11/2026).

## Suggested order

1. **S-01** (an hour, mostly in Vercel and Turso): mark secrets sensitive, delete `ADMIN_PASSWORD`, rotate the Turso keys.
2. **S-02** second factor for managers and the console.
3. **S-03, S-04, S-05, S-06** in one small release (validation and limits; no visible change except messages).
4. **S-07, S-09** privacy: correct the document and add the retention jobs.
5. **S-08, S-10, S-11** hardening.
