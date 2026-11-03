# Reservation email setup

The application already sends these notifications automatically:

- When a client creates a reservation, all **active users with the admin role** receive a pending-approval email with vehicle details, pickup/return times, and a link to review it. The client receives a receipt explaining that approval is still required.
- When an admin approves the reservation, the client receives a final confirmation with vehicle details, driver instructions, and a calendar attachment. Active admins also receive confirmation. A failed approval does not send a final confirmation.

No separate email account is required if you already have an SMTP service. Otherwise, create a dedicated mailbox for the application, such as a Gmail account. The sending mailbox can differ from the admin's receiving address: recipients come from user accounts in the application.

## Connect a Gmail mailbox

1. Enable **2-Step Verification** on the sending Google account.
2. Create an **App password** at https://myaccount.google.com/apppasswords. Use this app password, rather than your normal Google password. If this option is unavailable, check your organization's Google account policy or use another SMTP provider.
3. For local development, create or update the ignored `.env` in the project root. For hosting, set the equivalent variables in the hosting provider's private environment settings:

   ```dotenv
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_SECURE=true
   SMTP_USER=your-sender@gmail.com
   SMTP_PASS=your-app-password
   MAIL_FROM=your-sender@gmail.com
   BASE_URL=https://your-application-domain.example
   ```

   Replace the example values. Never commit the password or `.env`. `BASE_URL` must be the application's actual address so email links work. Other SMTP providers should supply their own host, port, TLS setting, credentials, and verified sender address.
4. Restart the application. Ensure the host permits outbound SMTP to the provider's port (465 in this example). A host that blocks SMTP needs an allowed SMTP service or a separate email API integration.
5. Sign in as an admin, open **Settings → Email delivery** (`/admin/settings`), and use **Send test email**. The test is sent to the signed-in admin's account email. Check spam and the delivery status/error shown on that page.
6. Ensure each intended admin has the correct email address, the admin role, and active status. Create a reservation as an active client: the admin should receive the pending request. Approve it: the client should receive the final confirmation.

Without `SMTP_HOST`, messages are saved locally in `data/outbox` and are **not delivered** to inboxes. SMTP errors are logged and shown in admin settings; failed messages are not automatically retried. Test delivery after configuring SMTP and after changing credentials.
