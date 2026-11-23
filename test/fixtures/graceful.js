'use strict';
// Preloaded (node -r) into a server started as `node src/server.js`: SIGTERM ends it with a normal exit (so the test
// runner's coverage data is written), and FAULTS=1 raises a stray error and an unhandled rejection once the server is
// up, which the server must log and survive.
process.on('SIGTERM', () => process.exit(0));
if (process.env.FAULTS === '1') {
  setTimeout(() => {
    Promise.reject(new Error('stray rejection'));
    setImmediate(() => { throw new Error('stray error'); });
    setTimeout(() => process.stdout.write('STILL RUNNING\n'), 100);
  }, 300);
}
