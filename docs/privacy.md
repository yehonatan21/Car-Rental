# Personal data: what is kept, who sees it, when it is deleted

Each client site has its own database (Turso) and its own files. Nothing is shared between sites.

| Data | Where | Who can see it | Kept until |
|---|---|---|---|
| Name, email, phone, ID number | `users` | The site's managers; the person themselves | The account is deleted (Users → the user → "מחיקת המשתמש") |
| Driving license photo | Files (`uploads/` or the `files` table) | Managers only, never public. Every view is logged (`license.view`) | Replaced: deleted at once. Account deleted: deleted at once. **Registration rejected: deleted 30 days after the rejection** (the jobs). Abandoned sign-up: deleted when the 2-hour draft expires |
| Bookings and their history | `bookings`, `booking_history` | Managers; the person (their own); others see only "taken" | Deleted with the account |
| Action log | `audit_log` | Managers | Kept (names of deleted accounts are no longer shown) |
| Emails waiting to be resent | `mail_outbox` | Nobody in the app; managers see the subject and the address of failed ones | Content removed once sent; rows deleted after 60 days (sent) or 90 days (failed). Login codes and password links are never stored |
| Login sessions, codes, reset links | `sessions`, `login_codes`, `password_resets` | Nobody (only hashes are stored) | Their expiry (the jobs remove expired ones) |

**Rules in the code**
- ID numbers, phone numbers and license photos are not sent to any outside service: not to analytics, and not to the console. The console sees only counts and managers' names and emails.
- License photos are served only to managers, with `Cache-Control: no-store`, and are never linked publicly.
- Uploads must really be images or PDF files. The first bytes are checked, and anything else is deleted at once.

**Backups:** Turso keeps point-in-time history of each database for the plan's retention window. A deleted account can
therefore remain in that history until the window passes. The restore procedure will be written in `docs/restore.md`.
