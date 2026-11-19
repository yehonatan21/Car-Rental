# Performance report

*Measured 19/11/2026 on commit `565fc6d`.*

**What was measured:**
- **Live:** the four production sites and the console. Request timing from this session (outside Israel), the app's own `Server-Timing` header, and Lighthouse 12 on the public pages.
- **Local:** a database 10× larger than a busy real site: 2,005 users, 20,526 bookings over two years, 30,000 log rows (6.3 MB). Every page was timed on the server (best of 3), load-tested with autocannon (10 connections × 10 s, one process), and the hot queries were checked with `EXPLAIN QUERY PLAN`.

## Summary

| Area | State | |
|---|---|---|
| Public pages (browser) | **Excellent** | Lighthouse performance 100 on mobile and desktop; LCP 1.1 s mobile / 0.3 s desktop; 69 KiB per page; CLS 0; TBT 0–10 ms |
| Server, warm | **Excellent** | Login page: 0.5 ms on the server, 0 queries. Most signed-in pages: 1–40 ms even on the large database |
| Cold start | **Good** | First start after a deploy: 27–28 queries, ~150–270 ms of database time (runs the setup once). Later cold starts: 2–3 queries, ~25 ms database, 50–70 ms total |
| Hosted database | **Acceptable** | About 8 ms per query from Vercel (`fra1`) to Turso (Frankfurt), so page time ≈ number of queries × 8 ms + rendering. Pages make 2–9 queries |
| Network | Fine | From this session: ~150 ms to Vercel's CDN, ~250 ms for a page (the extra ~100 ms is the hop to the `fra1` function). Visitors in Israel are closer |
| **Reports page** | **Poor at scale** | 0.75 s for 30 days, **9.1 s for a year** on the large database (missing index plus an inefficient loop) |
| **Large lists and the month calendar** | **Poor at scale** | Dashboard 925 KB of HTML, bookings 774 KB, users 766 KB, month calendar 954 KB; month view only 28 req/s under load |
| Static files | Could be better | Served through the function, not cached at Vercel's edge (`x-vercel-cache: MISS`), browser cache only 1 hour |
| Approving a booking | Waits on email | The request waits for the approval emails to be sent over SMTP (not measured; typically 0.5–2 s with Gmail) |

## Measurements

### Live sites (`/login`, 6 requests each)

| Site | 1st request (cold) | Next requests | Server time, warm |
|---|---|---|---|
| car-rental | 0.83 s; 28 queries, 149 ms database | 0.26–0.52 s | 0.5–0.9 ms |
| gmach-car-biet-hagi | 1.67 s; 28 queries, 274 ms | 0.28–0.45 s | 0.6–2.1 ms |
| lapidot | 1.79 s; 28 queries, 200 ms | 0.25–0.47 s | 0.5–13 ms |
| console | 1.71 s; 27 queries, 218 ms | 0.27–0.36 s | 0.5–1.0 ms |

A burst of 24 parallel requests started new copies of the site: **2–3 queries, 25 ms database, 50–70 ms in total**. So skipping the database setup works; the 28 queries happen only on the first start after a deploy.

### Lighthouse (live, lapidot)

| Page | Device | Performance | FCP | LCP | TBT | CLS | Weight |
|---|---|---|---|---|---|---|---|
| `/login` | mobile / desktop | 100 / 100 | 1.0 / 0.3 s | 1.1 / 0.3 s | 10 / 0 ms | 0 | 69 KiB |
| `/register` | mobile / desktop | 100 / 100 | 1.1 / 0.3 s | 1.1 / 0.3 s | 0 ms | 0 | 71 KiB |
| `/` | mobile / desktop | 100 / 100 | 0.9 / 0.3 s | 1.1 / 0.3 s | 0 ms | 0 | 69 KiB |

Best practices score **96**: the only failure is a console error, because `/_vercel/insights/script.js` returns 404 (Web Analytics is not enabled on the projects).

**Page weight (brotli):** CSS 12 KB (49 KB raw), JS 10 KB (25 KB raw), Hebrew font 9 KB, Latin font 35 KB, HTML 2–3 KB.

### Large database, server time per page

| Page | Server | Database | Queries | HTML |
|---|---|---|---|---|
| `/admin` (dashboard) | 17 ms | 5 ms | 9 | **925 KB** |
| `/admin/bookings` | 30 ms | 22 ms | 3 | **774 KB** (500 rows) |
| `/admin/users` | 15 ms | 5 ms | 2 | **766 KB** (all 2,005, no paging) |
| `/calendar` (week) | 5 ms | 1 ms | 3 | 245 KB |
| `/calendar?view=month` | 37 ms | 3 ms | 3 | **954 KB** (a booking window for every booking) |
| `/admin/reports` 30 days | **750 ms** | 724 ms | 5 | 17 KB |
| `/admin/reports` 365 days | **9,107 ms** | 7,320 ms | 7 | 17 KB |
| `/admin/audit` | 2 ms | 0.5 ms | 2 | 109 KB (300 rows) |
| user `/calendar`, `/me/bookings`, `/bookings/new` | 0.5–2.6 ms | ≤1 ms | 3–6 | 9–45 KB |

### Load (one local process, 10 connections)

| Page | Requests/s | p50 | p97.5 | p99 |
|---|---|---|---|---|
| `/login` | 3,076 | 2 ms | 6 ms | 8 ms |
| user `/me/bookings` | 693 | 13 ms | 24 ms | 26 ms |
| user `/calendar` | 335 | 25 ms | 56 ms | 61 ms |
| admin `/admin` (925 KB) | 75 | 118 ms | 248 ms | 263 ms |
| admin month calendar (954 KB) | **28** | 319 ms | 697 ms | 1,188 ms |

### Other

- **Password check (scrypt):** 33–37 ms, synchronous, so nothing else runs on that instance meanwhile. It's the intended cost and only at sign-in.
- **Scheduled jobs:** 8 ms on the large database.
- **Function bundle:** the app plus libsql's Linux binary (19 MB of `node_modules/@libsql` on disk; only the glibc build is included).

### Query plans (missing indexes)

| Query | Plan | Effect |
|---|---|---|
| Report: when each request was answered (`booking_history` by `booking_id`) | correlated subquery, no index on `booking_history(booking_id)` | most of the report's 7.3 s |
| Dashboard: pending requests (`bookings.status`) | `SCAN bookings` | reads the whole table |
| A user's bookings (`bookings.user_id`) | `SCAN bookings` plus a temporary sort | reads the whole table |
| Calendar / conflicts (`vehicle_id, start_at < ?`) | uses `bookings_range`, but scans every earlier booking for `end_at` | fine now; grows with history |

## Recommendations (by effect)

| # | Change | Effect | Effort |
|---|---|---|---|
| 1 | **Indexes:** `booking_history(booking_id)`, `bookings(status, kind)`, `bookings(user_id, start_at)`, `audit_log(target_type, target_id)`, `sessions(user_id)` | Report 9 s → well under 1 s (with #2); dashboard and user pages stop scanning the table | Small, safe |
| 2 | **Reports:** answer times via one grouped join instead of a subquery per booking; usage per day in one pass over the bookings (not bookings × days) | Report under ~200 ms for a year | Small |
| 3 | **Paging:** users list and bookings list 50 per page; the dashboard shows the 10 oldest pending requests with "all requests →" | Pages from ~800 KB to ~40 KB; faster on phones | Medium |
| 4 | **Calendar windows on demand:** the month view renders the booking window only for pending requests (or loads it when clicked) | Month view ~950 KB → ~100 KB, about 10× more requests/s | Small–medium |
| 5 | **Static files:** versioned URLs (`?v=`) get `Cache-Control: public, max-age=31536000, immutable`, and Vercel edge caching (`CDN-Cache-Control`) | No function call per CSS/JS/font, faster repeat visits, lower Vercel usage | Small |
| 6 | **Approval emails after the response:** send them through the outbox (R1) or Vercel's `waitUntil`, so a manager's click doesn't wait for SMTP | Approve/reject answers in ~50 ms instead of seconds | Small |
| 7 | **Analytics script:** load `/_vercel/insights/script.js` only when Web Analytics is enabled on the project | Removes the console error (best practices 96 → 100) | Trivial |
| 8 | **Calendar range:** bound the scan from below (`start_at > from − max booking length`) | Calendar stays fast as history grows | Small |
| 9 | Async password hashing (`crypto.scrypt`) | Sign-ins no longer block other requests on the same instance | Small (R5.2 in the plan) |

Not recommended now: an asynchronous database layer (R5.4). Database time is small on every page except the report, and that is fixed by #1 and #2.

**Scale caveat:** the large-database figures use about 10× a busy real site (27 bookings a day on one car). At realistic volumes the list pages are about 80–100 KB and the report about 1 s for a year, but #1–#4 keep them fast as data accumulates.
