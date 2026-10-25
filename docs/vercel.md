# Deploying on Vercel

The app runs on Vercel as a single serverless function (`api/index.js`, routed by `vercel.json`).

> **Important: data on Vercel is temporary.** Vercel functions can only write to a temporary folder, which is
> wiped whenever Vercel recycles the instance (typically after some minutes without traffic, and on every deploy).
> Users, bookings and uploaded license images are lost then, and every page shows a "demo" banner.
> Use Vercel for demos. For real use, host on a server with a disk (see [free-hosting.md](free-hosting.md),
> free on Oracle Cloud). The alternative is moving the data to external services (hosted database + file storage),
> which requires code changes.

## Set up

1. Import the GitHub repository in Vercel (**Add New → Project**). `vercel.json` sets everything else.
   If the project was created earlier with the **Express** framework preset, that's fine: `vercel.json` overrides it.
2. **Settings → Environment Variables**, then add:

   | Name | Value | Why |
   |---|---|---|
   | `ADMIN_EMAIL` | your e-mail | Creates the admin account automatically (there is no terminal on Vercel, and the data resets) |
   | `ADMIN_PASSWORD` | a strong password (8+ characters) | Password of that admin |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | e.g. Gmail (see README) | Optional: real e-mails (login codes, confirmations) |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from Google Cloud Console | Optional: sign in with Google |
   | `BASE_URL` | e.g. `https://car-rental.vercel.app` | Optional: defaults to the project's production domain |

3. **Settings → General → Node.js Version**: **22.x** or newer.
4. **Deployments → ⋯ → Redeploy** (environment variable changes need a new deployment).

Then open the project's domain (e.g. `https://car-rental-<you>.vercel.app`) and log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

### Sign in with Google on Vercel
Register the **production domain** in Google Cloud Console: the origin `https://<project>.vercel.app` and the redirect URI
`https://<project>.vercel.app/auth/google/callback`. Per-deployment preview URLs (`car-rental-abc123-….vercel.app`) change
on every deploy and can't all be registered. On those, the login page links to the production domain instead.

## Branches
By default Vercel deploys `main` to production and every other branch (such as `dev`) as a **preview**, each with its
own URL. Preview URLs may require logging in to Vercel (**Settings → Deployment Protection**).

## What does not run on Vercel
- **Background jobs:** pickup/return reminders, license-expiry checks, and closing finished bookings run on a timer in
  the normal server. Vercel functions only run while handling a request.
- **Persistent data:** see the note at the top.
