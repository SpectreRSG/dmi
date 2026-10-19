// Passwords, "who is logged in?", and "are they allowed to see this page?".
const crypto = require('crypto');
const db = require('./db');
const twoStep = require('./services/twoStep');

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

// Passwords people pick most often (and that password-guessing tools try first).
const COMMON_PASSWORDS = new Set([
  '1234567890', '12345678910', '0123456789', '0987654321', '1111111111', '1q2w3e4r5t', '1qaz2wsx3edc',
  'password12', 'password123', 'password1234', 'passw0rd123', 'p@ssw0rd123', 'qwertyuiop', 'qwerty1234',
  'qwerty12345', 'asdfghjkl1', 'iloveyou12', 'letmein123', 'welcome123', 'welcome1234', 'changeme123',
  'abcdefghij', 'abc1234567', 'football12', 'baseball12', 'sunshine12', 'princess12', 'monkey1234',
  'dragon1234', 'superman12', 'administrator', 'security123', 'security1234', 'dmisecurity', 'directmeasures',
]);

// What's wrong with a new password, or null if it's fine. `about` = { email, name }
// stops people using their own email or name.
function passwordProblem(password, confirm, about = {}) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (password.length > 200) return 'Passwords can be at most 200 characters long.';
  if (confirm !== undefined && password !== confirm) return 'The two passwords do not match.';
  const lower = password.toLowerCase();
  const plain = lower.replace(/[^a-z0-9]/g, '');
  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(plain) || /^(.)\1+$/.test(password)) {
    return 'That password is too common and easy to guess. Try a few unrelated words, like "harbor lamp violin 42".';
  }
  // Take out their own name and email words: at least 6 other letters or digits must be left.
  let rest = plain;
  for (const word of [String(about.email || '').split('@')[0], ...String(about.name || '').split(/\s+/)]) {
    const own = word.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (own.length >= 3) rest = rest.split(own).join('');
  }
  if (rest.length < 6) return "Your password shouldn't be mostly your name or email. Try a few unrelated words instead.";
  return null;
}

// "Chrome on Windows", "Safari on iPhone": for sign-in alerts and the list of devices.
function describeDevice(userAgent) {
  const ua = String(userAgent || '');
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
      : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
        : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
          : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const device = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows'
          : /Mac OS X/.test(ua) ? 'Mac'
            : /Linux/.test(ua) ? 'Linux' : 'an unknown device';
  return `${browser} on ${device}`;
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

async function isLockedOut(key, max = MAX_ATTEMPTS) {
  const row = await db.get('SELECT count FROM login_attempts WHERE key = ? AND first_at > ?', key, Date.now() - LOCK_MS);
  return Boolean(row && row.count >= max);
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

// However active someone is, they sign in again after this long.
const MAX_SESSION_MS = 12 * 60 * 60 * 1000;

// Looks up the logged-in user (if any) on every request.
async function loadUser(req, res, next) {
  req.user = null;
  if (req.session.userId) {
    req.session.signedInAt ??= Date.now(); // sessions from before this rule start counting now
    const user = Date.now() - req.session.signedInAt < MAX_SESSION_MS
      ? await db.get(
          `SELECT id, name, email, phone, role, employee_id, client_id, totp_enabled_at,
             (SELECT COUNT(*)::int FROM passkeys p WHERE p.user_id = users.id) AS passkey_count
           FROM users WHERE id = ? AND active = 1`,
          req.session.userId
        )
      : null;
    if (user) req.user = user;
    else delete req.session.userId; // account was removed or deactivated, or the session is too old
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

// Two-step sign-in: until it's set up (for people who need it), only the setup
// page works. Sessions that never entered a code (signed in before it was
// turned on) are asked for one.
function requireTwoStep(req, res, next) {
  const enabled = twoStep.hasSecondStep(req.user);
  if (!enabled && !twoStep.isRequired(req.user, res.locals.settings)) return next();
  if (req.path.startsWith('/account/two-step') || req.path.startsWith('/account/confirm') || req.path.startsWith('/account/passkeys')) return next();
  if (enabled && req.session.twoStep) return next();
  if (req.method === 'GET') {
    return res.redirect(enabled ? `/account/confirm?next=${encodeURIComponent(req.originalUrl)}` : '/account/two-step');
  }
  res.status(403).render('error', { title: 'Two-step sign-in needed', message: 'Please finish two-step sign-in first, then try again.' });
}

// Pages that show or change the most sensitive things (full tax ID numbers,
// accounts, company settings) ask for a fresh code if the last one was more
// than 15 minutes ago, so an unattended signed-in computer isn't enough.
const RECENT_CODE_MS = 15 * 60 * 1000;

function hasRecentCode(req) {
  return Boolean(req.session.codeAt && Date.now() - req.session.codeAt < RECENT_CODE_MS);
}

function requireRecentCode(req, res, next) {
  if (!twoStep.hasSecondStep(req.user) || hasRecentCode(req)) return next();
  let back = req.originalUrl;
  if (req.method !== 'GET') {
    // After the code, go back to the page the form was on.
    try {
      const from = new URL(req.get('referer') || '', `${req.protocol}://${req.get('host')}`);
      back = from.host === req.get('host') ? from.pathname + from.search : homeFor(req.user);
    } catch {
      back = homeFor(req.user);
    }
    req.flash('warning', "For your security, confirm it's you, then try again.");
  }
  res.redirect(`/account/confirm?next=${encodeURIComponent(back)}`);
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
  describeDevice,
  requireTwoStep,
  requireRecentCode,
  hasRecentCode,
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
