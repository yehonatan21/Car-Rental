'use strict';
// A second server process on the SAME database as the test that starts it (DATA_DIR, or TURSO_DATABASE_URL for the
// hosted one): two "Vercel instances" at once, for the concurrency tests. Prints "LISTENING <port>".
process.env.TZ = 'Asia/Jerusalem';
const { app } = require('../../src/server');

process.on('SIGTERM', () => process.exit(0));
const server = app.listen(0, '127.0.0.1', () => process.stdout.write(`LISTENING ${server.address().port}\n`));
