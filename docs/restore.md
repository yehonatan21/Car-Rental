# Restoring a site's data

Each site has its own Turso database. Turso keeps point-in-time history for the plan's retention window, so a site
can be brought back to how it was at any moment in that window. A restore always goes into a **new** database; the
site is then pointed at it. Nothing is overwritten.

**Rehearsed** on 19/11/2026 (below): a point-in-time copy was readable after 12 seconds and matched the live database.

## Restore a site

Example: `lapidot`, back to 08:00 UTC on 19/11/2026.

1. **Make the copy** (Turso CLI, or the API call below it):
   ```bash
   turso db create car-rental-lapidot-restored --from-db car-rental-lapidot --timestamp 2026-11-19T08:00:00Z
   ```
   ```
   POST https://api.turso.tech/v1/organizations/<org>/databases
   { "name": "car-rental-lapidot-restored", "group": "default",
     "seed": { "type": "database", "name": "car-rental-lapidot", "timestamp": "2026-11-19T08:00:00Z" } }
   ```
2. **Check it** before switching: open it (`turso db shell car-rental-lapidot-restored`) and compare
   `SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM bookings; SELECT MAX(at) FROM audit_log;` with what you expect.
3. **Point the site at it:** in Vercel → the site's project → Settings → Environment Variables, set `LIBSQL_URL` to
   `libsql://<hostname of the new database>` and `LIBSQL_AUTH_TOKEN` to a new key for it
   (`turso db tokens create car-rental-lapidot-restored --expiration 53w`). Mark the key *Sensitive*. Redeploy.
4. **Check the site:** `/healthz` answers `ok`; sign in and look at the bookings.
5. **Afterwards:** keep the old database for a week in case something is missing, then delete it. In the console,
   update the client's database name (client page → details) so **Replace database key** works on the new one.

Signing in again is needed (sessions from after the restore point are gone), and e-mails sent after that point may be
sent again by the jobs.

## Restore drill (every 6 months)

Restore one site into a temporary copy from an hour ago, compare the row counts of `users`, `bookings`,
`audit_log` and `files` with the live database, record the time it took here, and delete the copy. No site is
touched.

| Date | Site | Point in time | Took | Result |
|---|---|---|---|---|
| 19/11/2026 | lapidot | 1 hour earlier (19:26 UTC) | 12 s until readable | users, bookings, action log and files identical to the live database (6 / 6 / 46 / 6); copy deleted |
