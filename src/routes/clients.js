// Clients (customers) and their sites (places where guards work).
const express = require('express');
const db = require('../db');
const { clean, notFound, numericIdParam, logActivity, isInUseError } = require('../helpers');
const { todayStr, addDays } = require('../time');

const clientsRouter = express.Router();
const sitesRouter = express.Router();
numericIdParam(clientsRouter);
numericIdParam(sitesRouter);

const CLIENT_FIELDS = ['name', 'contact_name', 'contact_email', 'contact_phone', 'address', 'notes'];
const SITE_FIELDS = ['name', 'address', 'instructions'];

function findClient(id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
}

function renderClientForm(res, client, error, status = 200) {
  res.status(status).render('clients/form', {
    title: client.id ? `Edit ${client.name}` : 'Add client',
    client,
    error,
  });
}

// ---- Clients ------------------------------------------------------------------

clientsRouter.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const clients = db
    .prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM sites s WHERE s.client_id = c.id AND s.active = 1) AS site_count,
         (SELECT COUNT(*) FROM contracts k WHERE k.client_id = c.id AND k.status = 'active') AS contract_count
       FROM clients c
       WHERE ? = '' OR c.name LIKE ? OR c.contact_name LIKE ? OR c.address LIKE ?
       ORDER BY c.name`
    )
    .all(q, like, like, like);
  res.render('clients/index', { title: 'Clients & sites', clients, q });
});

clientsRouter.get('/new', (req, res) => renderClientForm(res, {}, null));

clientsRouter.post('/', (req, res) => {
  const values = clean(req.body, CLIENT_FIELDS);
  if (!values.name) return renderClientForm(res, values, 'Client name is required.', 400);
  const info = db
    .prepare(
      `INSERT INTO clients (${CLIENT_FIELDS.join(', ')}) VALUES (${CLIENT_FIELDS.map((f) => `@${f}`).join(', ')})`
    )
    .run(values);
  logActivity(req, `Added client ${values.name}`);
  req.flash('success', `${values.name} was added. Now add their sites below.`);
  res.redirect(`/clients/${info.lastInsertRowid}`);
});

clientsRouter.get('/:id', (req, res) => {
  const client = findClient(req.params.id);
  if (!client) return notFound(res, 'client');
  const sites = db.prepare('SELECT * FROM sites WHERE client_id = ? ORDER BY active DESC, name').all(client.id);
  const contracts = db
    .prepare('SELECT * FROM contracts WHERE client_id = ? ORDER BY start_date DESC')
    .all(client.id);
  const today = todayStr();
  const upcomingShifts = db
    .prepare(
      `SELECT s.*, si.name AS site_name, e.first_name, e.last_name
       FROM shifts s JOIN sites si ON si.id = s.site_id LEFT JOIN employees e ON e.id = s.employee_id
       WHERE si.client_id = ? AND s.status = 'scheduled' AND s.start_at >= ? AND s.start_at < ?
       ORDER BY s.start_at`
    )
    .all(client.id, `${today}T00:00`, `${addDays(today, 7)}T00:00`);
  res.render('clients/show', { title: client.name, client, sites, contracts, upcomingShifts, siteError: null });
});

clientsRouter.get('/:id/edit', (req, res) => {
  const client = findClient(req.params.id);
  if (!client) return notFound(res, 'client');
  renderClientForm(res, client, null);
});

clientsRouter.post('/:id', (req, res) => {
  const client = findClient(req.params.id);
  if (!client) return notFound(res, 'client');
  const values = clean(req.body, CLIENT_FIELDS);
  if (!values.name) return renderClientForm(res, { ...values, id: client.id }, 'Client name is required.', 400);
  db.prepare(`UPDATE clients SET ${CLIENT_FIELDS.map((f) => `${f} = @${f}`).join(', ')} WHERE id = @id`).run({
    ...values,
    id: client.id,
  });
  logActivity(req, `Updated client ${values.name}`);
  req.flash('success', 'Changes saved.');
  res.redirect(`/clients/${client.id}`);
});

clientsRouter.post('/:id/delete', (req, res) => {
  const client = findClient(req.params.id);
  if (!client) return notFound(res, 'client');
  try {
    db.prepare('DELETE FROM clients WHERE id = ?').run(client.id);
  } catch (err) {
    if (!isInUseError(err)) throw err;
    req.flash('error', `${client.name} still has sites or contracts, so it can't be deleted. Remove those first.`);
    return res.redirect(`/clients/${client.id}`);
  }
  logActivity(req, `Deleted client ${client.name}`);
  req.flash('success', `${client.name} was deleted.`);
  res.redirect('/clients');
});

// Add a site to a client (the form is on the client's page).
clientsRouter.post('/:id/sites', (req, res) => {
  const client = findClient(req.params.id);
  if (!client) return notFound(res, 'client');
  const values = clean(req.body, SITE_FIELDS);
  if (!values.name) {
    req.flash('error', 'Site name is required.');
    return res.redirect(`/clients/${client.id}`);
  }
  db.prepare('INSERT INTO sites (client_id, name, address, instructions) VALUES (?, ?, ?, ?)').run(
    client.id,
    values.name,
    values.address,
    values.instructions
  );
  logActivity(req, `Added site ${values.name} for ${client.name}`);
  req.flash('success', `Site "${values.name}" was added.`);
  res.redirect(`/clients/${client.id}`);
});

// ---- Sites --------------------------------------------------------------------

function findSite(id) {
  return db
    .prepare('SELECT s.*, c.name AS client_name FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = ?')
    .get(id);
}

sitesRouter.get('/:id/edit', (req, res) => {
  const site = findSite(req.params.id);
  if (!site) return notFound(res, 'site');
  res.render('clients/site-form', { title: `Edit ${site.name}`, site, error: null });
});

sitesRouter.post('/:id', (req, res) => {
  const site = findSite(req.params.id);
  if (!site) return notFound(res, 'site');
  const values = clean(req.body, SITE_FIELDS);
  values.active = req.body.active ? 1 : 0;
  if (!values.name) {
    return res
      .status(400)
      .render('clients/site-form', { title: `Edit ${site.name}`, site: { ...site, ...values }, error: 'Site name is required.' });
  }
  db.prepare('UPDATE sites SET name = ?, address = ?, instructions = ?, active = ? WHERE id = ?').run(
    values.name,
    values.address,
    values.instructions,
    values.active,
    site.id
  );
  logActivity(req, `Updated site ${values.name} (${site.client_name})`);
  req.flash('success', 'Site saved.');
  res.redirect(`/clients/${site.client_id}`);
});

sitesRouter.post('/:id/delete', (req, res) => {
  const site = findSite(req.params.id);
  if (!site) return notFound(res, 'site');
  try {
    db.prepare('DELETE FROM sites WHERE id = ?').run(site.id);
  } catch (err) {
    if (!isInUseError(err)) throw err;
    req.flash('error', `"${site.name}" has shifts or hours recorded, so it can't be deleted. Untick "Active" instead.`);
    return res.redirect(`/clients/${site.client_id}`);
  }
  logActivity(req, `Deleted site ${site.name} (${site.client_name})`);
  req.flash('success', `Site "${site.name}" was deleted.`);
  res.redirect(`/clients/${site.client_id}`);
});

module.exports = { clientsRouter, sitesRouter };
