# Personal data: what is kept, who sees it, when it is deleted

Each client site has its own database (Turso) and its own files. Nothing is shared between sites.

| Data | Where | Who can see it | Kept until |
|---|---|---|---|
| Name, email, phone, ID number | `users` | The site's managers; the person themselves. The console's **main admin** can also find a user (by name, email or phone) and see their name, email and phone, to set them a new password | The account is deleted (Users → the user → "מחיקת המשתמש"). **A registration nobody approved or rejected is deleted after 90 days**, with its license photo |
| Driving license photo | Files (`uploads/` or the `files` table) | Managers only, never public. Every view is logged (`license.view`) | Replaced: deleted at once. Account deleted: deleted at once. **Registration rejected: deleted 30 days after the rejection** (the jobs). Abandoned sign-up: deleted when the 2-hour draft expires |
| Bookings and their history | `bookings`, `booking_history` | Managers; the person (their own); others see only "taken" | Deleted with the account |
| Action log | `audit_log` | Managers | **2 years** (names of deleted accounts are no longer shown) |
| Emails waiting to be resent | `mail_outbox` | Nobody in the app; managers see the subject and the address of failed ones | Content removed once sent; rows deleted after 60 days (sent) or 90 days (failed). Login codes and password links are never stored |
| Passkeys | `passkeys` | Nobody (only the public key, a name and dates; the private key never leaves the device) | Removed by its owner, a site owner, or with the account |
| Phone notifications | `push_subscriptions` | Nobody in the app (managers see nothing; the person sees how many devices) | Turned off on the device, signing out on it, signing out everywhere, a device the push service no longer knows, or the account deleted. Stored: the push service's address for the device and its public keys, a device name like "Android · Chrome" |
| Server errors | `error_log` | The console's admins (monitoring page) | **30 days** after it last happened. Only the kind of error, a shortened message with e-mail addresses, quoted values, long numbers and tokens removed, the page's path without ids or query, and where in the code. No user, no request data |
| Login sessions, codes, reset links | `sessions`, `login_codes`, `password_resets` | Nobody (only hashes are stored) | Their expiry (the jobs remove expired ones). A session ends after 14 days without a visit; a manager's after 8 hours |

**Rules in the code**
- ID numbers, phone numbers and license photos are not sent to any outside service, including analytics.
- The console sees each site's counts and its managers' names and emails. Only the console's main admin can look up a
  user (by name, email or phone), and then sees the name, email and phone, never the ID number or the license photo;
  every password set this way is in the site's action log (`manage.password_set`).
- Deleting an account also removes its name, email, phone and ID number from the action log (the entries stay, as
  "[נמחק]") and drops mail waiting for it.
- License photos are served only to managers, with `Cache-Control: no-store`, and are never linked publicly.
- Uploads must really be images or PDF files. The first bytes are checked, and anything else is deleted at once.

**Backups:** Turso keeps point-in-time history of each database for the plan's retention window. A deleted account can
therefore remain in that history until the window passes. The restore procedure is in [restore.md](restore.md).
