// First-time setup, signing in and signing out.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const { saveSettings } = require('../settings');
const { clean, logActivity } = require('../helpers');

const router = express.Router();

// Used when someone types an email that doesn't exist, so the check takes the
// same time either way (attackers can't tell which emails are real).
const DUMMY_HASH = auth.hashPassword(crypto.randomBytes(16).toString('hex'));

let setupDone = false;
async function hasUsers() {
  if (!setupDone) setupDone = Boolean(await db.get('SELECT 1 FROM users LIMIT 1'));
  return setupDone;
}

// Only allow redirects to pages on this site (not to other websites).
function safeNext(value) {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : '/';
}

function sameText(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function signIn(req, res, next, userId, redirectTo, flashMessage) {
  // A fresh session on login stops "session fixation" attacks.
  req.session.regenerate(async (err) => {
    if (err) return next(err);
    try {
      req.session.userId = userId;
      if (flashMessage) req.session.flash = [{ type: 'success', message: flashMessage }];
      await db.run('UPDATE users SET last_login_at = app_now() WHERE id = ?', userId);
      res.redirect(redirectTo);
    } catch (error) {
      next(error);
    }
  });
}

function renderSetup(res, values, error, status = 200) {
  res.status(status).render('auth/setup', { title: 'Welcome', values, error, needsCode: Boolean(config.setupCode) });
}

// Until the first admin account exists, send everyone to the setup page.
router.use(async (req, res, next) => {
  if (req.path !== '/setup' && !(await hasUsers())) return res.redirect('/setup');
  next();
});

router.get('/setup', async (req, res) => {
  if (await hasUsers()) return res.redirect('/login');
  renderSetup(res, {}, null);
});

router.post('/setup', async (req, res, next) => {
  if (await hasUsers()) return res.redirect('/login');
  const values = clean(req.body, ['company_name', 'name', 'email']);
  let error = null;
  if (config.setupCode && !sameText(String(req.body.setup_code || '').trim(), config.setupCode)) {
    error = 'That setup code is not right.';
  } else if (!values.company_name || !values.name || !values.email) error = 'Please fill in every box.';
  else if (!/^\S+@\S+\.\S+$/.test(values.email)) error = 'Please enter a valid email address.';
  else error = auth.passwordProblem(req.body.password, req.body.confirm);
  if (error) return renderSetup(res, values, error, 400);

  const userId = await db.insert(
    "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')",
    values.name,
    values.email,
    auth.hashPassword(req.body.password)
  );
  await saveSettings({ company_name: values.company_name });
  setupDone = true;
  req.user = { id: userId };
  await logActivity(req, 'Created the first admin account');
  signIn(req, res, next, userId, '/', 'Welcome! Your admin account is ready.');
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/login', { title: 'Sign in', email: '', error: null, next: safeNext(req.query.next) });
});

router.post('/login', async (req, res, next) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const nextUrl = safeNext(req.body.next);
  const key = auth.loginKey(req, email);
  const fail = (message) =>
    res.status(401).render('auth/login', { title: 'Sign in', email, error: message, next: nextUrl });

  if (await auth.isLockedOut(key)) return fail('Too many failed attempts. Please wait 15 minutes and try again.');

  const user = await db.get('SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1', email);
  const passwordOk = auth.verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    await auth.recordFailedLogin(key);
    return fail('Wrong email or password.');
  }

  await auth.clearFailedLogins(key);
  signIn(req, res, next, user.id, nextUrl);
});

router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('dmi.sid');
    res.redirect('/login');
  });
});

module.exports = router;
