// User accounts: who can sign in, and what each person can see (admins only).
// People can sign up themselves; their account waits here until an admin gives it a role.
const express = require('express');
const db = require('../db');
const { hashPassword, passwordProblem, endSessionsForUser, requireRecentCode } = require('../auth');
const twoStep = require('../services/twoStep');
const { clean, toId, notFound, numericIdParam, logActivity, isDuplicateError } = require('../helpers');
const { ROLE_NAMES } = require('../viewHelpers');

const router = express.Router();
numericIdParam(router);
// Changing accounts asks for a fresh two-step code (if the last one was over 15 minutes ago).
router.use((req, res, next) => (req.method === 'POST' ? requireRecentCode(req, res, next) : next()));

const ROLES = ['pending', 'officer', 'client', 'manager', 'admin'];

function findUser(id) {
  return db.get(
    `SELECT id, name, email, phone, role, requested_role, employee_id, client_id, active, last_login_at, created_at, totp_enabled_at, two_step_exempt,
       (SELECT COUNT(*)::int FROM passkeys p WHERE p.user_id = users.id) AS passkey_count
     FROM users WHERE id = ?`,
    id
  );
}

async function renderForm(res, user, error, status = 200) {
  const [staff, clients] = await Promise.all([
    // Staff records that don't already belong to another account.
    db.all(
      `SELECT e.id, e.first_name, e.last_name, e.email FROM employees e
       WHERE e.status = 'active' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.employee_id = e.id AND u.id != ?)
       ORDER BY e.last_name, e.first_name`,
      user.id || 0
    ),
    db.all('SELECT id, name FROM clients ORDER BY name'),
  ]);
  res.status(status).render('users/form', {
    title: user.id ? `Edit ${user.name}` : 'Add user',
    user,
    error,
    staff,
    clients,
    ROLES,
  });
}

async function readForm(req, existing) {
  const v = clean(req.body, ['name', 'email', 'phone', 'role', 'employee_id', 'client_id']);
  v.role = ROLES.includes(v.role) ? v.role : 'pending';
  v.active = existing && !req.body.active ? 0 : 1;
  v.new_employee = v.role === 'officer' && v.employee_id === 'new';
  v.employee_id = v.role === 'officer' ? toId(v.employee_id) : null;
  v.client_id = v.role === 'client' ? toId(v.client_id) : null;
  const password = req.body.password || '';

  let error = null;
  if (!v.name || !v.email) error = 'Name and email are required.';
  else if (!/^\S+@\S+\.\S+$/.test(v.email)) error = 'Please enter a valid email address.';
  else if (v.role === 'officer' && !v.employee_id && !v.new_employee) error = "Choose this officer's staff record, or make a new one.";
  else if (v.employee_id && !(await db.get('SELECT 1 FROM employees WHERE id = ?', v.employee_id))) error = 'Please choose a staff record from the list.';
  else if (v.role === 'client' && !v.client_id) error = 'Choose which client this person belongs to.';
  else if (v.client_id && !(await db.get('SELECT 1 FROM clients WHERE id = ?', v.client_id))) error = 'Please choose a client from the list.';
  else if (!existing || password) error = passwordProblem(password, req.body.confirm, v);

  // Stop admins locking themselves out.
  if (!error && existing?.id === req.user.id && (v.role !== 'admin' || !v.active)) {
    error = "You can't remove your own admin access or deactivate yourself. Ask another admin to do it.";
  }
  return { values: v, password, error };
}

// "Make a new staff record" for an officer: starts from what they typed when signing up.
async function createStaffRecord(tx, values) {
  const parts = values.name.trim().split(/\s+/);
  const lastName = parts.length > 1 ? parts.pop() : '';
  return tx.insert(
    "INSERT INTO employees (first_name, last_name, email, phone, position, status) VALUES (?, ?, ?, ?, 'Unarmed Security Officer', 'active')",
    parts.join(' '),
    lastName,
    values.email,
    values.phone
  );
}

// Saves the account (new or existing). Returns an error message, or null.
async function saveUser(req, values, password, existing) {
  try {
    await db.transaction(async (tx) => {
      if (values.new_employee) values.employee_id = await createStaffRecord(tx, values);
      const fields = [values.name, values.email, values.phone, values.role, values.employee_id, values.client_id];
      if (existing) {
        await tx.run(
          'UPDATE users SET name = ?, email = ?, phone = ?, role = ?, employee_id = ?, client_id = ?, active = ? WHERE id = ?',
          ...fields,
          values.active,
          existing.id
        );
        if (password) await tx.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), existing.id);
      } else {
        await tx.run(
          'INSERT INTO users (name, email, phone, role, employee_id, client_id, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ...fields,
          hashPassword(password)
        );
      }
    });
  } catch (err) {
    if (!isDuplicateError(err)) throw err;
    return /employee/.test(err.constraint || err.message || '')
      ? 'That staff record already belongs to another account.'
      : 'Someone already uses that email address.';
  }
  return null;
}

router.get('/', async (req, res) => {
  const users = await db.all(
    `SELECT u.*, e.first_name, e.last_name, c.name AS client_name,
       (SELECT COUNT(*)::int FROM passkeys p WHERE p.user_id = u.id) AS passkey_count
     FROM users u
     LEFT JOIN employees e ON e.id = u.employee_id LEFT JOIN clients c ON c.id = u.client_id
     ORDER BY (u.role = 'pending' AND u.active = 1) DESC, u.active DESC, u.name`
  );
  res.render('users/index', { title: 'User accounts', users });
});

router.get('/new', (req, res) => renderForm(res, { role: 'officer', active: 1 }, null));

router.post('/', async (req, res) => {
  const { values, password, error } = await readForm(req);
  if (error) return renderForm(res, values, error, 400);
  const saveError = await saveUser(req, values, password, null);
  if (saveError) return renderForm(res, values, saveError, 400);
  await logActivity(req, `Added ${ROLE_NAMES[values.role].toLowerCase()} account for ${values.name}`);
  req.flash('success', `Account created. Give ${values.name} their email and password so they can sign in.`);
  res.redirect('/users');
});

router.get('/:id/edit', async (req, res) => {
  const user = await findUser(req.params.id);
  if (!user) return notFound(res, 'user');
  // A new sign-up: suggest the role they asked for.
  await renderForm(res, user.role === 'pending' ? { ...user, role: user.requested_role || 'officer', approving: true } : user, null);
});

router.post('/:id', async (req, res) => {
  const user = await findUser(req.params.id);
  if (!user) return notFound(res, 'user');
  const { values, password, error } = await readForm(req, user);
  if (error) return renderForm(res, { ...values, id: user.id, requested_role: user.requested_role }, error, 400);
  const saveError = await saveUser(req, values, password, user);
  if (saveError) return renderForm(res, { ...values, id: user.id, requested_role: user.requested_role }, saveError, 400);
  // A new password or deactivation signs the person out everywhere.
  if ((password || !values.active) && user.id !== req.user.id) await endSessionsForUser(user.id);
  if (password || !values.active) await twoStep.forgetDevices(user.id);
  const roleNote = values.role !== user.role ? ` (now ${ROLE_NAMES[values.role].toLowerCase()})` : '';
  await logActivity(req, `Updated account for ${values.name}${roleNote}${password ? ' (password reset)' : ''}`);
  req.flash('success', values.new_employee ? `Account saved, and a staff record was made for ${values.name}. Set their pay rate on the Staff page.` : 'Account saved.');
  res.redirect('/users');
});

// Lost phone: turns off their two-step sign-in and signs them out everywhere.
// They set it up again (with their new phone) at their next sign-in.
router.post('/:id/reset-two-step', async (req, res) => {
  const user = await findUser(req.params.id);
  if (!user) return notFound(res, 'user');
  await twoStep.reset(user.id);
  if (user.id !== req.user.id) await endSessionsForUser(user.id);
  await logActivity(req, `Reset two-step sign-in for ${user.name}`);
  req.flash('success', `Two-step sign-in reset for ${user.name}. Their passkeys were removed too. They'll set it up again the next time they sign in.`);
  res.redirect(`/users/${user.id}/edit`);
});

module.exports = router;
