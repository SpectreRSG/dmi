// Portal access: hand out passphrases so officers and clients can see their
// schedule at /portal without an account.
const express = require('express');
const db = require('../db');
const { clean, toId, notFound, numericIdParam, logActivity, employeeName } = require('../helpers');
const time = require('../time');
const { makePassphrase, fingerprint } = require('../passphrase');

const router = express.Router();
numericIdParam(router);

const SCOPES = {
  employee: 'Officer – sees their own shifts',
  site: 'Site – sees every shift at one site',
  client: 'Client – sees every shift at all their sites',
};

const ACCESS_SELECT = `
  SELECT pa.*, e.first_name, e.last_name, si.name AS site_name, sc.name AS site_client_name, c.name AS client_name
  FROM portal_access pa
  LEFT JOIN employees e ON e.id = pa.employee_id
  LEFT JOIN sites si ON si.id = pa.site_id
  LEFT JOIN clients sc ON sc.id = si.client_id
  LEFT JOIN clients c ON c.id = pa.client_id`;

// "Who or what can this passphrase see?"
function accessName(a) {
  if (a.scope === 'employee') return employeeName(a);
  if (a.scope === 'site') return `${a.site_client_name} – ${a.site_name}`;
  return a.client_name;
}

async function formOptions() {
  const [staff, sites, clients] = await Promise.all([
    db.all("SELECT id, first_name, last_name FROM employees WHERE status = 'active' ORDER BY last_name, first_name"),
    db.all('SELECT si.id, si.name, c.name AS client_name FROM sites si JOIN clients c ON c.id = si.client_id WHERE si.active = 1 ORDER BY c.name, si.name'),
    db.all('SELECT id, name FROM clients ORDER BY name'),
  ]);
  return { staff, sites, clients };
}

async function renderList(req, res, values, error, status = 200) {
  const accesses = await db.all(`${ACCESS_SELECT} ORDER BY pa.scope, pa.created_at DESC, pa.id DESC`);
  res.status(status).render('portal-access/index', {
    title: 'Portal access',
    accesses: accesses.map((a) => ({ ...a, name: accessName(a) })),
    values,
    error,
    SCOPES,
    today: time.todayStr(),
    portalUrl: portalUrl(req),
    ...(await formOptions()),
  });
}

// Makes a passphrase that isn't already in use (clashes are very unlikely).
async function newPassphrase() {
  for (;;) {
    const passphrase = makePassphrase();
    const hash = await fingerprint(passphrase);
    if (!(await db.get('SELECT 1 FROM portal_access WHERE passphrase_hash = ?', hash))) return { passphrase, hash };
  }
}

// The address people type in, like https://dmi.codehound.org/portal
function portalUrl(req) {
  return `${req.protocol}://${req.get('host')}/portal`;
}

function showPassphrase(req, res, access, passphrase) {
  res.render('portal-access/show', { title: 'New passphrase', access: { ...access, name: accessName(access) }, passphrase, portalUrl: portalUrl(req) });
}

router.get('/', async (req, res) => {
  const scope = SCOPES[req.query.scope] ? req.query.scope : 'employee';
  await renderList(req, res, { scope, employee_id: toId(req.query.employee), site_id: toId(req.query.site), client_id: toId(req.query.client) }, null);
});

router.post('/', async (req, res) => {
  const v = clean(req.body, ['scope', 'employee_id', 'site_id', 'client_id', 'label', 'expires_on']);
  const values = {
    scope: SCOPES[v.scope] ? v.scope : null,
    employee_id: null,
    site_id: null,
    client_id: null,
    label: v.label ? v.label.slice(0, 100) : null,
    expires_on: v.expires_on || null,
  };
  let error = null;
  if (!values.scope) error = 'Choose who the passphrase is for.';
  else {
    const field = `${values.scope}_id`;
    const table = { employee: 'employees', site: 'sites', client: 'clients' }[values.scope];
    values[field] = toId(v[field]);
    if (!values[field] || !(await db.get(`SELECT 1 FROM ${table} WHERE id = ?`, values[field]))) {
      error = { employee: 'Choose an officer.', site: 'Choose a site.', client: 'Choose a client.' }[values.scope];
    }
  }
  if (!error && values.expires_on && (!time.isValidDate(values.expires_on) || values.expires_on < time.todayStr())) {
    error = 'The expiry date must be today or later (or left empty).';
  }
  if (error) return renderList(req, res, values, error, 400);

  const { passphrase, hash } = await newPassphrase();
  const id = await db.insert(
    `INSERT INTO portal_access (scope, employee_id, site_id, client_id, label, passphrase_hash, expires_on, created_by)
     VALUES (@scope, @employee_id, @site_id, @client_id, @label, @hash, @expires_on, @created_by)`,
    { ...values, hash, created_by: req.user.id }
  );
  const access = await db.get(`${ACCESS_SELECT} WHERE pa.id = ?`, id);
  await logActivity(req, `Created a portal passphrase for ${accessName(access)}`);
  showPassphrase(req, res, access, passphrase);
});

// Forgotten or shared too widely: swap in a new passphrase (the old one stops working).
router.post('/:id/regenerate', async (req, res) => {
  const access = await db.get(`${ACCESS_SELECT} WHERE pa.id = ?`, req.params.id);
  if (!access) return notFound(res, 'passphrase');
  const { passphrase, hash } = await newPassphrase();
  await db.run('UPDATE portal_access SET passphrase_hash = ?, last_used_at = NULL WHERE id = ?', hash, access.id);
  await logActivity(req, `Replaced the portal passphrase for ${accessName(access)}`);
  showPassphrase(req, res, access, passphrase);
});

router.post('/:id/delete', async (req, res) => {
  const access = await db.get(`${ACCESS_SELECT} WHERE pa.id = ?`, req.params.id);
  if (!access) return notFound(res, 'passphrase');
  await db.run('DELETE FROM portal_access WHERE id = ?', access.id);
  await logActivity(req, `Turned off the portal passphrase for ${accessName(access)}`);
  req.flash('success', `Passphrase for ${accessName(access)} turned off. It no longer works.`);
  res.redirect('/portal-access');
});

module.exports = router;
