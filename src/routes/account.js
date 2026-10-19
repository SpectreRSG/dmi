// "My account": anyone's own password, two-step sign-in, where they're signed
// in (and signing out everywhere else), and app notifications for this device.
const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, passwordProblem, endSessionsForUser, homeFor, requireRecentCode, isLockedOut, recordFailedLogin, clearFailedLogins } = require('../auth');
const { logActivity } = require('../helpers');
const notify = require('../services/notify');
const totp = require('../services/totp');
const twoStep = require('../services/twoStep');
const time = require('../time');

const router = express.Router();

async function renderAccount(req, res, error, status = 200) {
  const [sessions, history, codesLeft] = await Promise.all([
    db.all("SELECT sid, data FROM sessions WHERE (data->>'userId')::int = ? AND expires_at > ?", req.user.id, Date.now()),
    db.all(
      `SELECT action, created_at FROM activity_log WHERE user_id = ? AND (action LIKE 'Signed in%' OR action LIKE 'Two-step%')
       ORDER BY id DESC LIMIT 8`,
      req.user.id
    ),
    req.user.totp_enabled_at ? twoStep.recoveryCodesLeft(req.user.id) : 0,
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
    required: twoStep.isRequired(req.user, res.locals.settings),
  });
}

router.get('/two-step', async (req, res) => {
  if (!req.user.totp_enabled_at) return renderSetup(req, res, null);
  res.redirect('/account#two-step');
});

router.post('/two-step', async (req, res) => {
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
  if (!req.user.totp_enabled_at) return res.redirect('/account/two-step');
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
  await logActivity(req, 'Two-step sign-in turned off');
  req.flash('success', 'Two-step sign-in is off. Your password alone now signs you in.');
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
    reason: req.session.twoStep
      ? "This page shows or changes sensitive information, so please type a fresh code from your authenticator app."
      : 'Please type a code from your authenticator app to keep going.',
  });
}

router.get('/confirm', (req, res) => {
  if (!req.user.totp_enabled_at) return res.redirect('/account/two-step');
  renderConfirm(req, res, safeNext(req.query.next) || homeFor(req.user), null);
});

router.post('/confirm', async (req, res) => {
  if (!req.user.totp_enabled_at) return res.redirect('/account/two-step');
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
