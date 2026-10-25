'use strict';
// Vercel serverless entry point: every request is routed here (see vercel.json) and handled by the Express app.
// Background jobs (reminders, closing finished bookings) do not run on Vercel; see docs/vercel.md.
module.exports = require('../src/server').app;
