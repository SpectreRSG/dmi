// Passwords, "who is logged in?", and "are they allowed to see this page?".
const crypto = require('crypto');
const db = require('./db');

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };
const MIN_PASSWORD_LENGTH = 10;

// We never store real passwords, only a scrambled "hash" that can't be reversed.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, SCRYPT_OPTIONS);
  return crypto.timingSafeEqual(expected, actual);
}

function passwordProblem(password, confirm) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (confirm !== undefined && password !== confirm) return 'The two passwords do not match.';
  return null;
}

// Signs a user out everywhere (e.g. after their password is reset).
function endSessionsForUser(userId) {
  db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?").run(userId);
}

// ---- Login attempt limiter --------------------------------------------------
// After 5 wrong passwords for the same email + address, wait 15 minutes.
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const attempts = new Map();

function loginKey(req, email) {
  return `${req.ip}|${String(email || '').toLowerCase()}`;
}

function isLockedOut(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > LOCK_MS) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailedLogin(key) {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.first > LOCK_MS) attempts.set(key, { count: 1, first: Date.now() });
  else entry.count += 1;
  if (attempts.size > 10000) attempts.clear(); // stop the list growing forever
}

function clearFailedLogins(key) {
  attempts.delete(key);
}

// ---- Middleware ---------------------------------------------------------------
// "Middleware" are small functions that run before a page is shown.

// Looks up the logged-in user (if any) on every request.
function loadUser(req, res, next) {
  req.user = null;
  if (req.session.userId) {
    const user = db
      .prepare('SELECT id, name, email, role FROM users WHERE id = ? AND active = 1')
      .get(req.session.userId);
    if (user) req.user = user;
    else delete req.session.userId; // account was removed or deactivated
  }
  res.locals.currentUser = req.user;
  res.locals.isAdmin = req.user?.role === 'admin';
  next();
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  res.status(403).render('error', {
    title: 'Not allowed',
    message: 'Only administrators can open this page.',
  });
}

module.exports = {
  hashPassword,
  verifyPassword,
  passwordProblem,
  endSessionsForUser,
  loginKey,
  isLockedOut,
  recordFailedLogin,
  clearFailedLogins,
  loadUser,
  requireLogin,
  requireAdmin,
};
