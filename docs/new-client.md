# A separate app instance for each client

Every client (each gmach / community / organisation) gets **its own instance** of the app:

- its own **database** (Turso), so clients' users, bookings and documents never mix;
- its own **Vercel project** and address (e.g. `https://car-rental-bne-adam.vercel.app`, or the client's own domain);
- its own **name, colour, logo, contact details and e-mail sender name**.

All instances run the same code from this repository. A push to `main` deploys every client's project, so a fix or
feature reaches all clients at once, and each keeps its own data and settings.

> **Easiest:** create and manage clients from the **master console** (a web page, no command line); see
> [master.md](master.md). The command below does the same from your computer, for a client the console does not manage.

## Create a client: `npm run new-client`

Run it on your computer, in this repository:

```bash
npm run new-client -- --slug bne-adam --name "גמח רכב בני אדם" --admin-email admin@example.org \
  --color "#1d4ed8" --contact-phone 050-1234567 --smtp-user gmach.car.bne.adam@gmail.com
```

With the API keys below it does everything:

1. creates the Turso database `car-rental-<slug>` and a token for it;
2. creates the Vercel project `car-rental-<slug>` linked to this GitHub repository;
3. sets all its environment variables (secrets as *Sensitive*), for **Production**;
4. starts the first deployment;
5. writes everything, secrets included, to `clients/<slug>.env` (never committed: keep it somewhere safe).

Without the keys it creates nothing, writes the file and prints the remaining steps. `--dry-run` only shows the plan;
`--help` lists every option. Running it again for the same slug reuses the database and project and updates the
variables.

| Option | Meaning |
|---|---|
| `--slug` | short id, used in names and the address: lower-case letters, digits, `-` |
| `--name` | the client's name: header, page titles, e-mails (`APP_NAME`) |
| `--admin-email`, `--admin-password` | the client's first admin (random password if omitted; it is in the file) |
| `--color` | main colour, e.g. `#1d4ed8` (`BRAND_COLOR`) |
| `--contact-email`, `--contact-phone` | shown on the site and in e-mails |
| `--mail-from-name` | sender name in inboxes (default: `--name`) |
| `--smtp-user` | the client's sending mailbox; its app password is read from the `CLIENT_SMTP_PASS` environment variable, not from the command line |
| `--repo`, `--branch` | default: this checkout's GitHub repository, `main` |
| `--turso-group` | the Turso group to create the database in (it decides the location), default `default` |

### The API keys (once)

| Variable | Where to get it |
|---|---|
| `TURSO_API_TOKEN` | [app.turso.tech](https://app.turso.tech) → your organisation → **Settings → API Tokens → Create** (or `turso auth api-tokens mint car-rental`) |
| `TURSO_ORG` | your organisation's slug: in a database address `libsql://<db>-<org>.<region>.turso.io` it is the `<org>` part (e.g. `transcendent-libra-tnghvv`) |
| `VERCEL_TOKEN` | [vercel.com/account/tokens](https://vercel.com/account/tokens) → **Create** (scope: your team) |
| `VERCEL_TEAM_ID` | Vercel → Team **Settings → General → Team ID** (`team_…`); leave it out for a personal account |

On Windows (PowerShell), for the current window only:

```powershell
$env:TURSO_API_TOKEN="…"; $env:TURSO_ORG="transcendent-libra-tnghvv"; $env:VERCEL_TOKEN="…"; $env:VERCEL_TEAM_ID="team_…"
$env:CLIENT_SMTP_PASS="abcd efgh ijkl mnop"   # optional: the client mailbox's Gmail app password
npm run new-client -- --slug bne-adam --name "גמח רכב בני אדם" --admin-email admin@example.org
```

The Vercel project must be able to read the GitHub repository: the Vercel GitHub app has to have access to it (it
already does if your first project deploys from it).

## After it is created

1. Open the address printed at the end (or Vercel → the project → **Domains**) and sign in with the admin e-mail and
   the password from `clients/<slug>.env`.
2. **E-mail:** if `--smtp-user` / `CLIENT_SMTP_PASS` were not given, add `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
   `SMTP_PASS` in the project's environment variables (see [email-setup.md](email-setup.md)) and redeploy.
3. **Google sign-in** (optional): in Google Cloud Console add the client's address as an origin and
   `https://<address>/auth/google/callback` as a redirect URI; set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. **Own domain** (optional): Vercel → project → **Settings → Domains**; then set `BASE_URL` to it.

## What each client configures by itself

In its own instance, the client's admin sets in **Settings → הארגון ומיתוג** (Organization):

- name, sender name in e-mails, main colour (too-light colours are darkened so text stays readable), logo (also used
  as the browser tab icon), contact phone and e-mail, the welcome text on the home page;
- and, as before: booking rules, vehicle details and documents, procedures, users and admins.

An empty field falls back to the instance's environment variables (`APP_NAME`, `MAIL_FROM_NAME`, `BRAND_COLOR`,
`CONTACT_EMAIL`, `CONTACT_PHONE`, `WELCOME_TEXT`), then to the built-in defaults. So you can set the client's look when
creating it, and the client can change it later without you.

## Removing a client

Delete its Vercel project (project → **Settings → Advanced → Delete**) and its Turso database (database → **Delete**).
Download a backup first if the client wants their data: `turso db shell car-rental-<slug> .dump > backup.sql`.
