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
// Pass the current session id to keep that one signed in.
async function endSessionsForUser(userId, exceptSid = '') {
  await db.run("DELETE FROM sessions WHERE (data->>'userId')::int = ? AND sid != ?", userId, exceptSid);
}

// ---- Login attempt limiter --------------------------------------------------
// After 5 wrong passwords for the same email + address, wait 15 minutes.
// Kept in the database, because on Netlify each request can run on a different server.
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

function loginKey(req, email) {
  return `${req.ip}|${String(email || '').toLowerCase()}`.slice(0, 300);
}

async function isLockedOut(key) {
  const row = await db.get('SELECT count FROM login_attempts WHERE key = ? AND first_at > ?', key, Date.now() - LOCK_MS);
  return Boolean(row && row.count >= MAX_ATTEMPTS);
}

async function recordFailedLogin(key) {
  const now = Date.now();
  await db.run(
    `INSERT INTO login_attempts (key, count, first_at) VALUES (?, 1, ?)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN login_attempts.first_at > ? THEN login_attempts.count + 1 ELSE 1 END,
       first_at = CASE WHEN login_attempts.first_at > ? THEN login_attempts.first_at ELSE excluded.first_at END`,
    key,
    now,
    now - LOCK_MS,
    now - LOCK_MS
  );
  if (Math.random() < 0.05) await db.run('DELETE FROM login_attempts WHERE first_at <= ?', now - LOCK_MS);
}

async function clearFailedLogins(key) {
  await db.run('DELETE FROM login_attempts WHERE key = ?', key);
}

// ---- Middleware ---------------------------------------------------------------
// "Middleware" are small functions that run before a page is shown.

// Looks up the logged-in user (if any) on every request.
async function loadUser(req, res, next) {
  req.user = null;
  if (req.session.userId) {
    const user = await db.get(
      'SELECT id, name, email, phone, role, employee_id, client_id FROM users WHERE id = ? AND active = 1',
      req.session.userId
    );
    if (user) req.user = user;
    else delete req.session.userId; // account was removed or deactivated
  }
  res.locals.currentUser = req.user;
  res.locals.isAdmin = req.user?.role === 'admin';
  next();
}

// Where each kind of account starts after signing in.
function homeFor(user) {
  if (user.role === 'officer' || user.role === 'client') return '/my';
  if (user.role === 'pending') return '/waiting';
  return '/';
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  return res.redirect('/login');
}

// The back office (everything except /my and /account) is for admins and managers.
// Officers and clients are sent to their own pages; new accounts wait for a role.
function requireBackOffice(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'manager') return next();
  if (req.method === 'GET') return res.redirect(homeFor(req.user));
  res.status(403).render('error', { title: 'Not allowed', message: "Your account can't do that." });
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
  homeFor,
  requireBackOffice,
  requireLogin,
  requireAdmin,
};
