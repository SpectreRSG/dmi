// The 6-digit codes authenticator apps show (Google Authenticator, Microsoft
// Authenticator, 1Password, Authy...). They follow a public standard ("TOTP",
// RFC 6238): the app and this site share a secret key, and both work out the
// same code from the key and the current time. A new code every 30 seconds.
const crypto = require('crypto');
const QRCode = require('qrcode-svg');

const STEP_SECONDS = 30;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // "base32", how apps expect the key written

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of String(text).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// A new random secret key (160 bits, as the standard recommends).
function newSecret() {
  return base32Encode(crypto.randomBytes(20));
}

const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

// The code for one 30-second step.
function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

// Which step a typed code belongs to, or null if it's wrong. Codes from 30
// seconds before or after are accepted too, in case a phone's clock is a bit off.
function matchStep(secret, code, now = Date.now()) {
  const typed = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(typed)) return null;
  const step = currentStep(now);
  for (const s of [step - 1, step, step + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(typed))) return s;
  }
  return null;
}

// The link an authenticator app understands (also what the QR code holds).
function setupLink({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

// The QR code to scan, as a picture (SVG) for the page.
function qrCode(text) {
  return new QRCode({ content: text, ecl: 'M', padding: 3, join: true, container: 'svg-viewbox', color: '#000000', background: '#ffffff' }).svg();
}

module.exports = { newSecret, currentStep, codeAt, matchStep, setupLink, qrCode, base32Encode, base32Decode };
