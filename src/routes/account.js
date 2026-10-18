// "My account" – lets anyone change their own password.
const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, passwordProblem, endSessionsForUser } = require('../auth');
const { logActivity } = require('../helpers');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('auth/account', { title: 'My account', error: null });
});

router.post('/password', async (req, res) => {
  const { current, password, confirm } = req.body;
  const user = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);

  const error = verifyPassword(current || '', user.password_hash)
    ? passwordProblem(password, confirm)
    : 'Your current password is wrong.';
  if (error) return res.status(400).render('auth/account', { title: 'My account', error });

  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), user.id);
  await endSessionsForUser(user.id, req.sessionID); // sign out everywhere except here
  await logActivity(req, 'Changed their password');
  req.flash('success', 'Your password was changed.');
  res.redirect('/account');
});

module.exports = router;
