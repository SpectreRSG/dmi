// First-time setup, signing in (password, then a two-step code) and signing out.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');
const { getSetupCode } = require('../secrets');
const { saveSettings } = require('../settings');
const { clean, logActivity } = require('../helpers');
const twoStep = require('../services/twoStep');
const passkeys = require('../services/passkeys');
const { notifyUsers } = require('../services/notify');
const config = require('../config');
const time = require('../time');

const router = express.Router();

// Used when someone types an email that doesn't exist, so the check takes the
// same time either way (attackers can't tell which emails are real).
const DUMMY_HASH = auth.hashPassword(crypto.randomBytes(16).toString('hex'));

// Setup is finished once there's an admin account (other accounts, like the
// test officer, don't count: someone still has to be able to run the site).
let setupDone = false;
async function hasUsers() {
  if (!setupDone) setupDone = Boolean(await db.get("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1"));
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

// A fresh session (stops "session fixation" attacks), then the work.
function freshSession(req, next, work) {
  req.session.regenerate((err) => {
    if (err) return next(err);
    Promise.resolve(work()).catch(next);
  });
}

// Signs someone in. `how` is how they passed two-step sign-in: 'code' (typed
// a code just now), 'passkey', 'device' (a remembered device), or null (not
// set up yet). With `json`, answers the page's script instead of redirecting.
function signIn(req, res, next, userId, redirectTo, { flash = null, how = null, json = false } = {}) {
  freshSession(req, next, async () => {
    const device = auth.describeDevice(req.get('user-agent'));
    Object.assign(req.session, { userId, signedInAt: Date.now(), signedInLocal: time.nowStr(), device, ip: req.ip, twoStep: how });
    if (how === 'code' || how === 'passkey') req.session.codeAt = Date.now();
    if (flash) req.session.flash = [{ type: 'success', message: flash }];
    await db.run('UPDATE users SET last_login_at = app_now() WHERE id = ?', userId);
    req.user = { id: userId };
    await logActivity(req, `Signed in (${device}${how === 'device' ? ', remembered device' : how === 'passkey' ? ', passkey' : ''})`);
    // A heads-up on their other devices, in case it wasn't them.
    if (how !== 'device') {
      await notifyUsers([userId], {
        title: 'New sign-in to your DMI account',
        body: `${device}, just now. If this wasn't you, change your password and tell the office.`,
        url: '/account',
        tag: 'sign-in',
      });
    }
    if (json) return res.json({ redirect: redirectTo });
    res.redirect(redirectTo);
  });
}

// Shows the setup page. If the setup code was made by the app (not set in
// Netlify), it's written to the function logs, which only you can see.
async function renderSetup(res, values, error, status = 200) {
  const setup = await getSetupCode();
  if (setup && !setup.fromEnvironment) {
    console.log(`Setup code for the first admin account: ${setup.code}`);
  }
  res.status(status).render('auth/setup', { title: 'Welcome', values, error, needsCode: Boolean(setup) });
}

// Until the first admin account exists, send everyone to the setup page.
router.use(async (req, res, next) => {
  if (req.path !== '/setup' && !(await hasUsers())) return res.redirect('/setup');
  next();
});

router.get('/setup', async (req, res) => {
  if (await hasUsers()) return res.redirect('/login');
  await renderSetup(res, {}, null);
});

router.post('/setup', async (req, res, next) => {
  if (await hasUsers()) return res.redirect('/login');
  const values = clean(req.body, ['company_name', 'name', 'email']);
  const setup = await getSetupCode();
  let error = null;
  if (setup && !sameText(String(req.body.setup_code || '').trim(), setup.code)) {
    error = 'That setup code is not right.';
  } else if (!values.company_name || !values.name || !values.email) error = 'Please fill in every box.';
  else if (!/^\S+@\S+\.\S+$/.test(values.email)) error = 'Please enter a valid email address.';
  else error = auth.passwordProblem(req.body.password, req.body.confirm, values);
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
  signIn(req, res, next, userId, '/', { flash: 'Welcome! Your admin account is ready. Next, set up two-step sign-in.' });
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(auth.homeFor(req.user));
  delete req.session.twoStepPending; // "Start again" from the code page
  res.render('auth/login', { title: 'Sign in', email: '', error: null, next: safeNext(req.query.next) });
});

router.post('/login', async (req, res, next) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const nextUrl = safeNext(req.body.next);
  const key = auth.loginKey(req, email);
  const fail = (message) =>
    res.status(401).render('auth/login', { title: 'Sign in', email, error: message, next: nextUrl });

  // 5 wrong passwords for one email from one connection, or 30 for any emails
  // (someone trying lots of accounts), and that connection waits 15 minutes.
  const connectionKey = `ip|${req.ip}`;
  if ((await auth.isLockedOut(key)) || (await auth.isLockedOut(connectionKey, 30))) {
    return fail('Too many failed attempts. Please wait 15 minutes and try again.');
  }

  const user = await db.get('SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1', email);
  const passwordOk = auth.verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    await auth.recordFailedLogin(key);
    await auth.recordFailedLogin(connectionKey);
    return fail('Wrong email or password.');
  }

  await auth.clearFailedLogins(key);
  const goTo = nextUrl === '/' ? auth.homeFor(user) : nextUrl;
  const hasPasskey = await db.get('SELECT 1 FROM passkeys WHERE user_id = ? LIMIT 1', user.id);
  if (!user.totp_enabled_at && !hasPasskey) return signIn(req, res, next, user.id, goTo); // they're asked to set it up next, if needed
  if (await twoStep.isTrustedDevice(req, user.id)) return signIn(req, res, next, user.id, goTo, { how: 'device' });
  // Password right: now the code. Not signed in until then.
  freshSession(req, next, () => {
    req.session.twoStepPending = { userId: user.id, next: goTo, at: Date.now() };
    res.redirect('/login/verify');
  });
});

// ---- The second step: a code from their authenticator app (or a backup code) ----

const PENDING_MS = 10 * 60 * 1000; // the password counts for 10 minutes

function pendingUser(req) {
  const pending = req.session.twoStepPending;
  return pending && Date.now() - pending.at < PENDING_MS ? pending : null;
}

async function renderVerify(req, res, error, status = 200) {
  const pending = pendingUser(req);
  const user = pending && await db.get(
    'SELECT totp_enabled_at, (SELECT COUNT(*)::int FROM passkeys p WHERE p.user_id = users.id) AS passkeys FROM users WHERE id = ?',
    pending.userId
  );
  res.status(status).render('auth/verify', {
    title: 'Two-step sign-in', error, trustDays: twoStep.TRUST_DAYS, hasApp: Boolean(user?.totp_enabled_at), hasPasskey: user?.passkeys > 0,
  });
}

router.get('/login/verify', (req, res) => {
  if (!pendingUser(req)) return res.redirect('/login');
  renderVerify(req, res, null);
});

router.post('/login/verify', async (req, res, next) => {
  const pending = pendingUser(req);
  if (!pending) {
    req.flash('error', 'That took too long. Please sign in again.');
    return res.redirect('/login');
  }
  const key = `code|${pending.userId}`;
  if (await auth.isLockedOut(key)) {
    delete req.session.twoStepPending;
    req.flash('error', 'Too many wrong codes. Please wait 15 minutes and sign in again.');
    return res.redirect('/login');
  }
  const result = await twoStep.verify(pending.userId, req.body.code);
  if (!result.ok) {
    await auth.recordFailedLogin(key);
    if (await auth.isLockedOut(key)) {
      req.user = { id: pending.userId };
      await logActivity(req, 'Two-step sign-in blocked after 5 wrong codes');
      await notifyUsers([pending.userId], {
        title: 'Someone tried to sign in to your DMI account',
        body: 'The right password was used, but not the right code. If this wasn\'t you, change your password and tell the office.',
        url: '/account',
        tag: 'sign-in',
      });
    }
    const message = result.reused
      ? 'That code was already used. Wait for the next one in your app (they change every 30 seconds).'
      : 'That code is not right. Check your authenticator app and try again.';
    return renderVerify(req, res, message, 400);
  }
  await auth.clearFailedLogins(key);
  if (req.body.remember) await twoStep.trustDevice(res, pending.userId, auth.describeDevice(req.get('user-agent')), config.https);
  let flash = null;
  if (result.method === 'backup') {
    const left = await twoStep.recoveryCodesLeft(pending.userId);
    flash = `Signed in with a backup code. You have ${left} left${left < 4 ? ': make new ones under My account → Two-step sign-in' : ''}.`;
  }
  signIn(req, res, next, pending.userId, pending.next, { how: 'code', flash });
});

// ---- Passkeys (Face ID, Touch ID, a fingerprint or the device's PIN) --------------------
// Instead of a password and code, or as the second step after a password.

router.get('/login/passkey/options', async (req, res) => {
  const pending = pendingUser(req);
  res.json(await passkeys.requestOptions(req, 'login', pending?.userId));
});

router.post('/login/passkey', async (req, res, next) => {
  const connectionKey = `passkey|${req.ip}`;
  if (await auth.isLockedOut(connectionKey, 20)) return res.status(429).json({ error: 'Too many tries. Please wait 15 minutes.' });
  const pending = pendingUser(req);
  const result = await passkeys.authenticate(req, 'login', req.body, pending?.userId);
  if (result.error) {
    await auth.recordFailedLogin(connectionKey);
    return res.status(400).json({ error: result.error });
  }
  const user = await db.get('SELECT * FROM users WHERE id = ?', result.passkey.user_id);
  const nextUrl = safeNext(req.body.next);
  const goTo = pending?.next || (nextUrl === '/' ? auth.homeFor(user) : nextUrl);
  signIn(req, res, next, user.id, goTo, { how: 'passkey', json: true });
});

// ---- New accounts -----------------------------------------------------------
// Anyone can sign up, but a new account can't see anything until an admin
// gives it a role (Officer, Client, Manager or Admin) on the User accounts page.

const SIGNUP_KINDS = { officer: 'Security officer', client: 'Client (I hire DMI)' };

function renderRegister(res, values, error, status = 200) {
  res.status(status).render('auth/register', { title: 'Create an account', values, error, SIGNUP_KINDS });
}

router.get('/register', (req, res) => {
  if (req.user) return res.redirect(auth.homeFor(req.user));
  renderRegister(res, { requested_role: 'officer' }, null);
});

router.post('/register', async (req, res, next) => {
  const values = clean(req.body, ['name', 'email', 'phone', 'requested_role']);
  if (!SIGNUP_KINDS[values.requested_role]) values.requested_role = 'officer';
  // At most 5 new accounts from one address every 15 minutes (counted like wrong passwords).
  const key = `register|${req.ip}`;
  if (await auth.isLockedOut(key)) {
    return renderRegister(res, values, 'Too many new accounts from this connection. Please try again later.', 429);
  }
  let error = null;
  if (!values.name || !values.email) error = 'Please fill in your name and email.';
  else if (!/^\S+@\S+\.\S+$/.test(values.email)) error = 'Please enter a valid email address.';
  else error = auth.passwordProblem(req.body.password, req.body.confirm, values);
  if (error) return renderRegister(res, values, error, 400);

  let userId;
  try {
    userId = await db.insert(
      "INSERT INTO users (name, email, phone, password_hash, role, requested_role) VALUES (?, ?, ?, ?, 'pending', ?)",
      values.name.slice(0, 100),
      values.email,
      values.phone ? values.phone.slice(0, 40) : null,
      auth.hashPassword(req.body.password),
      values.requested_role
    );
  } catch (err) {
    if (err?.code !== '23505') throw err;
    return renderRegister(res, values, 'There is already an account with that email. Try signing in instead.', 400);
  }
  await auth.recordFailedLogin(key);
  req.user = { id: userId };
  await logActivity(req, `Signed up as a ${SIGNUP_KINDS[values.requested_role].toLowerCase()} (waiting for a role)`);
  signIn(req, res, next, userId, '/waiting', { flash: 'Your account is created.' });
});

router.get('/waiting', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'pending') return res.redirect(auth.homeFor(req.user));
  res.render('auth/waiting', { title: 'Waiting for approval' });
});

router.post('/logout', async (req, res, next) => {
  if (req.user) await logActivity(req, 'Signed out');
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('dmi.sid');
    res.redirect('/login');
  });
});

module.exports = router;
