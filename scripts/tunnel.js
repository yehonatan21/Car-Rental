'use strict';
// Publishes the locally running dev server on the internet through a Cloudflare quick tunnel
// (free, no account, no router/firewall changes). Prints an https://<random>.trycloudflare.com address.
// Usage: npm run tunnel            (start the app first: npm run dev / start.cmd)
//        npm run tunnel -- --force  (skip the demo-password safety check)
const { spawn } = require('node:child_process');
const { db } = require('../src/db');
const auth = require('../src/auth');
const config = require('../src/config');

const DEMO_PASSWORD = 'Password1';
const force = process.argv.includes('--force');

// The demo accounts' password is public (README, seed script). Anyone on the internet could log in as admin.
const exposed = db.prepare('SELECT email, role, password_hash FROM users WHERE password_hash IS NOT NULL').all()
  .filter((u) => auth.verifyPassword(DEMO_PASSWORD, u.password_hash));
if (exposed.length && !force) {
  console.error(`
Refusing to publish the app: these accounts still use the public demo password "${DEMO_PASSWORD}":
${exposed.map((u) => `  - ${u.email}${u.role === 'admin' ? '  (ADMIN)' : ''}`).join('\n')}

Anyone on the internet could log in with them. Give each one its own password, e.g.:
  npm run create-admin -- --email admin@example.org --password <a-strong-password>
(for a regular user, log in as them and change it under "סיסמה ואבטחה"), or block/delete them in the admin
users page. Then run "npm run tunnel" again. To publish anyway: npm run tunnel -- --force
`);
  process.exit(1);
}

const scheme = config.https.enabled ? 'https' : 'http';
const target = `${scheme}://localhost:${config.port}`;
const args = ['tunnel', '--url', target, ...(config.https.enabled ? ['--no-tls-verify'] : [])];
console.log(`Starting a Cloudflare tunnel to ${target} …`);

const child = spawn('cloudflared', args, { stdio: ['ignore', 'pipe', 'pipe'] });
let announced = false;
const watch = (data) => {
  const text = data.toString();
  if (process.argv.includes('--verbose')) process.stderr.write(text);
  const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)?.[0];
  if (url && !announced) {
    announced = true;
    console.log(`
  Your dev environment is on the internet at:

      ${url}

  - Open it from any device. It stays up while this window and the app are running (Ctrl+C to stop).
  - The address changes every time the tunnel starts.
  - For correct links in e-mails, set BASE_URL=${url} in .env and restart the app.
`);
  }
  if (/failed|error/i.test(text) && !announced) process.stderr.write(text);
};
child.stdout.on('data', watch);
child.stderr.on('data', watch);
child.on('error', (err) => {
  if (err.code !== 'ENOENT') throw err;
  console.error(`
cloudflared is not installed. Install it, open a new terminal, and run "npm run tunnel" again:
  Windows:  winget install --id Cloudflare.cloudflared
  macOS:    brew install cloudflared
  Linux:    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
