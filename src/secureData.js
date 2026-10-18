// Scrambles (encrypts) very sensitive values, like Social Security numbers,
// before they're saved, and unscrambles them when an admin needs them.
//
// The key comes from the TAX_ID_KEY environment variable if it's set (best:
// then the database alone isn't enough to read them). Otherwise the app makes
// a key and keeps it in the database. Each saved value remembers which key it
// used, so setting TAX_ID_KEY later doesn't break values saved before.
const crypto = require('crypto');
const { storedSecret } = require('./secrets');

async function keyFor(source) {
  const secret = source === 'env'
    ? process.env.TAX_ID_KEY
    : await storedSecret('tax_id_key', () => crypto.randomBytes(32).toString('hex'));
  if (!secret) throw new Error('TAX_ID_KEY is needed to read this value, but it is not set.');
  return crypto.createHash('sha256').update(secret).digest();
}

async function encrypt(text) {
  const source = process.env.TAX_ID_KEY ? 'env' : 'db';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', await keyFor(source), iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return [source, iv, cipher.getAuthTag(), data].map((part) => (Buffer.isBuffer(part) ? part.toString('base64') : part)).join(':');
}

async function decrypt(stored) {
  const [source, iv, tag, data] = String(stored).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', await keyFor(source), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
