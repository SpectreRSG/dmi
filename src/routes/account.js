// "My account" – lets anyone change their own password and turn app
// notifications on or off for the device they're using.
const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, passwordProblem, endSessionsForUser } = require('../auth');
const { logActivity } = require('../helpers');
const notify = require('../services/notify');

const router = express.Router();

async function renderAccount(res, error, status = 200) {
  res.status(status).render('auth/account', { title: 'My account', error, pushKey: await notify.publicKey() });
}

router.get('/', (req, res) => renderAccount(res, null));

router.post('/password', async (req, res) => {
  const { current, password, confirm } = req.body;
  const user = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);

  const error = verifyPassword(current || '', user.password_hash)
    ? passwordProblem(password, confirm)
    : 'Your current password is wrong.';
  if (error) return renderAccount(res, error, 400);

  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), user.id);
  await endSessionsForUser(user.id, req.sessionID); // sign out everywhere except here
  await logActivity(req, 'Changed their password');
  req.flash('success', 'Your password was changed.');
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
