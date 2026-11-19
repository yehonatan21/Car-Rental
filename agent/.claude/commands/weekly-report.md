---
description: A weekly report on the site (last 7 days and the week ahead), saved under reports/
argument-hint: "[YYYY-MM-DD end date, default today]"
---
Write the weekly report of this site for the 7 days ending $ARGUMENTS (today if empty), in Hebrew.

1. Run `node scripts/overview.js`.
2. Ask the bookings-analyst for the last 7 days (utilization, bookings, peak times, competing requests) and the
   users-reviewer for what needs action.
3. Write `reports/weekly-<end date>.md` with: סיכום (3 bullet points), שימוש ברכב, מה מחכה לטיפול (with where in the site),
   השבוע הקרוב, המלצות (up to 3). Every number from this session's script output.
4. Reply with the summary and the file name.
