---
description: How much the car is used over a period, and whether the booking rules fit
argument-hint: "[days, default 30]"
---
Ask the bookings-analyst to analyze the last ${ARGUMENTS:-30} days: utilization, idle days, busiest days and hours,
competing requests, how long requests wait, and whether the current rules (from `node scripts/overview.js`) fit what
it finds. Combine it into a short answer in Hebrew with at most three recommendations, each with its supporting number.
