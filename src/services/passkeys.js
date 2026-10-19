// Passkeys (the "WebAuthn" standard): signing in with Face ID, Touch ID, a
// fingerprint or the device's PIN. On iPhones they're kept in iCloud
// Keychain, so they carry over to a new phone.
//
// How it works: when someone adds a passkey, their device makes a key pair.
// The secret half never leaves the device; we keep the public half. To sign
// in, we send a random "challenge"; the device asks for Face ID (or similar),
// then signs the challenge with the secret key; we check the signature with
// the public key. A passkey only works on the website it was made for, so a
// fake look-alike site can't use it. Because it needs both the device and the
// person's face, finger or PIN, it counts as two-step sign-in by itself.
//
// The checks below follow the standard's steps (W3C Web Authentication,
// sections 7.1 and 7.2), using only Node's built-in cryptography.
const crypto = require('crypto');
const db = require('../db');

const CHALLENGE_MS = 5 * 60 * 1000;
// The kinds of key we accept: ES256 (iPhones, Android, most devices), RS256 (some Windows), Ed25519.
const ALGORITHMS = {
  [-7]: { type: 'ec', curve: 'prime256v1', verify: (data, key, sig) => crypto.verify('sha256', data, { key, dsaEncoding: 'der' }, sig) },
  [-257]: { type: 'rsa', verify: (data, key, sig) => crypto.verify('sha256', data, key, sig) },
  [-8]: { type: 'ed25519', verify: (data, key, sig) => crypto.verify(null, data, key, sig) },
};

const toB64 = (buf) => Buffer.from(buf).toString('base64url');
const fromB64 = (text) => (typeof text === 'string' && /^[A-Za-z0-9_-]*={0,2}$/.test(text) ? Buffer.from(text, 'base64url') : null);
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

// This website, as passkeys see it: its name (e.g. dmi.codehound.org) and full address.
function site(req) {
  return { rpId: req.hostname, origin: `${req.protocol}://${req.host}` };
}

// A one-time random challenge, kept in the session for 5 minutes.
function newChallenge(req, purpose) {
  const value = toB64(crypto.randomBytes(32));
  req.session.passkeyChallenges = { ...req.session.passkeyChallenges, [purpose]: { value, at: Date.now() } };
  return value;
}

function takeChallenge(req, purpose) {
  const saved = req.session.passkeyChallenges?.[purpose];
  if (saved) delete req.session.passkeyChallenges[purpose];
  return saved && Date.now() - saved.at < CHALLENGE_MS ? saved.value : null;
}

// The "client data" the browser signed: what it was asked to do, the
// challenge, and which website asked.
function checkClientData(json, { type, challenge, origin }) {
  let data;
  try {
    data = JSON.parse(json.toString('utf8'));
  } catch {
    return 'The passkey reply could not be read.';
  }
  if (data.type !== type) return 'The passkey reply was for something else.';
  if (!challenge || data.challenge !== challenge) return 'That passkey request has expired. Please try again.';
  if (data.origin !== origin) return "That passkey belongs to a different website.";
  if (data.crossOrigin === true) return 'Passkeys only work on this site directly.';
  return null;
}

// The device's report: which website (as a hash), what it checked, and a counter.
function readAuthenticatorData(buf, rpId) {
  if (!buf || buf.length < 37) return { error: 'The passkey reply is incomplete.' };
  const flags = buf[32];
  const result = {
    userPresent: Boolean(flags & 0x01),
    userVerified: Boolean(flags & 0x04),
    hasCredential: Boolean(flags & 0x40),
    signCount: buf.readUInt32BE(33),
  };
  if (!crypto.timingSafeEqual(buf.subarray(0, 32), sha256(rpId))) return { error: 'That passkey belongs to a different website.' };
  if (!result.userPresent || !result.userVerified) return { error: 'Face ID, Touch ID or the device PIN is needed to use a passkey.' };
  if (result.hasCredential) {
    if (buf.length < 55) return { error: 'The passkey reply is incomplete.' };
    const length = buf.readUInt16BE(53);
    if (length < 16 || length > 1023 || buf.length < 55 + length) return { error: 'The passkey reply is incomplete.' };
    result.credentialId = buf.subarray(55, 55 + length);
  }
  return result;
}

// ---- Adding a passkey -------------------------------------------------------------

// What the browser needs to make a passkey for this person.
async function creationOptions(req, user, companyName) {
  const existing = await db.all('SELECT credential_id FROM passkeys WHERE user_id = ?', user.id);
  return {
    challenge: newChallenge(req, 'register'),
    rp: { id: site(req).rpId, name: companyName || 'DMI' },
    user: { id: toB64(Buffer.from(String(user.id))), name: user.email, displayName: user.name },
    pubKeyCredParams: Object.keys(ALGORITHMS).map((alg) => ({ type: 'public-key', alg: Number(alg) })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials: existing.map((p) => ({ type: 'public-key', id: p.credential_id })),
    attestation: 'none',
    timeout: 60000,
  };
}

// Checks the new passkey and saves it. Returns { passkey } or { error }.
async function register(req, user, body, name) {
  const { rpId, origin } = site(req);
  const challenge = takeChallenge(req, 'register');
  const rawId = fromB64(body.id);
  const clientData = fromB64(body.clientDataJSON);
  const authData = fromB64(body.authenticatorData);
  const publicKeyDer = fromB64(body.publicKey);
  const algorithm = Number(body.publicKeyAlgorithm);
  if (!rawId || !clientData || !authData || !publicKeyDer) {
    return { error: "This browser can't make passkeys for this site. Try Safari on iPhone, or Chrome or Edge on a computer." };
  }
  const clientProblem = checkClientData(clientData, { type: 'webauthn.create', challenge, origin });
  if (clientProblem) return { error: clientProblem };
  const device = readAuthenticatorData(authData, rpId);
  if (device.error) return { error: device.error };
  if (!device.credentialId || !device.credentialId.equals(rawId)) return { error: 'The passkey reply did not match.' };

  const kind = ALGORITHMS[algorithm];
  let key;
  try {
    key = crypto.createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
  } catch {
    return { error: 'The passkey reply did not include a usable key.' };
  }
  if (!kind || key.asymmetricKeyType !== kind.type || (kind.curve && key.asymmetricKeyDetails?.namedCurve !== kind.curve)) {
    return { error: "That kind of passkey isn't supported." };
  }
  try {
    const id = await db.insert(
      'INSERT INTO passkeys (user_id, credential_id, public_key, algorithm, sign_count, rp_id, name) VALUES (?, ?, ?, ?, ?, ?, ?)',
      user.id, toB64(rawId), toB64(publicKeyDer), algorithm, device.signCount, rpId, String(name || '').slice(0, 60) || null
    );
    return { passkey: await db.get('SELECT * FROM passkeys WHERE id = ?', id) };
  } catch (err) {
    if (err?.code === '23505') return { error: 'That passkey is already saved.' };
    throw err;
  }
}

// ---- Signing in (or confirming it's you) with a passkey -------------------------------

// What the browser needs to ask for a passkey. With no user, the device
// offers any passkey it has for this site (no email needed); with a user,
// only theirs.
async function requestOptions(req, purpose, userId = null) {
  const mine = userId ? await db.all('SELECT credential_id FROM passkeys WHERE user_id = ? AND rp_id = ?', userId, site(req).rpId) : [];
  return {
    challenge: newChallenge(req, purpose),
    rpId: site(req).rpId,
    allowCredentials: mine.map((p) => ({ type: 'public-key', id: p.credential_id })),
    userVerification: 'required',
    timeout: 60000,
  };
}

// Checks a passkey's answer. Returns { passkey } (with user_id) or { error }.
// With `userId`, the passkey must be that person's.
async function authenticate(req, purpose, body, userId = null) {
  const { rpId, origin } = site(req);
  const challenge = takeChallenge(req, purpose);
  const rawId = fromB64(body.id);
  const clientData = fromB64(body.clientDataJSON);
  const authData = fromB64(body.authenticatorData);
  const signature = fromB64(body.signature);
  if (!rawId || !clientData || !authData || !signature) return { error: 'The passkey reply is incomplete.' };

  const passkey = await db.get(
    `SELECT p.* FROM passkeys p JOIN users u ON u.id = p.user_id
     WHERE p.credential_id = ? AND p.rp_id = ? AND u.active = 1`,
    toB64(rawId), rpId
  );
  if (!passkey || (userId && passkey.user_id !== userId)) return { error: "That passkey isn't set up for an account here." };
  if (body.userHandle && fromB64(body.userHandle)?.toString() !== String(passkey.user_id)) return { error: 'The passkey reply did not match.' };

  const clientProblem = checkClientData(clientData, { type: 'webauthn.get', challenge, origin });
  if (clientProblem) return { error: clientProblem };
  const device = readAuthenticatorData(authData, rpId);
  if (device.error) return { error: device.error };

  const kind = ALGORITHMS[passkey.algorithm];
  const key = crypto.createPublicKey({ key: fromB64(passkey.public_key), format: 'der', type: 'spki' });
  let valid = false;
  try {
    valid = kind.verify(Buffer.concat([authData, sha256(clientData)]), key, signature);
  } catch {
    valid = false;
  }
  if (!valid) return { error: "That passkey's signature didn't check out." };

  // Devices that count their uses must count up; going back means a copied key.
  const stored = Number(passkey.sign_count);
  if ((device.signCount > 0 || stored > 0) && device.signCount <= stored) {
    return { error: 'That passkey looks like a copy. Please use another way to sign in and tell the office.' };
  }
  const saved = await db.run(
    'UPDATE passkeys SET sign_count = ?, last_used_at = app_now() WHERE id = ? AND sign_count = ?',
    device.signCount, passkey.id, passkey.sign_count
  );
  if (!saved.changes) return { error: 'That passkey was just used. Please try again.' };
  return { passkey };
}

function forUser(userId) {
  return db.all('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at', userId);
}

module.exports = { site, creationOptions, register, requestOptions, authenticate, forUser };
