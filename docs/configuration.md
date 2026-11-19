# הגדרות

## משתני סביבה

ב־Vercel: Settings → Environment Variables. במחשב: קובץ `.env` (ראו `.env.example`), שנטען אוטומטית.

| משתנה | תיאור |
|---|---|
| `BASE_URL` | הכתובת הציבורית, לקישורים במיילים, למשל `https://car.example.org`. ב־Vercel נקבעת לבד |
| `TURSO_DATABASE_URL` / `LIBSQL_URL`, `TURSO_AUTH_TOKEN` / `LIBSQL_AUTH_TOKEN` | מסד הנתונים המתארח. **חובה ב־Vercel**, אחרת הנתונים לא נשמרים |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | המנהל הראשון, נוצר בהפעלה אם אינו קיים (הסיסמה אינה חובה) |
| `CRON_SECRET` | המפתח של `/internal/cron` (התזכורות). במרכז הניהול: אותו ערך כמו `CONSOLE_CRON_SECRET` ב־GitHub |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `MAIL_FROM_NAME` | שליחת מיילים ([email-setup.md](email-setup.md)). מרכז הניהול מעתיק את שלו לאתרים שאין להם |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | התחברות עם Google (להלן) |
| `GOOGLE_RELAY_URL` / `GOOGLE_RELAY_ALLOWED` | התחברות עם Google דרך כתובת החזרה של אתר אחר / האתרים שמותר להעביר אליהם |
| `MANAGE_TOKEN` | מפתח הניהול של אתר לקוח (מרכז הניהול מגדיר אותו). בלעדיו אין לאתר ניהול מרכזי |
| `APP_MODE=master` | הפריסה היא מרכז הניהול ([master.md](master.md)) |
| `MASTER_CONSOLE=true` | מרכז הניהול בתוך אתר רגיל, למנהל הראשי בלבד |
| `APP_NAME`, `BRAND_COLOR`, `CONTACT_EMAIL`, `CONTACT_PHONE`, `WELCOME_TEXT` | המיתוג ההתחלתי. מנהל האתר משנה אותו ב־הגדרות ← הארגון ומיתוג |
| `APP_TIMEZONE` | אזור הזמן (ברירת מחדל `Asia/Jerusalem`, גם כשהשרת ב־UTC) |
| `PORT`, `DATA_DIR` | בהרצה מקומית: הפורט (3000) ותיקיית הנתונים (`./data`) |
| `HTTPS`, `HTTPS_CERT_FILE`, `HTTPS_KEY_FILE` | בהרצה מקומית: HTTPS מהשרת עצמו (ברירת המחדל בפיתוח). ב־Vercel ה־HTTPS לפני האפליקציה |

**HTTPS בייצור:** Vercel מגיש HTTPS. האפליקציה מפנה ל־HTTPS כל בקשה שלא הגיעה כך (חוץ מ־`/healthz`), שולחת HSTS
ומסמנת את עוגיית הסשן `Secure`.

## התחברות עם Google

כשמוגדרים `GOOGLE_CLIENT_ID` ו־`GOOGLE_CLIENT_SECRET`, מופיע כפתור "התחברות עם Google".

- **משתמש קיים** מתחבר עם חשבון Google שהכתובת שלו זהה לרשומה. החשבון מקושר אוטומטית.
- **משתמש חדש** מגיע לטופס ההרשמה עם השם והדואר מ־Google, ומשלים ת"ז, טלפון ורישיון.

**הגדרה (פעם אחת):**
1. [Google Cloud Console](https://console.cloud.google.com/): יוצרים פרויקט.
2. **OAuth consent screen**: בוחרים **External**. במצב **Testing** רק **Test users** יכולים להתחבר. כדי לפתוח לכולם: **Publish app**.
3. **Credentials ← OAuth client ID ← Web application**. תחת **Authorized redirect URIs** מוסיפים
   `https://<כתובת האתר>/auth/google/callback` (ובפיתוח `https://localhost:3000/auth/google/callback`).
4. מעתיקים את ה־Client ID וה־secret למשתני הסביבה.

אתר לקוח לא צריך רישום משלו ב־Google: עם `GOOGLE_RELAY_URL` הוא מתחבר דרך כתובת החזרה של האתר הראשי, שמעביר את
התשובה רק לאתרים שב־`GOOGLE_RELAY_ALLOWED` (או ברשימת הלקוחות של מרכז הניהול).

**בדיקה:** ב־הגדרות ← מיילים והתחברות יש לוח "התחברות עם Google": מה מוגדר, הכתובות המדויקות ל־Google Cloud והשגיאה האחרונה.

| מה רואים | הסיבה והפתרון |
|---|---|
| אין כפתור Google | חסר `GOOGLE_CLIENT_ID` או `GOOGLE_CLIENT_SECRET`, או שלא בוצע Redeploy / הפעלה מחדש |
| "זמינה בכתובת…" במקום כפתור | האתר נפתח בכתובת אחרת מ־`BASE_URL`. פותחים את הכתובת שבהודעה |
| `redirect_uri_mismatch` | ב־Authorized redirect URIs צריכה להופיע בדיוק הכתובת שבלוח ההגדרות |
| "Access blocked" | מסך ההסכמה במצב Testing: מוסיפים את החשבון ל־**Test users**, או **Publish app** |
