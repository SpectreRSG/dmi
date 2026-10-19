// Two-step sign-in: who needs it, setting it up, checking codes, backup codes,
// and "remember this device". The codes themselves are made in totp.js.
// A passkey (passkeys.js) counts as two-step sign-in too.
const crypto = require('crypto');
const db = require('../db');
const totp = require('./totp');
const { encrypt, decrypt } = require('../secureData');

const RECOVERY_CODES = 10;
const TRUST_DAYS = 30;
const TRUST_COOKIE = 'dmi.device';

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

// Does this person have to use it? Everyone does by default; the Settings page
// can limit it to the office (admins and managers always need it). New
// sign-ups waiting for a role can't see anything yet, so they don't.
function isRequired(user, settings) {
  if (!user || user.role === 'pending') return false;
  if (user.role === 'admin' || user.role === 'manager') return true;
  return settings.two_step_required_for !== 'office';
}

// Has this person set up a second step: the authenticator app, or a passkey?
// (`user` comes from loadUser, which counts their passkeys.)
function hasSecondStep(user) {
  return Boolean(user?.totp_enabled_at || Number(user?.passkey_count) > 0);
}

// Checks a code against a secret that isn't saved yet (while setting up).
function checkNewSecret(secret, code) {
  return totp.matchStep(secret, code);
}

// Turns it on, and returns the backup codes to show (once).
async function enable(userId, secret, step) {
  const stored = await encrypt(secret);
  const codes = await db.transaction(async (tx) => {
    await tx.run(
      'UPDATE users SET totp_secret = ?, totp_enabled_at = app_now(), totp_last_step = ? WHERE id = ?',
      stored, step, userId
    );
    return replaceRecoveryCodes(tx, userId);
  });
  return codes;
}

// Ten codes like "k7wq-3mzp", each good for one sign-in.
async function replaceRecoveryCodes(tx, userId) {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
  const codes = Array.from({ length: RECOVERY_CODES }, () => {
    const chars = Array.from(crypto.randomBytes(8), (b) => letters[b % letters.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });
  await tx.run('DELETE FROM recovery_codes WHERE user_id = ?', userId);
  for (const code of codes) await tx.run('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)', userId, sha256(code));
  return codes;
}

function newRecoveryCodes(userId) {
  return db.transaction((tx) => replaceRecoveryCodes(tx, userId));
}

async function recoveryCodesLeft(userId) {
  return (await db.get('SELECT COUNT(*)::int AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', userId)).n;
}

// Backup codes for someone who has none left (e.g. their first passkey): the
// new codes to show once, or null if they still have some.
async function ensureRecoveryCodes(userId) {
  return (await recoveryCodesLeft(userId)) ? null : newRecoveryCodes(userId);
}

// Checks a code from the app, or a backup code. Returns { ok, method } where
// method is 'app' or 'backup'. A code can never be used twice.
async function verify(userId, input) {
  const user = await db.get('SELECT totp_secret, totp_last_step FROM users WHERE id = ?', userId);
  if (!user) return { ok: false };
  const typed = String(input || '').trim().toLowerCase();

  const step = user.totp_secret ? totp.matchStep(await decrypt(user.totp_secret), typed) : null;
  if (step !== null) {
    // Only accepted if it's newer than the last code used (someone who saw it can't reuse it).
    const fresh = await db.run(
      'UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)',
      step, userId, step
    );
    return { ok: fresh.changes === 1, method: 'app', reused: fresh.changes === 0 };
  }

  const backup = typed.replace(/[^a-z0-9]/g, '');
  if (backup.length === 8) {
    const used = await db.run(
      'UPDATE recovery_codes SET used_at = app_now() WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
      userId, sha256(`${backup.slice(0, 4)}-${backup.slice(4)}`)
    );
    if (used.changes === 1) return { ok: true, method: 'backup' };
  }
  return { ok: false };
}

// Turns it off for someone (e.g. they lost their phone): they set it up again
// at their next sign-in. Their passkeys and remembered devices go too.
async function reset(userId) {
  await db.transaction(async (tx) => {
    await tx.run('UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ?', userId);
    await tx.run('DELETE FROM recovery_codes WHERE user_id = ?', userId);
    await tx.run('DELETE FROM trusted_devices WHERE user_id = ?', userId);
    await tx.run('DELETE FROM passkeys WHERE user_id = ?', userId);
  });
}

// ---- "Remember this device for 30 days" -----------------------------------------

async function trustDevice(res, userId, device, secure) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = TRUST_DAYS * 24 * 60 * 60 * 1000;
  await db.run(
    'INSERT INTO trusted_devices (user_id, token_hash, device, expires_at) VALUES (?, ?, ?, ?)',
    userId, sha256(token), device, Date.now() + maxAge
  );
  res.cookie(TRUST_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, maxAge, path: '/' });
}

// Is the device this request came from remembered for this person?
async function isTrustedDevice(req, userId) {
  const token = readCookie(req, TRUST_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
  const result = await db.run(
    'UPDATE trusted_devices SET last_used_at = app_now() WHERE user_id = ? AND token_hash = ? AND expires_at > ?',
    userId, sha256(token), Date.now()
  );
  return result.changes === 1;
}

function forgetDevices(userId) {
  return db.run('DELETE FROM trusted_devices WHERE user_id = ?', userId);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

module.exports = {
  isRequired, hasSecondStep, checkNewSecret, enable, newRecoveryCodes, recoveryCodesLeft, ensureRecoveryCodes, verify, reset,
  trustDevice, isTrustedDevice, forgetDevices, TRUST_DAYS,
};
