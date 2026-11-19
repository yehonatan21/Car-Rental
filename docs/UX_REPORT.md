# UI/UX report

*Reviewed 19/11/2026 on commit `885d945`.*

**How it was reviewed**
- **Every page, as every role:**
  - visitor: 7 pages
  - regular user (and a user waiting for approval): 11 pages
  - manager: 18 pages
  - console: 12 pages
- **Two sizes:** desktop (1280 px) and phone (390 px, touch), plus dark mode on three pages. 75 page views in all.
- **Checked by hand:** every screenshot, with the main journeys walked through:
  - registering
  - booking the car
  - cancelling
  - approving a request
  - checking a user
- **Measured automatically on each page:**
  - axe-core accessibility rules (WCAG 2.1 AA and best practice)
  - sideways scrolling
  - tap targets under 44 px
  - text under 12 px
  - headings

## Summary

| Area | Verdict |
|---|---|
| Visual consistency | **Good.** One design language everywhere (cards, badges, buttons, icons), correct right-to-left layout, dark mode that holds up |
| Phone layout | **Good.** No page scrolls sideways; bottom navigation for users and managers; tables become cards |
| Accessibility | **Good.** No axe issues on signed-in pages apart from unnamed table headers. One serious issue: unlabeled icons in the visitor's phone header |
| The main user task (booking) | **Needs work.** The date and time controls are fiddly on a phone and the return time starts equal to the pickup |
| The main manager task (approving) | **Fair.** It works, but on a phone the waiting requests sit below a screen of statistics and filters |
| Feedback | **Fair.** Good empty states and error summaries, but nothing shows that a form is being sent (uploads of up to 8 MB) |

The app is already in good shape: clear, consistent, accessible and fast. Most of the findings below concern the two everyday tasks on a phone, **booking** and **approving**, where a few changes would save real effort.

## What works well (keep)

- **Consistency:**
  - the same page header (icon, title, one-line explanation, main action) on every page
  - the same status badges and colors everywhere
- **Right to left:**
  - layout, arrows, the calendar and the tables all mirror correctly
  - numbers and email addresses keep left-to-right (`dir="ltr"`)
- **Phone navigation:**
  - four-item bottom bar for users (calendar, new booking, my bookings, personal area)
  - four-item bottom bar for managers (dashboard, bookings, calendar, users)
  - "•••" for the rest
  - the calendar opens in day view on a phone
- **Forms:**
  - an error summary at the top, plus the error at the field (`aria-invalid`)
  - a registration that fails keeps the uploaded license and the password
  - availability is checked live while choosing times
- **Empty states:** with an icon and a sentence ("אין הזמנות קרובות", no upcoming bookings; "עדיין אין פעולות ביומן", no actions logged yet), never a blank area.
- **Status first:**
  - a pending user sees why they can't book yet
  - expired licenses and car alerts sit on the dashboard
- **Dark mode:** readable throughout, with the same structure.
- **Performance:** Lighthouse 100 on public pages, and small pages since paging was added.

## Findings

Priority: **P1** affects an everyday task for many people; **P2** is a clear improvement; **P3** is polish.

### P1

| # | Where | Finding | Suggested change | Effort |
|---|---|---|---|---|
| U-1 | Visitor pages, phone | **The header shows three icons with no words** (rules, register, sign in). The sign-in icon looks like "exit", and screen readers announce the links with no name (axe *serious*, all 7 public pages) | Show "התחברות" (sign in) as a labeled button; put "הרשמה" (register) and "נהלים" (rules) in the "•••" menu, or show short labels under the icons as in the signed-in bottom bar | Small |
| U-2 | New booking (user and manager) | **Choosing times is fiddly on a phone:**<br>• the hour and minute pickers are 26 px wide<br>• each moment takes a date field plus a separate time field<br>• the return time starts at 09:00, the same as the pickup, so every booking needs four changes | • Make the time pickers full-width controls<br>• Set the return to pickup + 2 hours by default, and move it along when the pickup changes<br>• Add duration shortcuts: "שעתיים" (2 hours), "חצי יום" (half day), "יום שלם" (full day) | Medium |
| U-3 | Sign-in | **Two email fields on one page:** one for the password sign-in and one for the emailed code. People type their email in the wrong one or wonder which to use. There's also no "show password" | Use one email field with two buttons: "כניסה עם סיסמה" (sign in with password) and "שליחת קוד למייל" (email me a code); the password field stays above its button. Add a show/hide toggle | Small |
| U-4 | Dashboard, phone | **The waiting requests start below the first screen.** Four full-width statistic cards come first (each one row tall), then the car alerts | Show the four numbers as a compact 2×2 grid and the waiting requests right after them. Add a count badge on "הזמנות" (bookings) in the bottom bar when requests wait | Small |
| U-5 | Bookings list, phone | **The filters fill the first screen** (search, status, type, two dates, a button) before any booking appears | Put the filters behind a "סינון" (filter) button that opens them, and show which filter is active as a chip | Small |
| U-6 | Month calendar, phone | **Bookings are colored bars with no text,** and the day numbers are 28 px targets. Who and when is only visible after opening the day | • Make the whole day cell the tap target<br>• Under the month, list the bookings of the selected day (today by default)<br>• Keep the bars as a summary | Medium |

### P2

| # | Where | Finding | Suggested change | Effort |
|---|---|---|---|---|
| U-7 | Bottom bar, user chip, calendar | **Small text:**<br>• bottom bar labels 11.5 px<br>• the role under the user's name 11.8 px<br>• calendar hours 11.5 px<br>• month day headings 11.2 px | At least 12–13 px; the hour labels can shrink to "06" style instead of getting smaller | Small |
| U-8 | All forms, especially uploads | **Nothing shows that a form is being sent.** The button stays active, so a slow upload (license, up to 8 MB on a phone) looks frozen and invites a second tap | On submit: disable the button and show "שולח…" (sending) with a spinner; for uploads, show the file name and size | Small |
| U-9 | Personal area, phone | **Four big tiles repeat the bottom bar** (calendar, my bookings, license, security) and push down what matters | Show "ההזמנה הבאה שלך" (your next booking) with its time, status and cancel or details first; keep only the tiles that are not in the bar (license, security) as two small rows | Small |
| U-10 | User card (manager), desktop | **Four action boxes side by side,** each with its own note field (approve, reject, block, ask for a new license). Heavy, and the main action does not stand out | One note field, one primary button for the expected action (approve, for a pending user), the others as secondary buttons under it | Medium |
| U-11 | Settings tabs, phone | **The tab bar is cut off** ("מיילים ו…") with no hint that it scrolls | Wrap the tabs to two rows on a phone, or fade the edge to show there is more | Small |
| U-12 | Rules page; tables | **Structure for screen readers:**<br>• `/policy` has no main heading (axe)<br>• the action column of tables has an empty header (dashboard, bookings, my bookings) | Make the rules title an `<h1>`; give the action column a visually hidden header "פעולות" (actions) | Small |
| U-13 | Delete and cancel confirmations | **They use the browser's own confirm box:** unstyled, and its buttons may be in English ("OK/Cancel") | Use the app's own dialog (as the calendar already does) with "ביטול" (cancel) and a red action button that names the action ("מחיקת המשתמש", delete the user) | Medium |
| U-14 | Calendar, phone | **The week loads first and is then replaced by the day view** (a flash and a second page load) | Choose the view on the server: remember the last view in a cookie, and default to day view when the screen is narrow (from the previous visit) | Small |
| U-15 | Accessibility statement | **Placeholders show to the public:** "[יש להשלים: …]" (still to be filled in) | Fill in the coordinator details in Settings → General (waiting on you) | None |

### P3

| # | Where | Finding | Suggested change |
|---|---|---|---|
| U-16 | Footer links | The footer links are 16 px tall; easy to miss on a phone | More spacing between the links (24 px rows) |
| U-17 | Desktop header (manager) | Eight links plus the user chip on one row; at about 1024 px it gets tight | Group the less frequent ones (רכב, נהלים: car, rules) under הגדרות (settings), as was done with the reports |
| U-18 | Date fields | The format hint "DD/MM/YYYY" is in Latin letters | Keep it (it's widely understood), or use an example date "31/12/2026" |
| U-19 | Day view, phone | The day starts at 06:00; at night the grid shows a mostly past day | After 20:00, the day view could open on the next day |

## Automated checks (all 75 page views)

| Check | Result |
|---|---|
| Sideways scrolling | **None** on any page |
| axe, signed-in pages | **0** serious or critical issues; *minor*: empty table headers on 4 pages (U-12) |
| axe, public pages on a phone | **serious** `link-name` on all 7 (U-1); *moderate*: no `<h1>` on `/policy` (U-12) |
| axe, dark mode | **0** issues (contrast holds) |
| Tap targets under 44 px (phone) | Time pickers 26×43 (U-2), month days 28×28 (U-6), view switch "יום/שבוע/חודש" (day/week/month) 50–67×38, "בחירת קובץ" (choose file) 122×36, date picker button 38×39, footer links 16 px tall (U-16) |
| Text under 12 px | Bottom bar labels, role under the name, calendar hours and day headings (U-7) |

## Suggested order

1. **One small release for the everyday tasks:**
   - U-1: labeled header for visitors
   - U-3: one email field at sign-in
   - U-4: compact dashboard and a badge
   - U-5: filters behind a button
   - U-7: text sizes
   - U-8: "sending…"
   - U-11: settings tabs
   - U-12: headings and headers
2. **Booking on a phone:**
   - U-2: time pickers, default return, durations
   - U-6: month view with the day's list
   - U-14: no calendar flash
3. **Manager comfort:**
   - U-9: personal area with the next booking
   - U-10: user card actions
   - U-13: the app's own confirmation dialog
4. **Polish:** U-16 to U-19.
