'use strict';
// A client instance in a process of its own (own data directory and database), for the master console tests.
// Prints "LISTENING <port>" once it accepts requests.
require('../helpers');
const { app } = require('../../src/server');

process.on('SIGTERM', () => process.exit(0)); // runs the helpers' clean-up (temporary data, sqld)
const server = app.listen(Number(process.env.TEST_PORT || 0), '127.0.0.1', () => process.stdout.write(`LISTENING ${server.address().port}\n`));
