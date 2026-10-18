// Secrets the app makes for itself and keeps in the database, so nothing has to
// be configured by hand:
// - the key that signs login cookies, and
// - on Netlify, the one-time code needed to create the first admin account.
// Setting SESSION_SECRET or SETUP_CODE as environment variables overrides them.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

// Returns the value stored under this name, creating it with make() the first time.
async function storedSecret(name, make) {
  await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', name, make());
  return (await db.get('SELECT value FROM settings WHERE key = ?', name)).value;
}

async function getSessionSecret() {
  return process.env.SESSION_SECRET || storedSecret('session_secret', () => crypto.randomBytes(32).toString('hex'));
}

// Easy-to-read codes like "k4mp-9xqa-73hd" (no 0/o or 1/l/i mix-ups).
const CODE_LETTERS = 'abcdefghjkmnpqrstuvwxyz23456789';
function makeSetupCode() {
  const group = () => Array.from(crypto.randomBytes(4), (byte) => CODE_LETTERS[byte % CODE_LETTERS.length]).join('');
  return [group(), group(), group()].join('-');
}

// The code needed to create the first admin account, or null if none is needed
// (on your own computer, where only you can reach the site).
async function getSetupCode() {
  if (process.env.SETUP_CODE) return { code: process.env.SETUP_CODE, fromEnvironment: true };
  if (!config.onNetlify) return null;
  return { code: await storedSecret('setup_code', makeSetupCode), fromEnvironment: false };
}

module.exports = { storedSecret, getSessionSecret, getSetupCode };
