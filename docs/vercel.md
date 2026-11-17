# Deploying on Vercel

The app runs on Vercel as a single serverless function (`api/index.js`, routed by `vercel.json`).

Vercel functions have **no lasting disk**: anything written to files is gone on the next deploy or restart.
To keep users, bookings and license images across new versions, connect a hosted **Turso (libSQL) database**.
The app then stores everything there, license images included. Turso has a free plan.
Without it the app **does not start** on Vercel: every page explains that no database is connected. (On Vercel each
server instance has its own temporary disk, so without a shared database logins break and everything vanishes with each
new version.) For a throwaway demo on purpose, set `ALLOW_TEMPORARY_DATA=true`; every page then shows a "demo" banner.

### Important: one permanent database, not one per deployment
The Vercel Turso integration can be set up to create a **new, empty database for every deployment** (its name starts
with `dpl-<deployment id>-vercel-icfg-`). Then nothing carries over to the next version, and while two deployments
answer at once, logins bounce between them. The admin dashboard and **Settings → מערכת ונתונים** warn about this, and
the log says `WARNING: this is a separate database created for this one deployment`.

Fix: use one database of your own and give the app its address in **`LIBSQL_URL` / `LIBSQL_AUTH_TOKEN`**. These are never
touched by the integration and take priority over `TURSO_DATABASE_URL`:
1. On [app.turso.tech](https://app.turso.tech) create a database (e.g. `car-rental`, region Frankfurt
   `aws-eu-central-1`, close to Vercel's `fra1`). Copy its URL (`libsql://car-rental-<org>.aws-eu-central-1.turso.io`) and
   create a token (Read & Write, no expiration).
2. Vercel → Settings → Environment Variables, **Production** only: `LIBSQL_URL` = the URL, `LIBSQL_AUTH_TOKEN` = the token
   (Sensitive). For dev, a second database the same way, **Preview** only.
3. Optional: in Vercel → Integrations → Turso → Manage, remove this project, so no more per-deployment databases are created.
4. Redeploy. Settings → מערכת ונתונים should show the new host "(מתוך LIBSQL_URL)", and its database id must stay the
   same after the next deployment.

If you connected Turso through the Vercel integration with a custom prefix (e.g. `STORAGE_TURSO_DATABASE_URL`), the app
finds those variables too. The deployment's **Logs** show which one it uses: `[db] hosted database <host> (from …)`.

## Set up

1. Import the GitHub repository in Vercel (**Add New → Project**). `vercel.json` sets everything else.
   If the project was created earlier with the **Express** framework preset, that's fine: `vercel.json` overrides it.
2. **Create the database (keeps your data):**
   - **Easiest:** in the Vercel project, open **Storage → Create Database / Browse Marketplace → Turso**, create a
     database on the free plan, and **connect it to this project**. Vercel then adds `TURSO_DATABASE_URL` and
     `TURSO_AUTH_TOKEN` to the project's environment variables by itself.
   - **Or manually:** sign up at [turso.tech](https://turso.tech), create a database, copy its URL
     (`libsql://<name>-<org>.turso.io`), and create a token. Then add both as environment variables (step 3).
   - Pick a database region close to the Vercel function region (**Settings → Functions → Region**), e.g. Frankfurt
     for both. Every page makes several database queries, so a short distance keeps it fast.
3. **Settings → Environment Variables**, then add:

   | Name | Value | Why |
   |---|---|---|
   | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | from Turso (added automatically by the integration) | **Data survives new versions** |
   | `ADMIN_EMAIL`, `ADMIN_PASSWORD` | your e-mail, a strong password (8+ characters) | Creates the first admin (there is no terminal on Vercel). Never overwrites an existing account |
   | `CRON_SECRET` | a long random string | Lets Vercel Cron run the daily jobs (reminders, license expiry) |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | e.g. Gmail (see README) | Optional: real e-mails |
   | `MAIL_FROM_NAME` | e.g. `גמח רכב בני אדם` | The sender name shown in inboxes (default: `APP_NAME`) |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from Google Cloud Console | Optional: sign in with Google |
   | `BASE_URL` | e.g. `https://car-rental.vercel.app` | Optional: defaults to the production domain (production) or the branch address (preview) |

4. **Settings → General → Node.js Version**: **22.x** or newer.
5. **Deployments → ⋯ → Redeploy** (environment variable changes need a new deployment).

Open the site: the yellow "demo" banner should be gone. Create something (e.g. edit the vehicle details), deploy
again, and it is still there.

### Data, backups and limits
- Everything is in the Turso database: users, bookings, settings, procedures, sessions and license images
  (stored in 1 MB chunks, since hosted databases limit a single value to about 5 MB).
- Backups: Turso's dashboard/CLI (`turso db shell <name> .dump > backup.sql`). Check the free plan's current limits on turso.tech.
- Local development keeps using a file in `data/`. You can point it at a Turso database too, by setting the same
  two variables in `.env`.

### Sign in with Google on Vercel
Register the **production domain** in Google Cloud Console: the origin `https://<project>.vercel.app` and the redirect URI
`https://<project>.vercel.app/auth/google/callback`. Per-deployment preview URLs (`car-rental-abc123-….vercel.app`) change
on every deploy and can't all be registered. On those, the login page links to the production domain instead.

## Web Analytics (page views)
Every page includes Vercel's analytics script (`/_vercel/insights/script.js`) when running on Vercel. This app renders
plain HTML (no React/Next.js), so it uses the HTML script rather than the `<Analytics/>` component; the result is the same.
1. In the Vercel project, open **Analytics → Enable** (until then the script returns 404 and nothing is counted).
2. Deploy, then open the site and move between a few pages. Data shows up in the Analytics tab after about 30 seconds.
   Ad/content blockers hide your own visits.

Analytics is cookieless; the privacy page mentions it. Set `VERCEL_ANALYTICS=false` to remove the script.

## Branches: Vercel deploys production (`main`) only
Only `main` is deployed on Vercel, to **Production**. `dev` and every other branch are tested by CI (GitHub Actions) but
not deployed. Every deployment Vercel keeps counts toward the plan's storage (Hobby: 10 GB), and with several clients a
single push rebuilds every client's site. Two settings in this repository do this:

- `vercel.json` → `git.deploymentEnabled` turns off automatic deployments for `dev`, `dependabot/**`, `claude/**`,
  `fix/**` and `feature/**`;
- `vercel.json` → `ignoreCommand` runs `scripts/vercel-ignore-build.js`, which skips the build of any other branch, and
  of a push to `main` that changes only documentation or tests. A redeploy is always built.

To try a change before production, run it locally (`npm run dev`), or use the Docker development image that CI publishes
for `dev` (`ghcr.io/<owner>/car-rental:dev`, see docs/dev-environment.md). To get Vercel previews back, remove those two
settings.

## Limits on Vercel
- **Uploads:** Vercel refuses requests over 4.5 MB, so license uploads are limited to 4 MB there. Large photos are
  shrunk in the browser before upload (typically to 1–2 MB), so phone pictures work; a PDF over 4 MB is refused with a message.
- **E-mail:** without `SMTP_*` nothing is sent. The site then hides "sign in with a code" and "forgot password"
  (they could never arrive), and an admin's "send reset link" shows the link on screen to pass on instead.
- **Time zone:** Vercel's servers run on UTC; the app always uses Israel time (`APP_TIMEZONE` changes it).
- If the app cannot start (usually a wrong `TURSO_*` value), every page shows "השירות אינו זמין כרגע" with the reason,
  instead of Vercel's bare 500 error. The deployment's **Logs** show the same reason.

## Scheduled jobs on Vercel
Pickup/return reminders, license-expiry checks and closing finished bookings run:
- **daily** through Vercel Cron (`vercel.json` → `/internal/cron` at 05:00 UTC; requires `CRON_SECRET`).
  The free Hobby plan allows one run per day, and
- **at most every 15 minutes while the site is being used**, as part of handling a request.
