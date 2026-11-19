# The master console: one admin for all client sites

```
                 Master console  (APP_MODE=master, its own Vercel project + database)
                 you and other console admins
                         │  HTTPS + each site's own MANAGE_TOKEN
          ┌──────────────┼──────────────┐
   Client A site     Client B site     Client C site      ← each: own Vercel project, own Turso database,
   A's managers      B's managers      C's managers          own users, bookings, name, colour, logo
```

- **Each client keeps its own site**: its own deployment, database, users and bookings. A client's managers sign
  in to their own site and only see their own data.
- **The master console** is one more deployment of the same code, with `APP_MODE=master`. It is not a booking site.
  Its admins can do all of the following:
  - see every client, with users, pending approvals and upcoming bookings;
  - create a new client from a form: database, Vercel project, variables and first deployment;
  - invite each client's manager (an e-mail with a link to choose a password);
  - sign in to any client's site as a manager with one click;
  - change a client's name, sender name, colour, logo, contact details and welcome text;
  - suspend a site (everyone sees a notice; the data is kept) and resume it;
  - rebuild a site from the latest code, and delete a client (fully, or only from the list).
- The console reaches each site through the site's management API (`/api/manage/…`). The key is the site's own
  `MANAGE_TOKEN`, derived from the console's secret, so no client key is stored anywhere. A site without
  `MANAGE_TOKEN` has no management API.

## 0. Easiest: the console inside your current site (no new project)

On the site you already have, add these Production variables in Vercel, then Redeploy:

| Variable | Value |
|---|---|
| `MASTER_CONSOLE` | `true` |
| `ADMIN_EMAIL` | your e-mail (probably already set). Only this account sees the console |
| `TURSO_API_TOKEN` (Sensitive), `TURSO_ORG` | to create client databases |
| `VERCEL_TOKEN` (Sensitive), `VERCEL_TEAM_ID` | to create client projects |

You then get a **מרכז ניהול** item in your admin menu, with:
- the clients list, new client, sign in to a client's site, passwords, suspend and delete;
- **חיבורים** (connections), to check the keys.

The site's other managers don't see it, and the site works for everyone as before. The list of clients is kept in this
site's own database. A separate console (below) is needed only if you want it apart from any client's site.

## 1. Create a separate console (optional)

### Option A: from your computer

```powershell
$env:TURSO_API_TOKEN="…"; $env:TURSO_ORG="transcendent-libra-tnghvv"
$env:VERCEL_TOKEN="…"; $env:VERCEL_TEAM_ID="team_jy7o4Q75kbMpfmf1GD4jiI3b"
$env:CLIENT_SMTP_PASS="xxxx xxxx xxxx xxxx"   # optional: the Gmail app password of the console's mailbox
npm run new-client -- --master --admin-email you@example.org --smtp-user gmach.car.bne.adam@gmail.com
```

This creates:
- the Turso database `car-rental-master`;
- the Vercel project `car-rental-master` with `APP_MODE=master`, a random `MASTER_SECRET`, your admin account and the
  API keys above (as Sensitive);
- the first deployment.

Your password is in `clients/master.env`.

Where to get the keys:

| Variable | Where |
|---|---|
| `TURSO_API_TOKEN` | app.turso.tech → Settings → API Tokens → Create |
| `TURSO_ORG` | the `<org>` in a database address `libsql://<db>-<org>.<region>.turso.io` |
| `VERCEL_TOKEN` | vercel.com/account/tokens → Create (scope: your team) |
| `VERCEL_TEAM_ID` | Vercel → Team Settings → General → Team ID |

### Option B: in the Vercel dashboard

1. Turso → **Create Database** `car-rental-master` (same region as the others), then **Create Token**.
2. Vercel → **Add New → Project** → import the same GitHub repository and name it `car-rental-master`.
3. Before **Deploy**, add these Environment Variables (Production):

   | Variable | Value |
   |---|---|
   | `APP_MODE` | `master` |
   | `LIBSQL_URL` / `LIBSQL_AUTH_TOKEN` | the new database's address and token (Sensitive) |
   | `ADMIN_EMAIL` | your e-mail: the console's **main admin**. It always stays an active admin and cannot be removed from the console |
   | `ADMIN_PASSWORD` | optional (at least 8 characters, Sensitive). Without it, sign in with a code sent to your e-mail, with Google, or choose a password through "forgot password" (these need the `SMTP_*` variables below) |
   | `MASTER_SECRET` | a long random value (Sensitive), e.g. from `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. **Never change it later**: every client's key is derived from it |
   | `TURSO_API_TOKEN`, `TURSO_ORG` | to create client databases (token: Sensitive) |
   | `VERCEL_TOKEN`, `VERCEL_TEAM_ID` | to create client projects (token: Sensitive) |
   | `CLIENT_REPO` | `yehonatan21/Car-Rental` (optional: by default, the console's own repository) |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | optional: e-mails from the console; new clients can share this mailbox, with their own sender name |

4. **Deploy**, open the address and sign in. **Settings** (הגדרות) has three tabs:
   - **חיבורים** (connections): **Check connections** should show Turso and Vercel as connected.
   - **מיילים** (mail): shows the mail settings read from the `SMTP_*` variables, with a **test e-mail** button.
   - **התחברות ומנהל ראשי** (sign-in and main admin): shows the main admin from `ADMIN_EMAIL`, and Google sign-in.

## 2. Add the site you already have

**Clients → Add existing site** (הוספת אתר קיים):
- name;
- a short id (e.g. `bne-adam`; do not change it later);
- its address (e.g. `https://car-rental-brown-kappa.vercel.app`);
- its Vercel project name (e.g. `car-rental`).

The client page then shows that the site has no management key, and offers two ways to add it:
- **Set it automatically and rebuild** (needs the Vercel key): the console adds `MANAGE_TOKEN` to that project and
  starts a new deployment.
- **By hand**: copy the key shown on the page into the project's Environment Variables as `MANAGE_TOKEN` (Sensitive,
  Production), then Redeploy.

About a minute later the page shows the site's numbers and managers.

## 3. A new client

**New client** (לקוח חדש) needs:
- the client's name;
- a short id: lower-case English letters, digits and `-`; the address becomes `car-rental-<id>.vercel.app`;
- the manager's e-mail;
- optionally: colour, contact phone and e-mail, the shared mailbox, and the shared Google sign-in.

Creating takes a few seconds; Vercel then builds the site for 1–2 minutes. When the site answers, its page says
**the site is ready: invite the manager**. One click sends the manager an e-mail with a link to choose a password,
valid for 7 days. Without e-mail, the link is shown so you can pass it on yourself.

If creating fails halfway (e.g. Vercel was down), run it again with the same id: what was already made is reused.

**Google sign-in for a client:** in Google Cloud Console → Credentials → your OAuth client, add the client's address
as an Authorized JavaScript origin and `https://<address>/auth/google/callback` as an Authorized redirect URI. The
client page shows the exact value.

## 4. Day to day

| Task | Where |
|---|---|
| See all clients and what waits for approval | Clients (לקוחות) |
| Work inside a client's site | its row → **Sign in as manager** (כניסה כמנהל); you become one of its managers, and it is logged in its audit log |
| Add, re-invite or remove a client's manager | client page → **Site managers** (מנהלי האתר) |
| Name, colour, logo, contacts | client page → **Name, look and contact details** (שם, מראה ופרטי קשר). The client's managers can also change these in their own Settings |
| Close a site temporarily | client page → **Suspend** (השהיית האתר), with a message for visitors |
| Apply new code or new variables to one site | client page → **Rebuild** (בנייה מחדש). A push to `main` rebuilds all sites anyway |
| Set a new password for any user of a client site | **Main admin only.** On the client's page, go to **Site users** (משתמשי האתר) → search → **New password** (סיסמה חדשה). The user is signed out everywhere. Optionally they get an e-mail that the password was changed; the password itself is never sent |
| Set a new password for a console admin (or yourself) | **Main admin only.** **Console admins** (מנהלי המרכז) → **New password** (סיסמה חדשה) |
| Add another console admin | **Console admins** (מנהלי המרכז) |
| Replace a site's database key | client page → **Replace database key** (החלפת מפתח מסד הנתונים). The old key stops working at once and the site is rebuilt with a new one, valid for a year; the site is unavailable for about a minute. The client page shows each key's expiry and warns a month before |
| Remove a client | client page → **Delete client** (מחיקת הלקוח); type its id. **Full delete** removes its Vercel project and database, with all its data, permanently. To keep a backup first: `turso db shell car-rental-<id> .dump > backup.sql` |

## Security

- The console's pages are for its admins only; there is no sign-up.
- Each site accepts management calls only with its own `MANAGE_TOKEN`: at least 32 characters, compared in constant
  time. Repeated wrong keys are blocked for 15 minutes.
- **Sign in as manager** works through a one-time link: valid for 2 minutes, single use, and only a hash of it is
  stored.
- The Turso and Vercel tokens stay in the console's Vercel variables (Sensitive). Client database tokens go straight
  into each client's project and are never stored by the console. They expire after a year (replace them from the
  client page before then).
- **Passkeys are required** for the console's admins (`CONSOLE_PASSKEY=required`, the default in production): at the
  first visit without one, the console sends you to add it (your phone's fingerprint or face, Windows Hello / Touch ID,
  or a security key). Every later sign-in needs it, whatever the way in (password, e-mailed code, Google).
- **Lost device:** the main admin removes another admin's passkeys on **Console admins**. If the main admin loses
  theirs: set `PASSKEY_RESET=<their e-mail>` in the console's Vercel variables, redeploy, sign in and add a new
  passkey, then delete the variable.
- **Main admin only:** deleting a client, replacing its database key, and setting passwords for users or console admins.
- Sensitive actions (those above, adding or removing admins and managers) ask to confirm identity again if the last
  confirmation was more than 10 minutes ago.
