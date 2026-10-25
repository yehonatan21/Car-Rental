# Deploying on Vercel

The app runs on Vercel as a single serverless function (`api/index.js`, routed by `vercel.json`).

Vercel functions have **no lasting disk**: anything written to files is gone on the next deploy or restart.
To keep users, bookings and license images across new versions, connect a hosted **Turso (libSQL) database**.
The app then stores everything there, license images included. Turso has a free plan.
Without it the app still runs, but in demo mode: data is temporary and every page shows a banner.

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
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from Google Cloud Console | Optional: sign in with Google |
   | `BASE_URL` | e.g. `https://car-rental.vercel.app` | Optional: defaults to the project's production domain |

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

## Branches
By default Vercel deploys `main` to production and every other branch (such as `dev`) as a **preview**, each with its
own URL. Preview URLs may require logging in to Vercel (**Settings → Deployment Protection**).

## Scheduled jobs on Vercel
Pickup/return reminders, license-expiry checks and closing finished bookings run:
- **daily** through Vercel Cron (`vercel.json` → `/internal/cron` at 05:00 UTC; requires `CRON_SECRET`).
  The free Hobby plan allows one run per day, and
- **at most every 15 minutes while the site is being used**, as part of handling a request.
