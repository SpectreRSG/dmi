// Staff: guards, supervisors and office staff.
const express = require('express');
const db = require('../db');
const { clean, toNumber, notFound, numericIdParam, logActivity, isInUseError, employeeName } = require('../helpers');
const { isValidDate, todayStr, addDays, startOfWeek } = require('../time');
const { entryHours, round2 } = require('../services/payroll');
const { complianceFor, complianceForEmployee } = require('../services/compliance');

const router = express.Router();
numericIdParam(router);

const POSITIONS = [
  'Security Officer',
  'Senior Security Officer',
  'Supervisor',
  'Mobile Patrol Officer',
  'Control Room Operator',
  'Event Security',
  'Operations Manager',
  'Office Staff',
];
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Casual', 'Contractor'];

const FIELDS = [
  'first_name', 'last_name', 'email', 'phone', 'address', 'position', 'employment_type', 'hourly_rate',
  'start_date', 'end_date', 'license_number', 'license_expiry', 'emergency_contact_name',
  'emergency_contact_phone', 'status', 'notes', 'license_required',
];

function readForm(req, existing) {
  const v = clean(req.body, FIELDS);
  v.license_required = req.body.license_required ? 1 : 0;
  v.status = v.status === 'inactive' ? 'inactive' : 'active';
  // Only admins can see or change pay rates.
  v.hourly_rate = req.user.role === 'admin' ? toNumber(v.hourly_rate, 0) : (existing?.hourly_rate ?? 0);

  let error = null;
  if (!v.first_name || !v.last_name) error = 'First name and last name are required.';
  else if (Number.isNaN(v.hourly_rate) || v.hourly_rate < 0) error = 'Hourly rate must be a number (0 or more).';
  else if (['start_date', 'end_date', 'license_expiry'].some((f) => v[f] && !isValidDate(v[f]))) {
    error = 'Please use the date pickers for dates.';
  }
  return { values: v, error };
}

function renderForm(res, employee, error, status = 200) {
  res.status(status).render('staff/form', {
    title: employee.id ? `Edit ${employeeName(employee)}` : 'Add staff member',
    employee,
    error,
    POSITIONS,
    EMPLOYMENT_TYPES,
  });
}

function findEmployee(id) {
  return db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
}

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = ['active', 'inactive', 'all'].includes(req.query.status) ? req.query.status : 'active';
  const where = [];
  const params = [];
  if (status !== 'all') {
    where.push('status = ?');
    params.push(status);
  }
  if (q) {
    const like = `%${q}%`;
    where.push(
      "(first_name || ' ' || last_name LIKE ? OR email LIKE ? OR phone LIKE ? OR license_number LIKE ? OR position LIKE ?)"
    );
    params.push(like, like, like, like, like);
  }
  const employees = db
    .prepare(
      `SELECT * FROM employees ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_name, first_name`
    )
    .all(...params);
  const { byEmployee } = complianceFor(employees, res.locals.settings.expiry_warning_days);
  res.render('staff/index', { title: 'Staff', employees, compliance: byEmployee, q, status });
});

router.get('/new', (req, res) => {
  renderForm(res, { status: 'active', license_required: 1, start_date: todayStr() }, null);
});

router.post('/', (req, res) => {
  const { values, error } = readForm(req);
  if (error) return renderForm(res, values, error, 400);
  const info = db
    .prepare(`INSERT INTO employees (${FIELDS.join(', ')}) VALUES (${FIELDS.map((f) => `@${f}`).join(', ')})`)
    .run(values);
  logActivity(req, `Added staff member ${employeeName(values)}`);
  req.flash('success', `${employeeName(values)} was added.`);
  res.redirect(`/staff/${info.lastInsertRowid}`);
});

router.get('/:id', (req, res) => {
  const employee = findEmployee(req.params.id);
  if (!employee) return notFound(res, 'staff member');

  const today = todayStr();
  const weekStart = startOfWeek(today);
  const weekEnd = addDays(weekStart, 7);

  const upcomingShifts = db
    .prepare(
      `SELECT s.*, si.name AS site_name, c.name AS client_name
       FROM shifts s JOIN sites si ON si.id = s.site_id JOIN clients c ON c.id = si.client_id
       WHERE s.employee_id = ? AND s.status = 'scheduled' AND s.end_at >= ?
       ORDER BY s.start_at LIMIT 10`
    )
    .all(employee.id, `${today}T00:00`);

  const recentEntries = db
    .prepare(
      `SELECT t.*, si.name AS site_name FROM time_entries t LEFT JOIN sites si ON si.id = t.site_id
       WHERE t.employee_id = ? ORDER BY t.start_at DESC LIMIT 10`
    )
    .all(employee.id);

  const weekEntries = db
    .prepare(
      `SELECT * FROM time_entries WHERE employee_id = ? AND status != 'rejected' AND start_at >= ? AND start_at < ?`
    )
    .all(employee.id, `${weekStart}T00:00`, `${weekEnd}T00:00`);
  const weekShifts = db
    .prepare(
      `SELECT * FROM shifts WHERE employee_id = ? AND status != 'cancelled' AND start_at >= ? AND start_at < ?`
    )
    .all(employee.id, `${weekStart}T00:00`, `${weekEnd}T00:00`);

  const training = db
    .prepare(
      `SELECT r.*, c.name AS course_name FROM training_records r JOIN training_courses c ON c.id = r.course_id
       WHERE r.employee_id = ? ORDER BY r.completed_on DESC`
    )
    .all(employee.id);

  const contracts = db
    .prepare('SELECT * FROM contracts WHERE employee_id = ? ORDER BY start_date DESC')
    .all(employee.id);

  res.render('staff/show', {
    title: employeeName(employee),
    employee,
    compliance: complianceForEmployee(employee, res.locals.settings.expiry_warning_days),
    upcomingShifts,
    recentEntries,
    hoursThisWeek: round2(weekEntries.reduce((sum, e) => sum + entryHours(e), 0)),
    scheduledThisWeek: round2(weekShifts.reduce((sum, s) => sum + entryHours(s), 0)),
    training,
    contracts,
  });
});

router.get('/:id/edit', (req, res) => {
  const employee = findEmployee(req.params.id);
  if (!employee) return notFound(res, 'staff member');
  renderForm(res, employee, null);
});

router.post('/:id', (req, res) => {
  const existing = findEmployee(req.params.id);
  if (!existing) return notFound(res, 'staff member');
  const { values, error } = readForm(req, existing);
  if (error) return renderForm(res, { ...values, id: existing.id }, error, 400);
  db.prepare(`UPDATE employees SET ${FIELDS.map((f) => `${f} = @${f}`).join(', ')} WHERE id = @id`).run({
    ...values,
    id: existing.id,
  });
  logActivity(req, `Updated staff member ${employeeName(values)}`);
  req.flash('success', 'Changes saved.');
  res.redirect(`/staff/${existing.id}`);
});

router.post('/:id/delete', (req, res) => {
  const employee = findEmployee(req.params.id);
  if (!employee) return notFound(res, 'staff member');
  try {
    db.prepare('DELETE FROM employees WHERE id = ?').run(employee.id);
  } catch (err) {
    if (!isInUseError(err)) throw err;
    req.flash(
      'error',
      `${employeeName(employee)} has shifts, hours, pay, training or contracts on record, so they can't be deleted. Set their status to "Inactive" instead.`
    );
    return res.redirect(`/staff/${employee.id}`);
  }
  logActivity(req, `Deleted staff member ${employeeName(employee)}`);
  req.flash('success', `${employeeName(employee)} was deleted.`);
  res.redirect('/staff');
});

module.exports = router;
