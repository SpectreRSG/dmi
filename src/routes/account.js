// "My account": anyone's own password, two-step sign-in (authenticator app
// and passkeys), where they're signed in (and signing out everywhere else),
// and app notifications for this device.
const express = require('express');
const db = require('../db');
const {
  hashPassword, verifyPassword, passwordProblem, endSessionsForUser, homeFor, requireRecentCode, hasRecentCode, isLockedOut,
  recordFailedLogin, clearFailedLogins, describeDevice,
} = require('../auth');
const { logActivity } = require('../helpers');
const notify = require('../services/notify');
const totp = require('../services/totp');
const twoStep = require('../services/twoStep');
const passkeys = require('../services/passkeys');
const time = require('../time');

const router = express.Router();

async function renderAccount(req, res, error, status = 200) {
  const [sessions, history, codesLeft, myPasskeys] = await Promise.all([
    db.all("SELECT sid, data FROM sessions WHERE (data->>'userId')::int = ? AND expires_at > ?", req.user.id, Date.now()),
    db.all(
      `SELECT action, created_at FROM activity_log WHERE user_id = ? AND (action LIKE 'Signed in%' OR action LIKE 'Two-step%')
       ORDER BY id DESC LIMIT 8`,
      req.user.id
    ),
    twoStep.hasSecondStep(req.user) ? twoStep.recoveryCodesLeft(req.user.id) : 0,
    passkeys.forUser(req.user.id),
  ]);
  const devices = sessions
    .map((row) => ({
      current: row.sid === req.sessionID,
      device: row.data.device || 'Unknown device',
      since: row.data.signedInLocal,
      at: row.data.signedInAt || 0,
    }))
    .sort((a, b) => b.current - a.current || b.at - a.at);
  res.status(status).render('auth/account', {
    title: 'My account',
    error,
    pushKey: await notify.publicKey(),
    devices,
    history,
    codesLeft,
    passkeys: myPasskeys,
    hasSecondStep: twoStep.hasSecondStep(req.user),
    twoStepRequired: twoStep.isRequired(req.user, res.locals.settings),
  });
}

router.get('/', (req, res) => renderAccount(req, res, null));

// Signs out every other phone and computer, and forgets remembered devices.
router.post('/sign-out-others', async (req, res) => {
  await endSessionsForUser(req.user.id, req.sessionID);
  await twoStep.forgetDevices(req.user.id);
  await logActivity(req, 'Signed out of all other devices');
  req.flash('success', "You're signed out everywhere else. Remembered devices will need a code again.");
  res.redirect('/account');
});

// ---- Two-step sign-in -------------------------------------------------------------

// Setting it up: a new secret key is kept in the session until a code proves
// the app has it; only then is it saved.
async function renderSetup(req, res, error, status = 200) {
  const setup = req.session.twoStepSetup;
  if (!setup || Date.now() - setup.at > 30 * 60 * 1000) req.session.twoStepSetup = { secret: totp.newSecret(), at: Date.now() };
  const { secret } = req.session.twoStepSetup;
  const link = totp.setupLink({ secret, account: req.user.email, issuer: res.locals.settings.company_name || 'DMI' });
  res.status(status).render('auth/two-step-setup', {
    title: 'Set up two-step sign-in',
    error,
    secret,
    link,
    qr: totp.qrCode(link),
    hasPasskey: Number(req.user.passkey_count) > 0,
    required: twoStep.isRequired(req.user, res.locals.settings) && !twoStep.hasSecondStep(req.user),
  });
}

router.get('/two-step', async (req, res) => {
  if (!req.user.totp_enabled_at) return renderSetup(req, res, null);
  res.redirect('/account#two-step');
});

router.post('/two-step', requireRecentCode, async (req, res) => {
  if (req.user.totp_enabled_at) return res.redirect('/account#two-step');
  const secret = req.session.twoStepSetup?.secret;
  const step = secret ? twoStep.checkNewSecret(secret, req.body.code) : null;
  if (step === null) {
    return renderSetup(req, res, "That code didn't match. Check the app shows a code for this site, then type the newest one.", 400);
  }
  const codes = await twoStep.enable(req.user.id, secret, step);
  delete req.session.twoStepSetup;
  Object.assign(req.session, { twoStep: 'code', codeAt: Date.now() });
  await endSessionsForUser(req.user.id, req.sessionID); // anyone else signed in with just the password is signed out
  await logActivity(req, 'Two-step sign-in turned on');
  res.render('auth/backup-codes', { title: 'Backup codes', codes, fresh: true, next: homeFor(req.user), now: time.nowStr() });
});

router.post('/two-step/backup-codes', requireRecentCode, async (req, res) => {
  if (!twoStep.hasSecondStep(req.user)) return res.redirect('/account/two-step');
  const codes = await twoStep.newRecoveryCodes(req.user.id);
  await logActivity(req, 'Two-step sign-in: made new backup codes');
  res.render('auth/backup-codes', { title: 'Backup codes', codes, fresh: false, next: '/account', now: time.nowStr() });
});

router.post('/two-step/off', requireRecentCode, async (req, res) => {
  if (twoStep.isRequired(req.user, res.locals.settings)) {
    req.flash('error', 'Two-step sign-in is required for your account, so it stays on.');
    return res.redirect('/account');
  }
  await twoStep.reset(req.user.id);
  await logActivity(req, 'Two-step sign-in turned off (app and passkeys)');
  req.flash('success', 'Two-step sign-in is off, and your passkeys were removed. Your password alone now signs you in.');
  res.redirect('/account');
});

// "Confirm it's you": a fresh code, before sensitive pages (or for a session
// that signed in before two-step sign-in was turned on).
function safeNext(value) {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : null;
}

function renderConfirm(req, res, next, error, status = 200) {
  res.status(status).render('auth/confirm', {
    title: "Confirm it's you",
    error,
    next,
    hasApp: Boolean(req.user.totp_enabled_at),
    hasPasskey: Number(req.user.passkey_count) > 0,
    reason: req.session.twoStep
      ? 'This page shows or changes sensitive information, so please confirm it\'s you.'
      : 'Please confirm it\'s you to keep going.',
  });
}

router.get('/confirm', (req, res) => {
  if (!twoStep.hasSecondStep(req.user)) return res.redirect('/account/two-step');
  renderConfirm(req, res, safeNext(req.query.next) || homeFor(req.user), null);
});

router.post('/confirm', async (req, res) => {
  if (!twoStep.hasSecondStep(req.user)) return res.redirect('/account/two-step');
  const next = safeNext(req.body.next) || homeFor(req.user);
  const key = `code|${req.user.id}`;
  if (await isLockedOut(key)) return renderConfirm(req, res, next, 'Too many wrong codes. Please wait 15 minutes.', 429);
  const result = await twoStep.verify(req.user.id, req.body.code);
  if (!result.ok) {
    await recordFailedLogin(key);
    return renderConfirm(req, res, next, result.reused ? 'That code was already used. Wait for the next one.' : 'That code is not right.', 400);
  }
  await clearFailedLogins(key);
  Object.assign(req.session, { twoStep: req.session.twoStep || 'code', codeAt: Date.now() });
  res.redirect(next);
});

// With a passkey instead of a code.
router.get('/confirm/passkey-options', async (req, res) => {
  res.json(await passkeys.requestOptions(req, 'confirm', req.user.id));
});

router.post('/confirm/passkey', async (req, res) => {
  const result = await passkeys.authenticate(req, 'confirm', req.body, req.user.id);
  if (result.error) return res.status(400).json({ error: result.error });
  Object.assign(req.session, { twoStep: req.session.twoStep || 'passkey', codeAt: Date.now() });
  res.json({ redirect: safeNext(req.body.next) || homeFor(req.user) });
});

// ---- Passkeys -----------------------------------------------------------------------
// Face ID, Touch ID, a fingerprint or the device's PIN, instead of a password
// and code. Adding the first one can complete two-step setup on its own.

// Someone who already has two-step sign-in must have confirmed it's them
// recently before adding or removing a passkey.
function passkeyNeedsConfirm(req, res) {
  if (!twoStep.hasSecondStep(req.user) || hasRecentCode(req)) return false;
  res.status(403).json({ error: "For your security, confirm it's you first.", redirect: '/account/confirm?next=%2Faccount%23passkeys' });
  return true;
}

router.get('/passkeys/options', async (req, res) => {
  if (passkeyNeedsConfirm(req, res)) return;
  res.json(await passkeys.creationOptions(req, req.user, res.locals.settings.company_name));
});

router.post('/passkeys', async (req, res) => {
  if (passkeyNeedsConfirm(req, res)) return;
  const firstStep = !twoStep.hasSecondStep(req.user);
  const result = await passkeys.register(req, req.user, req.body, describeDevice(req.get('user-agent')));
  if (result.error) return res.status(400).json({ error: result.error });
  await logActivity(req, `Added a passkey (${result.passkey.name || 'device'})`);
  if (firstStep) {
    // Two-step sign-in is now on: this session counts as checked, and
    // anyone else signed in with just the password is signed out.
    Object.assign(req.session, { twoStep: 'passkey', codeAt: Date.now() });
    await endSessionsForUser(req.user.id, req.sessionID);
  }
  const codes = await twoStep.ensureRecoveryCodes(req.user.id);
  if (codes) {
    req.session.newBackupCodes = { codes, next: firstStep ? homeFor(req.user) : '/account' };
    return res.json({ redirect: '/account/backup-codes' });
  }
  req.flash('success', 'Passkey added. Next time, choose "Sign in with a passkey".');
  res.json({ redirect: '/account#passkeys' });
});

// Backup codes made along with a passkey, shown once.
router.get('/backup-codes', (req, res) => {
  const fresh = req.session.newBackupCodes;
  if (!fresh) return res.redirect('/account');
  delete req.session.newBackupCodes;
  res.render('auth/backup-codes', { title: 'Backup codes', codes: fresh.codes, fresh: true, next: fresh.next, now: time.nowStr() });
});

router.post('/passkeys/:id/delete', requireRecentCode, async (req, res) => {
  const passkey = await db.get('SELECT * FROM passkeys WHERE id = ? AND user_id = ?', Number(req.params.id) || 0, req.user.id);
  if (!passkey) {
    req.flash('error', 'That passkey was already removed.');
    return res.redirect('/account#passkeys');
  }
  const lastStep = !req.user.totp_enabled_at && req.user.passkey_count <= 1;
  if (lastStep && twoStep.isRequired(req.user, res.locals.settings)) {
    req.flash('error', "This is your only way to do two-step sign-in, which your account needs. Add another passkey or set up the authenticator app first.");
    return res.redirect('/account#passkeys');
  }
  await db.run('DELETE FROM passkeys WHERE id = ?', passkey.id);
  await logActivity(req, `Removed a passkey (${passkey.name || 'device'})`);
  req.flash('success', 'Passkey removed. You may also want to delete it from the device (on iPhone: Settings → Passwords).');
  res.redirect('/account#passkeys');
});

router.post('/password', async (req, res) => {
  const { current, password, confirm } = req.body;
  const user = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);

  const error = verifyPassword(current || '', user.password_hash)
    ? passwordProblem(password, confirm, user)
    : 'Your current password is wrong.';
  if (error) return renderAccount(req, res, error, 400);

  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), user.id);
  await endSessionsForUser(user.id, req.sessionID); // sign out everywhere except here
  await twoStep.forgetDevices(user.id);
  await logActivity(req, 'Changed their password');
  req.flash('success', 'Your password was changed. You were signed out on your other devices.');
  res.redirect('/account');
});

// ---- App notifications (the box's script sends these) ---------------------------

// What a browser sends: the device's address (always https) and two keys.
function readSubscription(body) {
  const value = (name, max) => (typeof body[name] === 'string' && body[name].length <= max ? body[name] : null);
  const endpoint = value('endpoint', 1000);
  const keyOk = (k) => k && /^[A-Za-z0-9_-]+=*$/.test(k);
  const sub = { endpoint, p256dh: value('p256dh', 200), auth: value('auth', 100), device: value('device', 40) };
  return endpoint && /^https:\/\//.test(endpoint) && keyOk(sub.p256dh) && keyOk(sub.auth) ? sub : null;
}

router.post('/push', async (req, res) => {
  const sub = readSubscription(req.body);
  if (!sub) return res.status(400).json({ error: 'That notification address is not valid.' });
  await notify.saveSubscription(req.user.id, sub);
  await logActivity(req, `Turned on notifications (${sub.device || 'a device'})`);
  res.json({ ok: true });
});

router.post('/push/remove', async (req, res) => {
  if (typeof req.body.endpoint === 'string') await notify.removeSubscription(req.user.id, req.body.endpoint);
  res.json({ ok: true });
});

router.post('/push/test', async (req, res) => {
  const sent = await notify.notifyUsers([req.user.id], {
    title: 'Notifications are on',
    body: "This is how DMI will let you know about shifts. You don't need to do anything.",
    url: '/account',
    tag: 'test',
  });
  res.json({ sent });
});

module.exports = router;
