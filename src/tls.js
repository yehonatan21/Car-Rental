'use strict';
// Serving the app over HTTPS directly (development, or hosts without a TLS proxy).
// Uses HTTPS_CERT_FILE / HTTPS_KEY_FILE when given (e.g. made with mkcert, so browsers trust them);
// otherwise generates a self-signed certificate for localhost and this machine's network addresses
// (so phones/laptops on the same Wi-Fi can connect), and reuses it until it nears expiry or the IP changes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { X509Certificate } = require('node:crypto');
const config = require('./config');

/** IPv4 addresses of this machine on the local network (Wi-Fi / Ethernet). */
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && !a.internal && a.family === 'IPv4' && !a.address.startsWith('169.254.'))
    .map((a) => a.address);
}

/** Names and addresses the development certificate must cover. */
function certIdentities() {
  const host = os.hostname().toLowerCase();
  const dns = ['localhost', ...(/^[a-z0-9-]+$/.test(host) ? [host, `${host}.local`] : [])];
  return { dns, ips: ['127.0.0.1', ...lanAddresses()] };
}

function certCovers(cert, { dns, ips }) {
  return dns.every((n) => cert.checkHost(n) === n) && ips.every((ip) => cert.checkIP(ip) === ip);
}

async function selfSignedCertificate(dir) {
  const certFile = path.join(dir, 'localhost-cert.pem');
  const keyFile = path.join(dir, 'localhost-key.pem');
  const ids = certIdentities();
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const cert = fs.readFileSync(certFile);
    const x509 = new X509Certificate(cert);
    if (new Date(x509.validTo) - Date.now() > 7 * 86400000 && certCovers(x509, ids)) return { cert, key: fs.readFileSync(keyFile) };
  }
  const selfsigned = require('selfsigned');
  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 1);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [
        ...ids.dns.map((value) => ({ type: 2, value })),
        ...[...ids.ips, '::1'].map((ip) => ({ type: 7, ip })),
      ] },
    ],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
  console.log(`Generated a self-signed certificate for ${[...ids.dns, ...ids.ips].join(', ')} in ${dir}`);
  return { cert: pems.cert, key: pems.private };
}

async function tlsOptions() {
  const { certFile, keyFile } = config.https;
  if (certFile || keyFile) {
    if (!certFile || !keyFile) throw new Error('Set both HTTPS_CERT_FILE and HTTPS_KEY_FILE');
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
  }
  return selfSignedCertificate(path.join(config.dataDir, 'certs'));
}

/**
 * Listens on one port for both protocols: TLS connections go to the app, plain-HTTP
 * connections get a redirect to the https:// URL (so typing "localhost:3000" still works).
 */
async function listenHttps(app, port, host) {
  const secure = https.createServer(await tlsOptions(), app);
  const redirect = http.createServer((req, res) => {
    const target = `https://${req.headers.host || `localhost:${port}`}${req.url}`;
    res.writeHead(301, { Location: target, 'Content-Type': 'text/plain' });
    res.end(`Moved to ${target}\n`);
  });
  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      socket.pause();
      socket.unshift(chunk);
      // 0x16 = TLS handshake record
      (chunk[0] === 0x16 ? secure : redirect).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
    socket.on('error', () => socket.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

module.exports = { listenHttps, tlsOptions, selfSignedCertificate, lanAddresses, certIdentities };
