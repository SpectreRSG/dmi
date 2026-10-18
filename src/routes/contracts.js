// Contracts and agreements – with clients, staff, subcontractors or suppliers.
const express = require('express');
const db = require('../db');
const { clean, toId, toNumber, notFound, numericIdParam, logActivity } = require('../helpers');
const time = require('../time');
const { saveUpload, deleteUpload, sendUpload, UploadError } = require('../uploads');

const router = express.Router();
numericIdParam(router);

const CONTRACT_TYPES = [
  'Client service agreement',
  'Employment contract',
  'Subcontractor agreement',
  'Non-disclosure agreement',
  'Supplier agreement',
  'Policy acknowledgement',
  'Other',
];
const STATUSES = ['draft', 'active', 'ended', 'terminated'];
const FIELDS = [
  'title', 'contract_type', 'party_type', 'client_id', 'employee_id', 'other_party', 'status',
  'signed_on', 'start_date', 'end_date', 'value', 'notes',
];

const CONTRACT_SELECT = `
  SELECT k.*, c.name AS client_name, e.first_name, e.last_name
  FROM contracts k
  LEFT JOIN clients c ON c.id = k.client_id
  LEFT JOIN employees e ON e.id = k.employee_id`;

function findContract(id) {
  return db.prepare(`${CONTRACT_SELECT} WHERE k.id = ?`).get(id);
}

function readForm(body) {
  const v = clean(body, FIELDS);
  v.party_type = ['client', 'employee', 'other'].includes(v.party_type) ? v.party_type : 'client';
  v.client_id = v.party_type === 'client' ? toId(v.client_id) : null;
  v.employee_id = v.party_type === 'employee' ? toId(v.employee_id) : null;
  v.other_party = v.party_type === 'other' ? v.other_party : null;
  v.status = STATUSES.includes(v.status) ? v.status : 'draft';
  v.value = toNumber(v.value, null);

  let error = null;
  if (!v.title) error = 'Please give the contract a title.';
  else if (!CONTRACT_TYPES.includes(v.contract_type)) error = 'Please choose a contract type.';
  else if (v.party_type === 'client' && !v.client_id) error = 'Please choose the client.';
  else if (v.party_type === 'employee' && !v.employee_id) error = 'Please choose the staff member.';
  else if (v.party_type === 'other' && !v.other_party) error = 'Please enter who the contract is with.';
  else if (['signed_on', 'start_date', 'end_date'].some((f) => v[f] && !time.isValidDate(v[f]))) {
    error = 'Please use the date pickers for dates.';
  } else if (v.start_date && v.end_date && v.end_date < v.start_date) {
    error = 'The end date must be after the start date.';
  } else if (Number.isNaN(v.value)) error = 'Contract value must be a number.';
  return { values: v, error };
}

function renderForm(res, contract, error, status = 200) {
  res.status(status).render('contracts/form', {
    title: contract.id ? `Edit ${contract.title}` : 'Add contract',
    contract,
    error,
    CONTRACT_TYPES,
    STATUSES,
    clients: db.prepare('SELECT id, name FROM clients ORDER BY name').all(),
    staff: db
      .prepare("SELECT id, first_name, last_name FROM employees WHERE status = 'active' OR id = ? ORDER BY last_name, first_name")
      .all(contract.employee_id || 0),
  });
}

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = [...STATUSES, 'ending', 'all'].includes(req.query.status) ? req.query.status : 'all';
  const type = CONTRACT_TYPES.includes(req.query.type) ? req.query.type : '';

  const where = ['1 = 1'];
  const params = [];
  if (status === 'ending') {
    // Active contracts that have ended or end within the warning window.
    where.push("k.status = 'active' AND k.end_date IS NOT NULL AND k.end_date <= ?");
    params.push(time.addDays(time.todayStr(), res.locals.settings.expiry_warning_days));
  } else if (status !== 'all') {
    where.push('k.status = ?');
    params.push(status);
  }
  if (type) {
    where.push('k.contract_type = ?');
    params.push(type);
  }
  if (q) {
    const like = `%${q}%`;
    where.push("(k.title LIKE ? OR c.name LIKE ? OR e.first_name || ' ' || e.last_name LIKE ? OR k.other_party LIKE ?)");
    params.push(like, like, like, like);
  }
  const contracts = db
    .prepare(`${CONTRACT_SELECT} WHERE ${where.join(' AND ')} ORDER BY (k.end_date IS NULL), k.end_date, k.title`)
    .all(...params);
  res.render('contracts/index', { title: 'Contracts & agreements', contracts, q, status, type, CONTRACT_TYPES, STATUSES });
});

router.get('/new', (req, res) => {
  const employeeId = toId(req.query.employee);
  const clientId = toId(req.query.client);
  renderForm(
    res,
    {
      party_type: employeeId ? 'employee' : 'client',
      client_id: clientId,
      employee_id: employeeId,
      contract_type: employeeId ? 'Employment contract' : 'Client service agreement',
      status: 'draft',
    },
    null
  );
});

router.post('/', (req, res) => {
  const { values, error } = readForm(req.body);
  if (error) return renderForm(res, values, error, 400);
  let file = null;
  try {
    file = saveUpload(req.file);
  } catch (err) {
    if (err instanceof UploadError) return renderForm(res, values, err.message, 400);
    throw err;
  }
  const row = { ...values, file_name: file?.file_name ?? null, file_original: file?.file_original ?? null };
  const columns = [...FIELDS, 'file_name', 'file_original'];
  const info = db
    .prepare(`INSERT INTO contracts (${columns.join(', ')}) VALUES (${columns.map((f) => `@${f}`).join(', ')})`)
    .run(row);
  logActivity(req, `Added contract "${values.title}"`);
  req.flash('success', 'Contract added.');
  res.redirect(`/contracts/${info.lastInsertRowid}`);
});

router.get('/:id', (req, res) => {
  const contract = findContract(req.params.id);
  if (!contract) return notFound(res, 'contract');
  res.render('contracts/show', { title: contract.title, contract });
});

router.get('/:id/file', (req, res) => {
  const contract = findContract(req.params.id);
  if (!contract?.file_name) return notFound(res, 'file');
  sendUpload(res, contract.file_name, contract.file_original);
});

router.get('/:id/edit', (req, res) => {
  const contract = findContract(req.params.id);
  if (!contract) return notFound(res, 'contract');
  renderForm(res, contract, null);
});

router.post('/:id', (req, res) => {
  const contract = findContract(req.params.id);
  if (!contract) return notFound(res, 'contract');
  const { values, error } = readForm(req.body);
  const formValues = { ...values, id: contract.id, file_name: contract.file_name, file_original: contract.file_original };
  if (error) return renderForm(res, formValues, error, 400);

  let file = null;
  try {
    file = saveUpload(req.file);
  } catch (err) {
    if (err instanceof UploadError) return renderForm(res, formValues, err.message, 400);
    throw err;
  }
  let { file_name, file_original } = contract;
  if (file || req.body.remove_file) {
    deleteUpload(contract.file_name);
    file_name = file?.file_name ?? null;
    file_original = file?.file_original ?? null;
  }

  const columns = [...FIELDS, 'file_name', 'file_original'];
  db.prepare(`UPDATE contracts SET ${columns.map((f) => `${f} = @${f}`).join(', ')} WHERE id = @id`).run({
    ...values,
    file_name,
    file_original,
    id: contract.id,
  });
  logActivity(req, `Updated contract "${values.title}"`);
  req.flash('success', 'Contract saved.');
  res.redirect(`/contracts/${contract.id}`);
});

router.post('/:id/delete', (req, res) => {
  const contract = findContract(req.params.id);
  if (!contract) return notFound(res, 'contract');
  db.prepare('DELETE FROM contracts WHERE id = ?').run(contract.id);
  deleteUpload(contract.file_name);
  logActivity(req, `Deleted contract "${contract.title}"`);
  req.flash('success', 'Contract deleted.');
  res.redirect('/contracts');
});

module.exports = router;
