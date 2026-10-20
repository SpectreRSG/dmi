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
  return db.get('SELECT * FROM clients WHERE id = ?', id);
}

function renderClientForm(res, client, error, status = 200) {
  res.status(status).render('clients/form', {
    title: client.id ? `Edit ${client.name}` : 'Add client',
    client,
    error,
  });
}

// ---- Clients ------------------------------------------------------------------

clientsRouter.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const clients = await db.all(
    `SELECT c.*,
       (SELECT COUNT(*)::int FROM sites s WHERE s.client_id = c.id AND s.active = 1) AS site_count,
       (SELECT COUNT(*)::int FROM contracts k WHERE k.client_id = c.id AND k.status = 'active') AS contract_count
     FROM clients c
     WHERE ? = '' OR c.name ILIKE ? OR c.contact_name ILIKE ? OR c.address ILIKE ?
     ORDER BY c.name`,
    q,
    like,
    like,
    like
  );
  res.render('clients/index', { title: 'Clients & sites', clients, q });
});

clientsRouter.get('/new', (req, res) => renderClientForm(res, {}, null));

clientsRouter.post('/', async (req, res) => {
  const values = clean(req.body, CLIENT_FIELDS);
  if (!values.name) return renderClientForm(res, values, 'Client name is required.', 400);
  const id = await db.insert(
    `INSERT INTO clients (${CLIENT_FIELDS.join(', ')}) VALUES (${CLIENT_FIELDS.map((f) => `@${f}`).join(', ')})`,
    values
  );
  await logActivity(req, `Added client ${values.name}`);
  req.flash('success', `${values.name} was added. Now add their sites below.`);
  res.redirect(`/clients/${id}`);
});

clientsRouter.get('/:id', async (req, res) => {
  const client = await findClient(req.params.id);
  if (!client) return notFound(res, 'client');
  const today = todayStr();
  const [sites, contracts, upcomingShifts] = await Promise.all([
    db.all('SELECT * FROM sites WHERE client_id = ? ORDER BY active DESC, name', client.id),
    db.all('SELECT * FROM contracts WHERE client_id = ? ORDER BY start_date DESC', client.id),
    db.all(
      `SELECT s.*, si.name AS site_name, e.first_name, e.last_name
       FROM shifts s JOIN sites si ON si.id = s.site_id LEFT JOIN employees e ON e.id = s.employee_id
       WHERE si.client_id = ? AND s.status = 'scheduled' AND s.start_at >= ? AND s.start_at < ?
       ORDER BY s.start_at`,
      client.id,
      `${today}T00:00`,
      `${addDays(today, 7)}T00:00`
    ),
  ]);
  res.render('clients/show', { title: client.name, client, sites, contracts, upcomingShifts, siteError: null });
});

clientsRouter.get('/:id/edit', async (req, res) => {
  const client = await findClient(req.params.id);
  if (!client) return notFound(res, 'client');
  renderClientForm(res, client, null);
});

clientsRouter.post('/:id', async (req, res) => {
  const client = await findClient(req.params.id);
  if (!client) return notFound(res, 'client');
  const values = clean(req.body, CLIENT_FIELDS);
  if (!values.name) return renderClientForm(res, { ...values, id: client.id }, 'Client name is required.', 400);
  await db.run(`UPDATE clients SET ${CLIENT_FIELDS.map((f) => `${f} = @${f}`).join(', ')} WHERE id = @id`, {
    ...values,
    id: client.id,
  });
  await logActivity(req, `Updated client ${values.name}`);
  req.flash('success', 'Changes saved.');
  res.redirect(`/clients/${client.id}`);
});

clientsRouter.post('/:id/delete', async (req, res) => {
  const client = await findClient(req.params.id);
  if (!client) return notFound(res, 'client');
  try {
    await db.run('DELETE FROM clients WHERE id = ?', client.id);
  } catch (err) {
    if (!isInUseError(err)) throw err;
    req.flash('error', `${client.name} still has sites or contracts, so it can't be deleted. Remove those first.`);
    return res.redirect(`/clients/${client.id}`);
  }
  await logActivity(req, `Deleted client ${client.name}`);
  req.flash('success', `${client.name} was deleted.`);
  res.redirect('/clients');
});

// Add a site to a client (the form is on the client's page).
clientsRouter.post('/:id/sites', async (req, res) => {
  const client = await findClient(req.params.id);
  if (!client) return notFound(res, 'client');
  const values = clean(req.body, SITE_FIELDS);
  if (!values.name) {
    req.flash('error', 'Site name is required.');
    return res.redirect(`/clients/${client.id}`);
  }
  await db.run(
    'INSERT INTO sites (client_id, name, address, instructions) VALUES (?, ?, ?, ?)',
    client.id,
    values.name,
    values.address,
    values.instructions
  );
  await logActivity(req, `Added site ${values.name} for ${client.name}`);
  req.flash('success', `Site "${values.name}" was added.`);
  res.redirect(`/clients/${client.id}`);
});

// ---- Sites --------------------------------------------------------------------

function findSite(id) {
  return db.get('SELECT s.*, c.name AS client_name FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = ?', id);
}

sitesRouter.get('/:id/edit', async (req, res) => {
  const site = await findSite(req.params.id);
  if (!site) return notFound(res, 'site');
  res.render('clients/site-form', { title: `Edit ${site.name}`, site, error: null });
});

sitesRouter.post('/:id', async (req, res) => {
  const site = await findSite(req.params.id);
  if (!site) return notFound(res, 'site');
  const values = clean(req.body, SITE_FIELDS);
  values.active = req.body.active ? 1 : 0;
  if (!values.name) {
    return res
      .status(400)
      .render('clients/site-form', { title: `Edit ${site.name}`, site: { ...site, ...values }, error: 'Site name is required.' });
  }
  await db.run(
    'UPDATE sites SET name = ?, address = ?, instructions = ?, active = ? WHERE id = ?',
    values.name,
    values.address,
    values.instructions,
    values.active,
    site.id
  );
  await logActivity(req, `Updated site ${values.name} (${site.client_name})`);
  req.flash('success', 'Site saved.');
  res.redirect(`/clients/${site.client_id}`);
});

sitesRouter.post('/:id/delete', async (req, res) => {
  const site = await findSite(req.params.id);
  if (!site) return notFound(res, 'site');
  try {
    await db.run('DELETE FROM sites WHERE id = ?', site.id);
  } catch (err) {
    if (!isInUseError(err)) throw err;
    req.flash('error', `"${site.name}" has shifts, hours or incident reports recorded, so it can't be deleted. Untick "Active" instead.`);
    return res.redirect(`/clients/${site.client_id}`);
  }
  await logActivity(req, `Deleted site ${site.name} (${site.client_name})`);
  req.flash('success', `Site "${site.name}" was deleted.`);
  res.redirect(`/clients/${site.client_id}`);
});

module.exports = { clientsRouter, sitesRouter };
