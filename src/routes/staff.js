// Staff: guards, supervisors and office staff.
const express = require('express');
const db = require('../db');
const { clean, toNumber, notFound, numericIdParam, logActivity, isInUseError, employeeName } = require('../helpers');
const { isValidDate, todayStr, addDays, startOfWeek } = require('../time');
const { entryHours, round2 } = require('../services/payroll');
const { complianceFor, complianceForEmployee } = require('../services/compliance');
const availability = require('../services/availability');
const withholding = require('../services/withholdingProfile');
const bank = require('../services/bankAccounts');
const newHires = require('../services/newHires');
const employment = require('../services/employment');
const { decrypt } = require('../secureData');
const { requireRecentCode } = require('../auth');
const { notifyEmployees } = require('../services/notify');

const router = express.Router();
numericIdParam(router);

// The positions to choose from. Someone saved with an older position keeps
// it until it's changed (the Staff list points them out).
const POSITIONS = ['Armed Security Officer', 'Unarmed Security Officer', 'Supervisor', 'Manager', 'Administrator'];

const FIELDS = [
  'first_name', 'last_name', 'email', 'phone', 'address', 'position',
  'start_date', 'end_date', 'license_number', 'license_expiry', 'emergency_contact_name',
  'emergency_contact_phone', 'status', 'notes', 'license_required',
];
// How someone is paid and taxed: their employment type decides it (services/employment.js).
const PAY_FIELDS = [...employment.PAY_KEYS, 'meal_agreement_on', 'meal_waiver_on'];
const NEW_PERSON_PAY = {
  employment_type: 'Contractor', tax_form: '1099', pay_basis: 'hourly', hourly_rate: 0, annual_salary: 0,
  weekly_hours: 40, overtime_exempt: 0, meal_agreement_on: null, meal_waiver_on: null,
};

function readForm(req, existing) {
  const v = clean(req.body, FIELDS);
  v.license_required = req.body.license_required ? 1 : 0;
  v.status = v.status === 'inactive' ? 'inactive' : 'active';

  let error = null;
  // Only admins can see or change pay.
  if (req.user.role === 'admin') {
    const pay = employment.readPayFields(req.body, existing || {});
    Object.assign(v, pay.values);
    error = pay.error;
  } else {
    for (const f of PAY_FIELDS) v[f] = existing ? existing[f] : NEW_PERSON_PAY[f];
  }
  if (!v.first_name || !v.last_name) error = 'First name and last name are required.';
  else if (v.position && !POSITIONS.includes(v.position) && v.position !== existing?.position) error = 'Choose a position from the list.';
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
    TYPES: employment.TYPES,
    exemptMinimum: employment.exemptMinimum(todayStr().slice(0, 4)),
    minimumWage: employment.minimumWage(todayStr().slice(0, 4)),
  });
}

// Keeps a record of a change to how someone is paid, and tells them about it
// (California wants employees told in writing within 7 days, Labor Code 2810.5;
// the pay stub shows it too).
async function recordPayChange(req, employee, change, { isNew = false } = {}) {
  const { settings } = req.res.locals;
  await db.run(
    'INSERT INTO employment_changes (employee_id, changed_on, before, after, changed_by) VALUES (?, ?, ?::jsonb, ?::jsonb, ?)',
    employee.id, todayStr(), JSON.stringify(isNew ? {} : change.before), JSON.stringify(change.after), req.user.id
  );
  if (isNew) return;
  const lines = employment.describe(employee, settings);
  await notifyEmployees([employee.id], {
    title: 'Your pay details changed',
    body: `${lines[0]}${change.before.tax_form !== change.after.tax_form && employee.tax_form === 'W-2' ? ' Please fill in your W-4 and DE 4 in DMI.' : ''}`,
    url: '/my/pay',
    tag: `pay-change-${employee.id}`,
  });
}

function findEmployee(id) {
  return db.get('SELECT * FROM employees WHERE id = ?', id);
}

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = ['active', 'inactive', 'all'].includes(req.query.status) ? req.query.status : 'active';
  const oldOnly = req.query.position === 'old';
  const where = [];
  const params = [];
  if (oldOnly) {
    where.push('position IS NOT NULL AND position <> ALL(?::text[])');
    params.push(POSITIONS);
  }
  if (status !== 'all') {
    where.push('status = ?');
    params.push(status);
  }
  if (q) {
    const like = `%${q}%`;
    where.push(
      "(first_name || ' ' || last_name ILIKE ? OR email ILIKE ? OR phone ILIKE ? OR license_number ILIKE ? OR position ILIKE ?)"
    );
    params.push(like, like, like, like, like);
  }
  const employees = await db.all(
    `SELECT * FROM employees ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_name, first_name`,
    ...params
  );
  const { byEmployee } = await complianceFor(employees, res.locals.settings.expiry_warning_days);
  // Active staff whose position isn't one of today's choices.
  const { n: oldPositions } = await db.get(
    "SELECT COUNT(*)::int AS n FROM employees WHERE status = 'active' AND position IS NOT NULL AND position <> ALL(?::text[])", POSITIONS
  );
  res.render('staff/index', { title: 'Staff', employees, compliance: byEmployee, q, status, oldOnly, oldPositions, POSITIONS });
});

router.get('/new', (req, res) => {
  renderForm(res, { status: 'active', license_required: 1, start_date: todayStr() }, null);
});

router.post('/', async (req, res) => {
  const { values, error } = readForm(req);
  if (error) return renderForm(res, values, error, 400);
  const columns = [...FIELDS, ...PAY_FIELDS];
  const id = await db.insert(
    `INSERT INTO employees (${columns.join(', ')}) VALUES (${columns.map((f) => `@${f}`).join(', ')})`,
    values
  );
  await recordPayChange(req, { ...values, id }, employment.payChange({}, values), { isNew: true });
  await logActivity(req, `Added staff member ${employeeName(values)}`);
  req.flash('success', `${employeeName(values)} was added.`);
  res.redirect(`/staff/${id}`);
});

router.get('/:id', async (req, res) => {
  const employee = await findEmployee(req.params.id);
  if (!employee) return notFound(res, 'staff member');

  const today = todayStr();
  const weekStart = startOfWeek(today);
  const weekEnd = addDays(weekStart, 7);

  const [upcomingShifts, recentEntries, weekEntries, weekShifts, training, contracts, compliance] = await Promise.all([
    db.all(
      `SELECT s.*, si.name AS site_name, c.name AS client_name
       FROM shifts s JOIN sites si ON si.id = s.site_id JOIN clients c ON c.id = si.client_id
       WHERE s.employee_id = ? AND s.status = 'scheduled' AND s.end_at >= ?
       ORDER BY s.start_at LIMIT 10`,
      employee.id,
      `${today}T00:00`
    ),
    db.all(
      `SELECT t.*, si.name AS site_name FROM time_entries t LEFT JOIN sites si ON si.id = t.site_id
       WHERE t.employee_id = ? ORDER BY t.start_at DESC LIMIT 10`,
      employee.id
    ),
    db.all(
      `SELECT * FROM time_entries WHERE employee_id = ? AND status != 'rejected' AND start_at >= ? AND start_at < ?`,
      employee.id,
      `${weekStart}T00:00`,
      `${weekEnd}T00:00`
    ),
    db.all(
      `SELECT * FROM shifts WHERE employee_id = ? AND status != 'cancelled' AND start_at >= ? AND start_at < ?`,
      employee.id,
      `${weekStart}T00:00`,
      `${weekEnd}T00:00`
    ),
    db.all(
      `SELECT r.*, c.name AS course_name FROM training_records r JOIN training_courses c ON c.id = r.course_id
       WHERE r.employee_id = ? ORDER BY r.completed_on DESC`,
      employee.id
    ),
    db.all('SELECT * FROM contracts WHERE employee_id = ? ORDER BY start_date DESC', employee.id),
    complianceForEmployee(employee, res.locals.settings.expiry_warning_days),
  ]);
  const account = await db.get(
    `SELECT id, email, role, last_login_at, push_exempt, (SELECT COUNT(*)::int FROM push_subscriptions p WHERE p.user_id = users.id) AS devices
     FROM users WHERE employee_id = ?`,
    employee.id
  );
  const said = (await db.all(
    `SELECT * FROM availability WHERE employee_id = ? AND COALESCE(end_date, '9999-12-31') >= ? ORDER BY start_date, id`,
    employee.id,
    today
  )).map((entry) => ({ ...entry, label: availability.describe(entry) }));
  const taxProfile = res.locals.isAdmin
    ? await db.get('SELECT tin_type, tin_last4, signed_at, electronic_consent, backup_withholding FROM tax_profiles WHERE employee_id = ?', employee.id)
    : null;
  const w4 = res.locals.isAdmin ? await withholding.findProfile(employee.id) : null;
  const bankAccounts = res.locals.isAdmin ? await bank.accountsFor(employee.id) : null;
  const payHistory = res.locals.isAdmin
    ? (await db.all(
      `SELECT c.*, u.name AS changed_by_name FROM employment_changes c LEFT JOIN users u ON u.id = c.changed_by
       WHERE c.employee_id = ? ORDER BY c.id DESC LIMIT 10`,
      employee.id
    )).map((c) => ({ ...c, summary: employment.changeSummary(c.before, c.after) }))
    : [];

  res.render('staff/show', {
    title: employeeName(employee),
    employee,
    account,
    taxProfile,
    w4,
    w4Summary: w4 ? withholding.summary(w4) : '',
    bankAccounts,
    describeAccount: bank.describe,
    payRules: res.locals.isAdmin ? employment.describe(employee, res.locals.settings) : [],
    payHistory,
    newHireDue: newHires.dueDate(employee.w2_since || employee.start_date || todayStr()),
    compliance,
    upcomingShifts,
    said,
    recentEntries,
    hoursThisWeek: round2(weekEntries.reduce((sum, e) => sum + entryHours(e), 0)),
    scheduledThisWeek: round2(weekShifts.reduce((sum, s) => sum + entryHours(s), 0)),
    training,
    contracts,
  });
});

router.get('/:id/edit', async (req, res) => {
  const employee = await findEmployee(req.params.id);
  if (!employee) return notFound(res, 'staff member');
  renderForm(res, employee, null);
});

router.post('/:id', async (req, res) => {
  const existing = await findEmployee(req.params.id);
  if (!existing) return notFound(res, 'staff member');
  const { values, error } = readForm(req, existing);
  if (error) return renderForm(res, { ...values, id: existing.id }, error, 400);
  const change = employment.payChange(existing, values);
  const columns = [...FIELDS, ...PAY_FIELDS];
  // A contractor who becomes an employee is a new hire from today (new hire
  // report, sick leave waiting period); going back to contractor ends that.
  if (existing.tax_form !== values.tax_form) {
    values.w2_since = values.tax_form === 'W-2' ? todayStr() : null;
    values.new_hire_reported_on = null;
    columns.push('w2_since', 'new_hire_reported_on');
  }
  await db.run(`UPDATE employees SET ${columns.map((f) => `${f} = @${f}`).join(', ')} WHERE id = @id`, {
    ...values,
    id: existing.id,
  });
  const employee = { ...existing, ...values };
  if (change) {
    await recordPayChange(req, employee, change);
    const was = change.before.employment_type !== change.after.employment_type ? ` (was ${change.before.employment_type})` : '';
    await logActivity(req, `Changed how ${employeeName(values)} is paid: ${values.employment_type}${was}`);
    req.flash('success', `Saved. ${employeeName(values)} is now ${values.employment_type}${was}: ${employment.describe(employee, res.locals.settings).join(' ')}`);
    if (values.tax_form === 'W-2' && existing.tax_form !== 'W-2') {
      req.flash('info', 'They are an employee from today: report them as a new hire (DE 34) within 20 days, and they need to fill in a W-4 and DE 4 (they see it when they sign in). Pay runs from now on use the new rules; press Recalculate on any draft.');
    } else if (existing.tax_form === 'W-2' && values.tax_form !== 'W-2') {
      req.flash('info', 'They are paid as a contractor from now on: taxes stop, and they need a W-9 on file. Their W-2 pay so far this year still goes on a W-2 in January. Press Recalculate on any draft pay run.');
    } else {
      req.flash('info', 'Pay runs from now on use the new pay details. Press Recalculate on any draft pay run.');
    }
  } else {
    req.flash('success', 'Changes saved.');
  }
  await logActivity(req, `Updated staff member ${employeeName(values)}`);
  res.redirect(`/staff/${existing.id}`);
});

// A W-2 employee's W-4 and DE 4, typed in from the paper forms they signed
// (admins only, like pay).
function adminOnly(req, res, next) {
  if (req.user.role === 'admin') return next();
  return res.status(403).render('error', { title: 'Admins only', message: 'Only admins can see or change tax details.' });
}

function renderWithholding(res, employee, values, error, status = 200) {
  res.status(status).render('staff/withholding', { title: `W-4 and DE 4 – ${employeeName(employee)}`, employee, values, error, ...withholding.formLocals() });
}

router.get('/:id/withholding', adminOnly, async (req, res) => {
  const employee = await findEmployee(req.params.id);
  if (!employee) return notFound(res, 'staff member');
  renderWithholding(res, employee, await withholding.formValues(employee), null);
});

router.post('/:id/withholding', adminOnly, async (req, res) => {
  const employee = await findEmployee(req.params.id);
  if (!employee) return notFound(res, 'staff member');
  const { values, error } = await withholding.readForm(req.body, employee.id);
  if (error) return renderWithholding(res, employee, values, error, 400);
  await withholding.saveProfile(employee.id, values, { ip: req.ip, enteredBy: req.user.id });
  await logActivity(req, `Entered the W-4 and DE 4 for ${employeeName(employee)} from their signed paper forms`);
  req.flash('success', 'W-4 and DE 4 saved. The next pay run uses them.');
  res.redirect(`/staff/${employee.id}`);
});

// Direct deposit: typed in from a signed paper form (active at once), and
// approving or turning down an officer's own change.
function renderBank(res, employee, values, error, status = 200) {
  res.status(status).render('staff/bank', { title: `Direct deposit – ${employeeName(employee)}`, employee, values, error, TYPES: bank.TYPES });
}

router.get('/:id/bank', adminOnly, async (req, res) => {
  const employee = await findEmployee(req.params.id);
  if (!employee) return notFound(res, 'staff member');
  renderBank(res, employee, { holder_name: employeeName(employee) }, null);
});

router.post('/:id/bank', adminOnly, requireRecentCode, async (req, res) => {
  const employee = await findEmployee(req.params.id);
  if (!employee) return notFound(res, 'staff member');
  const { values, account, error } = bank.readForm(req.body);
  if (error) return renderBank(res, employee, values, error, 400);
  await bank.saveAccount(employee.id, values, account, { enteredBy: req.user.id });
  await logActivity(req, `Entered the direct deposit account for ${employeeName(employee)} from their signed form (${bank.describe({ ...values, account_last4: account.slice(-4) })})`);
  await notifyEmployees([employee.id], { title: 'Your direct deposit account was updated', body: 'The office entered your new bank details. Tell them right away if you didn\'t ask for this.', url: '/my/pay/direct-deposit', tag: `bank-change-${employee.id}` });
  req.flash('success', 'Direct deposit account saved and in use from the next pay run.');
  res.redirect(`/staff/${employee.id}`);
});

router.post('/:id/bank/approve', adminOnly, requireRecentCode, async (req, res) => {
  const employee = await findEmployee(req.params.id);
  if (!employee) return notFound(res, 'staff member');
  if (await bank.approvePending(employee.id, req.user.id)) {
    await logActivity(req, `Approved the new direct deposit account for ${employeeName(employee)}`);
    await notifyEmployees([employee.id], { title: 'New bank account approved', body: 'Your pay goes to your new account from the next pay day.', url: '/my/pay/direct-deposit', tag: `bank-change-${employee.id}` });
    req.flash('success', 'Approved. Their pay goes to the new account from the next pay run.');
  }
  res.redirect(`/staff/${employee.id}`);
});

router.post('/:id/bank/reject', adminOnly, async (req, res) => {
  const employee = await findEmployee(req.params.id);
  if (!employee) return notFound(res, 'staff member');
  await bank.rejectPending(employee.id);
  await logActivity(req, `Turned down a direct deposit change for ${employeeName(employee)}`);
  await notifyEmployees([employee.id], { title: 'Bank account change not approved', body: 'The office didn\'t approve the new bank details, so your pay goes where it did before. Talk to the office if you want to change it.', url: '/my/pay/direct-deposit', tag: `bank-change-${employee.id}` });
  req.flash('success', 'Change turned down. Pay keeps going to the account they had.');
  res.redirect(`/staff/${employee.id}`);
});

router.post('/:id/bank/stop', adminOnly, requireRecentCode, async (req, res) => {
  const employee = await findEmployee(req.params.id);
  if (!employee) return notFound(res, 'staff member');
  await bank.stopDirectDeposit(employee.id);
  await logActivity(req, `Stopped direct deposit for ${employeeName(employee)} (paper checks)`);
  req.flash('success', 'Direct deposit stopped: pay them by check.');
  res.redirect(`/staff/${employee.id}`);
});

// California's new-hire report (DE 34): everything to type into e-Services
// for Business (full SSN, so it asks for a fresh code), then mark it reported.
router.get('/:id/new-hire', adminOnly, requireRecentCode, async (req, res) => {
  const employee = await findEmployee(req.params.id);
  if (!employee) return notFound(res, 'staff member');
  const w4 = await withholding.findProfile(employee.id);
  const ssn = w4 ? (await decrypt(w4.ssn_encrypted)).replace(/^(\d{3})(\d{2})(\d{4})$/, '$1-$2-$3') : null;
  if (ssn) await logActivity(req, `Opened the new hire report details for ${employeeName(employee)} (shows the full Social Security number)`);
  res.set('Cache-Control', 'no-store');
  res.render('staff/new-hire', {
    title: `New hire report – ${employeeName(employee)}`,
    employee,
    w4,
    ssn,
    due: newHires.hiredOn(employee) ? newHires.dueDate(newHires.hiredOn(employee)) : null,
  });
});

router.post('/:id/new-hire', adminOnly, async (req, res) => {
  const employee = await findEmployee(req.params.id);
  if (!employee) return notFound(res, 'staff member');
  const reportedOn = isValidDate(req.body.reported_on) && req.body.reported_on <= todayStr() ? req.body.reported_on : null;
  if (!reportedOn) {
    req.flash('error', 'Enter the date it was reported (today or earlier).');
    return res.redirect(`/staff/${employee.id}/new-hire`);
  }
  await db.run('UPDATE employees SET new_hire_reported_on = ? WHERE id = ?', reportedOn, employee.id);
  await logActivity(req, `Marked ${employeeName(employee)} as reported to the EDD as a new hire (DE 34) on ${reportedOn}`);
  req.flash('success', 'Marked as reported.');
  res.redirect(`/staff/${employee.id}`);
});

// An officer whose phone can't get notifications (e.g. an old iPhone): let
// them use their pages without them, or require them again.
router.post('/:id/notifications', async (req, res) => {
  const employee = await db.get('SELECT * FROM employees WHERE id = ?', req.params.id);
  if (!employee) return notFound(res, 'staff member');
  const exempt = req.body.exempt === '1';
  const done = await db.run("UPDATE users SET push_exempt = ? WHERE employee_id = ? AND role = 'officer'", exempt ? 1 : 0, employee.id);
  if (done.changes) {
    await logActivity(req, exempt
      ? `Let ${employeeName(employee)} use the app without notifications`
      : `Asked ${employeeName(employee)} to turn on notifications again`);
  }
  req.flash('success', exempt
    ? `${employeeName(employee)} can use DMI without notifications now. They won't get shift reminders or open shifts, so tell them about shifts another way.`
    : `${employeeName(employee)} will be asked to turn on notifications the next time they open DMI.`);
  res.redirect(`/staff/${employee.id}`);
});

router.post('/:id/delete', async (req, res) => {
  const employee = await findEmployee(req.params.id);
  if (!employee) return notFound(res, 'staff member');
  try {
    await db.run('DELETE FROM employees WHERE id = ?', employee.id);
  } catch (err) {
    if (!isInUseError(err)) throw err;
    req.flash(
      'error',
      `${employeeName(employee)} has shifts, hours, pay, training, contracts or incident reports on record, so they can't be deleted. Set their status to "Inactive" instead.`
    );
    return res.redirect(`/staff/${employee.id}`);
  }
  await logActivity(req, `Deleted staff member ${employeeName(employee)}`);
  req.flash('success', `${employeeName(employee)} was deleted.`);
  res.redirect('/staff');
});

module.exports = router;
