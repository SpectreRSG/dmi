// User accounts: who can log in to this admin site (admins only).
const express = require('express');
const db = require('../db');
const { hashPassword, passwordProblem, endSessionsForUser } = require('../auth');
const { clean, notFound, numericIdParam, logActivity } = require('../helpers');

const router = express.Router();
numericIdParam(router);

function findUser(id) {
  return db.prepare('SELECT id, name, email, role, active, last_login_at, created_at FROM users WHERE id = ?').get(id);
}

function renderForm(res, user, error, status = 200) {
  res.status(status).render('users/form', { title: user.id ? `Edit ${user.name}` : 'Add user', user, error });
}

function readForm(req, existing) {
  const v = clean(req.body, ['name', 'email', 'role']);
  v.role = v.role === 'admin' ? 'admin' : 'manager';
  v.active = existing && !req.body.active ? 0 : 1;
  const password = req.body.password || '';

  let error = null;
  if (!v.name || !v.email) error = 'Name and email are required.';
  else if (!/^\S+@\S+\.\S+$/.test(v.email)) error = 'Please enter a valid email address.';
  else if (!existing || password) error = passwordProblem(password, req.body.confirm);

  // Stop admins locking themselves out.
  if (!error && existing?.id === req.user.id && (v.role !== 'admin' || !v.active)) {
    error = "You can't remove your own admin access or deactivate yourself. Ask another admin to do it.";
  }
  return { values: v, password, error };
}

router.get('/', (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY active DESC, name').all();
  res.render('users/index', { title: 'User accounts', users });
});

router.get('/new', (req, res) => renderForm(res, { role: 'manager', active: 1 }, null));

router.post('/', (req, res) => {
  const { values, password, error } = readForm(req);
  if (error) return renderForm(res, values, error, 400);
  try {
    db.prepare('INSERT INTO users (name, email, role, password_hash) VALUES (?, ?, ?, ?)').run(
      values.name,
      values.email,
      values.role,
      hashPassword(password)
    );
  } catch (err) {
    if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
    return renderForm(res, values, 'Someone already uses that email address.', 400);
  }
  logActivity(req, `Added ${values.role} account for ${values.name}`);
  req.flash('success', `Account created. Give ${values.name} their email and password so they can sign in.`);
  res.redirect('/users');
});

router.get('/:id/edit', (req, res) => {
  const user = findUser(req.params.id);
  if (!user) return notFound(res, 'user');
  renderForm(res, user, null);
});

router.post('/:id', (req, res) => {
  const user = findUser(req.params.id);
  if (!user) return notFound(res, 'user');
  const { values, password, error } = readForm(req, user);
  if (error) return renderForm(res, { ...values, id: user.id }, error, 400);
  try {
    db.prepare('UPDATE users SET name = ?, email = ?, role = ?, active = ? WHERE id = ?').run(
      values.name,
      values.email,
      values.role,
      values.active,
      user.id
    );
  } catch (err) {
    if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
    return renderForm(res, { ...values, id: user.id }, 'Someone already uses that email address.', 400);
  }
  if (password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
  }
  // A new password or deactivation signs the person out everywhere.
  if ((password || !values.active) && user.id !== req.user.id) endSessionsForUser(user.id);
  logActivity(req, `Updated account for ${values.name}${password ? ' (password reset)' : ''}`);
  req.flash('success', 'Account saved.');
  res.redirect('/users');
});

module.exports = router;
