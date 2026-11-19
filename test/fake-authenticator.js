'use strict';
// A software passkey for the tests: makes WebAuthn answers exactly as a phone or security key would (attestation
// "none", ES256), so src/passkeys.js is tested end to end with real signatures.
const crypto = require('node:crypto');

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// Minimal CBOR (only what WebAuthn needs: unsigned/negative integers, byte and text strings, maps).
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
}
function cbor(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error(`cbor: ${typeof v}`);
}

class FakeAuthenticator {
  constructor() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    this.id = crypto.randomBytes(16);
    this.counter = 0;
  }

  /** The answer to navigator.credentials.create(options) on `origin`. */
  create(options, origin) {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([sha256(options.rp.id), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), idLen, this.id, this.cose]);
    const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: b64(this.id), rawId: b64(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(clientData), attestationObject: b64(attestationObject), transports: ['internal'] },
    };
  }

  /** The answer to navigator.credentials.get(options) on `origin`. */
  get(options, origin) {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
    const count = Buffer.alloc(4); count.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([sha256(options.rpId), Buffer.from([0x05]), count]);
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.privateKey);
    return {
      id: b64(this.id), rawId: b64(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature) },
    };
  }
}

/** The options a passkey page carries in its button (data-options), and its form's token. */
function pageOptions(text) {
  const raw = /data-options="([^"]+)"/.exec(text)?.[1];
  const token = /name="token" value="([^"]+)"/.exec(text)?.[1];
  if (!raw) return null;
  const json = raw.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return { options: JSON.parse(json), token };
}

module.exports = { FakeAuthenticator, pageOptions };
