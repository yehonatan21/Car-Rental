# פיתוח

## הרצה

```bash
npm install
cp .env.development.example .env
npm run seed       # נתוני דמו
npm run dev        # https://localhost:3000, טעינה מחדש בכל שמירה
```

או בלחיצה: `start.cmd` (Windows) / `./start.sh` (Mac/Linux).

- בלי SMTP, המיילים לא נשלחים אלא נשמרים כקבצי `.eml` ב־`data/outbox`, וקודי התחברות וקישורי איפוס מודפסים בחלון השרת.
- **משתמשי דמו** (סיסמה `Password1`): `admin@example.org` (מנהלת), `noa@example.org` ו־`yossi@example.org` (פעילים),
  `roni@example.org` (ממתין לאישור), `michal@example.org` (רישיון פג).
- **HTTPS בפיתוח:** השרת מגיש HTTPS בעצמו, עם תעודה עצמית שנוצרת ב־`data/certs`. כדי להימנע מאזהרת הדפדפן:
  [mkcert](https://github.com/FiloSottile/mkcert) (`mkcert -install && mkcert localhost 127.0.0.1`), ואז
  `HTTPS_CERT_FILE` ו־`HTTPS_KEY_FILE` ב־`.env`.

## מכשירים באותה רשת Wi-Fi

1. בהפעלה מוצגת כתובת הרשת, למשל `Network: https://192.168.1.23:3000`.
2. **Windows, פעם אחת:** לחיצה כפולה על `allow-wifi.cmd`. הקובץ פותח את פורט 3000 ב־Firewall לרשתות פרטיות בלבד.
   רשת ה־Wi-Fi צריכה להיות מוגדרת כ"פרטית".
3. בטלפון פותחים את הכתובת ומאשרים את אזהרת התעודה. התעודה כוללת את כתובות ה־IP של המחשב.

## קישור זמני מהאינטרנט (Cloudflare Tunnel)

```bash
winget install --id Cloudflare.cloudflared     # פעם אחת (macOS: brew install cloudflared)
npm run tunnel                                 # בחלון נוסף, כשהאפליקציה רצה
```

מוצגת כתובת `https://<אקראי>.trycloudflare.com` שעובדת כל עוד שני החלונות פתוחים. הפקודה מסרבת לפרסם את האתר כל עוד
קיים משתמש עם סיסמת הדמו `Password1`. כדי שקישורים במיילים יפנו לכתובת: `BASE_URL=<הכתובת>` ב־`.env`.

## פקודות

| פקודה | תיאור |
|---|---|
| `npm run dev` | שרת פיתוח עם טעינה מחדש |
| `npm run seed` | נתוני דמו (רק על מסד ריק; `-- --force` להוספה בכל מקרה; חסום ב־production) |
| `npm run lint` | ESLint |
| `npm test` | כל הבדיקות (יחידה וקצה לקצה) |
| `SQLD_BIN=/path/to/sqld npm run test:libsql` | כל הבדיקות מול שרת libSQL (מה ש־Turso מריץ) במקום קובץ מקומי |
| `npm run test:race` | שני תהליכי שרת על אותו מסד נתונים: שני מנהלים מאשרים באותו רגע (רץ בנפרד, ראו להלן) |
| `npm run test:coverage` | הבדיקות עם דוח כיסוי (נכשל מתחת ל־80% שורות) |
| `npm run create-admin -- --email … --password …` | יצירת מנהל או קידום משתמש קיים למנהל |
| `npm run new-client -- …` | פתיחת לקוח חדש ב־Turso וב־Vercel ([new-client.md](new-client.md)) |

`test:race` מריץ שני שרתים במקביל. כשהוא רץ יחד עם כל השאר, הוא מעמיס על המחשב וגורם לבדיקות אחרות להיכשל בגלל זמן,
ולכן הוא רץ לבד, גם ב־CI.

## ענפים ו־CI

| ענף | תפקיד |
|---|---|
| `dev` | עבודה שוטפת. Vercel לא בונה אותו ([vercel.md](vercel.md)) |
| `main` | הגרסה שרצה אצל כל הלקוחות. כל push נבנה בכל פרויקט Vercel של לקוח |

`.github/workflows/ci-cd.yml` מריץ ב־push ל־`main`/`dev` וב־Pull Request: ESLint, כל הבדיקות על Node 22 ו־24 (עם סף
כיסוי), כל הבדיקות מול libSQL, ובדיקת המקביליות. הפריסה עצמה היא של Vercel, ולא מתבצעת מכאן.
`.github/workflows/jobs.yml` הוא התזמון של התזכורות (כל 10 דקות).

## מבנה הקוד

```
src/
  server.js        Express: אבטחה (CSP, CSRF, בדיקת קבצים), סשנים, משימות מתוזמנות
  config.js        משתני סביבה
  db.js            סכמה, הגדרות, נהלים (ההקמה רצה רק כשהקובץ השתנה)
  driver.js        node:sqlite מקומי, או libsql מול Turso, באותו ממשק
  bookings.js      כללי ההזמנה: חפיפות, זמן התארגנות, רכב בטיפול, אישור (ואישור אוטומטי)
  auth.js          סיסמאות, סשנים, קודים חד־פעמיים, הגבלת ניסיונות
  mail.js          תבניות המייל ותור השליחה החוזרת (mail_outbox)
  jobs.js          תזכורות, התראות, תוקף רישיונות, ניקוי, שליחה חוזרת
  master.js        מרכז הניהול: רשימת הלקוחות והחיבור לכל אתר
  provision.js     יצירת מסד נתונים ופרויקט Vercel ללקוח
  timing.js        Server-Timing ורישום בקשות איטיות
  routes/          public, user, admin, documents, manage (API לאתר לקוח), master (מרכז הניהול)
  views/           תבניות HTML (escaping אוטומטי), יומן, שמות הפעולות ביומן
public/            CSS ו־JS (שיפורים בלבד: הכל עובד גם בלי JavaScript)
scripts/           seed, create-admin, new-client, tunnel, vercel-ignore-build
test/              unit, e2e, race (מקביליות), fixtures
docs/              המסמכים; archive/ לניתוחים ישנים
```
