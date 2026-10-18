// First-time setup, signing in and signing out.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');
const { saveSettings } = require('../settings');
const { clean, logActivity } = require('../helpers');

const router = express.Router();

// Used when someone types an email that doesn't exist, so the check takes the
// same time either way (attackers can't tell which emails are real).
const DUMMY_HASH = auth.hashPassword(crypto.randomBytes(16).toString('hex'));

let setupDone = false;
function hasUsers() {
  if (!setupDone) setupDone = Boolean(db.prepare('SELECT 1 FROM users LIMIT 1').get());
  return setupDone;
}

// Only allow redirects to pages on this site (not to other websites).
function safeNext(value) {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : '/';
}

function signIn(req, res, next, userId, redirectTo, flashMessage) {
  // A fresh session on login stops "session fixation" attacks.
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = userId;
    if (flashMessage) req.session.flash = [{ type: 'success', message: flashMessage }];
    db.prepare("UPDATE users SET last_login_at = datetime('now', 'localtime') WHERE id = ?").run(userId);
    res.redirect(redirectTo);
  });
}

// Until the first admin account exists, send everyone to the setup page.
router.use((req, res, next) => {
  if (req.path !== '/setup' && !hasUsers()) return res.redirect('/setup');
  next();
});

router.get('/setup', (req, res) => {
  if (hasUsers()) return res.redirect('/login');
  res.render('auth/setup', { title: 'Welcome', values: {}, error: null });
});

router.post('/setup', (req, res, next) => {
  if (hasUsers()) return res.redirect('/login');
  const values = clean(req.body, ['company_name', 'name', 'email']);
  let error = null;
  if (!values.company_name || !values.name || !values.email) error = 'Please fill in every box.';
  else if (!/^\S+@\S+\.\S+$/.test(values.email)) error = 'Please enter a valid email address.';
  else error = auth.passwordProblem(req.body.password, req.body.confirm);
  if (error) return res.status(400).render('auth/setup', { title: 'Welcome', values, error });

  const info = db
    .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
    .run(values.name, values.email, auth.hashPassword(req.body.password));
  saveSettings({ company_name: values.company_name });
  setupDone = true;
  req.user = { id: info.lastInsertRowid };
  logActivity(req, 'Created the first admin account');
  signIn(req, res, next, info.lastInsertRowid, '/', 'Welcome! Your admin account is ready.');
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/login', { title: 'Sign in', email: '', error: null, next: safeNext(req.query.next) });
});

router.post('/login', (req, res, next) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const nextUrl = safeNext(req.body.next);
  const key = auth.loginKey(req, email);
  const fail = (message) =>
    res.status(401).render('auth/login', { title: 'Sign in', email, error: message, next: nextUrl });

  if (auth.isLockedOut(key)) return fail('Too many failed attempts. Please wait 15 minutes and try again.');

  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  const passwordOk = auth.verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    auth.recordFailedLogin(key);
    return fail('Wrong email or password.');
  }

  auth.clearFailedLogins(key);
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
