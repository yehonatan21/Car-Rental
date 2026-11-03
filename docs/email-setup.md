# Reservation email setup

The application sends these notifications automatically:

- When a client creates a reservation, all **active users with the admin role** receive a pending-approval email with vehicle details, pickup/return times, and a link to review it. The client receives a receipt explaining that approval is still required.
- When an admin approves the reservation, the client receives a final confirmation with vehicle details, driver instructions, and a calendar attachment. Active admins also receive confirmation. A failed approval does not send a final confirmation.

These emails only reach real inboxes once the application is connected to a mail server (SMTP). Until then they are saved in `data/outbox` and nobody receives them.

## Do I need a new email account?

You need **one mailbox that the application sends from**. It does not have to be an admin's address: the recipients are taken from the user accounts in the application (each admin's and client's own email).

- Recommended: create a dedicated Gmail account for the app, for example `car-booking.yourclub@gmail.com`. That keeps the app's password separate from anyone's personal mailbox.
- Or use an existing mailbox or an SMTP service you already have (Outlook/Office 365, your domain's mail, SendGrid, Brevo, …).

Gmail allows about 500 emails a day, which is plenty for one shared car.

## Connect a Gmail mailbox

1. Sign in to the sending Google account and enable **2-Step Verification** (Google Account → Security).
2. Create an **App password** at https://myaccount.google.com/apppasswords (name it, for example, "car rental"). Google shows a 16-letter password; copy it. Use it instead of the normal Google password. If the page is not available, 2-Step Verification is off or your organization blocks app passwords: use another SMTP provider.
3. Set the variables:

   ```dotenv
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=your-sender@gmail.com
   SMTP_PASS=abcd efgh ijkl mnop
   BASE_URL=https://your-application-domain.example
   # Optional: MAIL_FROM=your-sender@gmail.com (defaults to SMTP_USER)
   ```

   - **Locally**: in the `.env` file in the project root (it is git-ignored), then restart with `npm start`.
   - **On Vercel**: Project → Settings → Environment Variables. Add each variable for the environments you use (Production and/or Preview), then **Redeploy** (Deployments → ⋯ → Redeploy). Variables only apply to new deployments.
   - **Other hosts / Docker**: the host's private environment settings, then restart.

   Never commit the password. `BASE_URL` must be the application's real address so the links in the emails work. The Gmail app password may be pasted with or without spaces. Other providers give you their own host, port, user and password; port 465 uses TLS, 587 uses STARTTLS (set `SMTP_SECURE=true|false` to override).
4. Sign in as an admin and open **Settings → Email delivery** (`/admin/settings`):
   - The card should say **configured**, without an error.
   - It lists the admin addresses that receive new-request notifications. Make sure every admin who should be notified appears there. Only users with the admin role and active status are notified; fix the email in the user's card if needed.
   - Click **Send test email**. It goes to your own account email; check the spam folder too.
5. Try the whole flow: as an active client, create a reservation; the admins should get "בקשת הזמנה חדשה ממתינה לאישור". Approve it; the client should get "ההזמנה אושרה" with a calendar invite.

## How do I know it worked?

- After you approve a booking, the message at the top of the page says exactly what happened: "נשלח מייל אישור אל …" on success, or a warning that sending failed or that no mail server is configured.
- On a hosted site without SMTP, the admin dashboard shows a red "מיילים לא נשלחים" banner.
- Every failed email is written to the action log (`/admin/audit`, action `mail.failed`) with the reason, and the latest one appears in **Settings → Email delivery**. Failed messages are not retried automatically.

Common errors:

| Error | Fix |
| --- | --- |
| `Invalid login` / `535 Username and Password not accepted` | Use the Gmail **app password**, not the normal password; check `SMTP_USER`. |
| `ETIMEDOUT`, `ECONNREFUSED`, `Greeting never received` | Wrong `SMTP_HOST`/`SMTP_PORT`, or the host blocks outgoing SMTP. For Gmail use port 465. |
| `Sender address rejected` | Set `MAIL_FROM` to an address the SMTP account is allowed to send from. |
| Email arrives in spam | Send from a dedicated real mailbox (not a made-up address); ask recipients to mark it "not spam" once. |
