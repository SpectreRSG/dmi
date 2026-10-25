// Pay runs: turn approved hours into pay for a period (admins only).
//
// How it works:
// 1. Create a pay run for a period (e.g. 1st-14th). It starts as a "draft".
// 2. The app finds every APPROVED timesheet entry in that period and works out
//    each person's pay: overtime for W-2 employees (1099 contractors get their
//    rate for every hour), then taxes and paid sick leave for W-2 employees.
// 3. Add any adjustments (bonus), sick leave taken or deductions, and check the numbers.
// 4. "Finalize" it. The hours are then locked so they can never be paid twice.
const express = require('express');
const db = require('../db');
const { toNumber, notFound, numericIdParam, logActivity, employeeName } = require('../helpers');
const time = require('../time');
const { calculatePayLine, overtimeRules, round2 } = require('../services/payroll');
const { recordFinishedShifts } = require('../services/hoursFromSchedule');
const { findPayLine, payLineTimesheet, timesheetFileName } = require('../services/payTimesheet');
const { sendUpload } = require('../uploads');
const { notifyEmployees } = require('../services/notify');
const paycheck = require('../services/paycheck');
const { payslipData } = require('../services/payslip');
const { TABLES, PAY_FREQUENCIES, tablesFor, tableYears } = require('../services/taxTables');
const { federalTableRows, californiaTableRows, EMPLOYEE_TAXES, EMPLOYER_TAXES, sumOf } = require('../services/withholding');
const { saveSettings } = require('../settings');
const taxDeposits = require('../services/taxDeposits');
const taxReports = require('../services/taxReports');
const { requireRecentCode } = require('../auth');
const { decrypt } = require('../secureData');

const router = express.Router();
numericIdParam(router);
router.param('itemId', (req, res, next, id) => (/^\d+$/.test(id) ? next() : next('route')));
router.param('depositId', (req, res, next, id) => (/^\d+$/.test(id) ? next() : next('route')));

function findRun(id) {
  return db.get(
    'SELECT p.*, u.name AS created_by_name FROM pay_runs p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?',
    id
  );
}

function runItems(runId) {
  return db.all(
    `SELECT i.*, e.first_name, e.last_name, e.position, e.email, e.start_date,
       (wp.employee_id IS NOT NULL) AS has_w4, (tp.employee_id IS NOT NULL) AS has_w9
     FROM pay_run_items i JOIN employees e ON e.id = i.employee_id
     LEFT JOIN withholding_profiles wp ON wp.employee_id = i.employee_id
     LEFT JOIN tax_profiles tp ON tp.employee_id = i.employee_id
     WHERE i.pay_run_id = ? ORDER BY e.last_name, e.first_name`,
    runId
  );
}

const SUMMED = ['regular_hours', 'overtime_hours', 'double_time_hours', 'sick_hours', 'adjustment', 'gross_pay', 'deduction', 'net_pay',
  ...EMPLOYEE_TAXES, ...EMPLOYER_TAXES];

function totalsOf(items) {
  const totals = Object.fromEntries(SUMMED.map((f) => [f, round2(items.reduce((s, i) => s + (Number(i[f]) || 0), 0))]));
  totals.withheld = sumOf(totals, EMPLOYEE_TAXES);
  totals.employer = sumOf(totals, EMPLOYER_TAXES);
  return totals;
}

// What the office typed in on a pay line, kept when the run is recalculated.
const INPUT_FIELDS = ['adjustment', 'adjustment_note', 'sick_hours', 'deduction', 'deduction_note'];

// (Re)builds a draft pay run from the approved hours in its period.
async function recalculate(run, settings) {
  await recordFinishedShifts(); // shifts that just ended count too
  await db.transaction(async (tx) => {
    const previous = new Map(
      (await tx.all(`SELECT employee_id, ${INPUT_FIELDS.join(', ')} FROM pay_run_items WHERE pay_run_id = ?`, run.id)).map(
        (row) => [row.employee_id, row]
      )
    );
    await tx.run('UPDATE time_entries SET pay_run_id = NULL WHERE pay_run_id = ?', run.id);
    await tx.run('DELETE FROM pay_run_items WHERE pay_run_id = ?', run.id);

    const entries = await tx.all(
      `SELECT * FROM time_entries
       WHERE status = 'approved' AND pay_run_id IS NULL AND substr(start_at, 1, 10) BETWEEN ? AND ?
       ORDER BY employee_id, start_at`,
      run.period_start,
      run.period_end
    );

    const byEmployee = new Map();
    for (const entry of entries) {
      if (!byEmployee.has(entry.employee_id)) byEmployee.set(entry.employee_id, []);
      byEmployee.get(entry.employee_id).push(entry);
    }
    // The period can start mid-week (pay periods run Sunday to Saturday, overtime
    // weeks Monday to Sunday): hours earlier that week count towards its overtime.
    const earlier = await tx.all(
      `SELECT * FROM time_entries
       WHERE status = 'approved' AND substr(start_at, 1, 10) >= ? AND substr(start_at, 1, 10) < ?`,
      time.startOfWeek(run.period_start),
      run.period_start
    );

    for (const [employeeId, list] of byEmployee) {
      const employee = await tx.get('SELECT id, hourly_rate, tax_form, start_date FROM employees WHERE id = ?', employeeId);
      const hours = calculatePayLine({
        entries: list,
        earlier: earlier.filter((e) => e.employee_id === employeeId),
        hourlyRate: employee.hourly_rate,
        rules: employee.tax_form === 'W-2' ? overtimeRules(settings) : paycheck.STRAIGHT_TIME,
      });
      const line = await paycheck.completeLine(tx, { run, employee, hours, inputs: previous.get(employeeId) || {}, settings });
      await paycheck.insertLine(tx, { pay_run_id: run.id, employee_id: employeeId, ...line });
      await tx.run('UPDATE time_entries SET pay_run_id = ? WHERE id = ANY(?::int[])', run.id, list.map((e) => e.id));
    }
  });
}

// A sensible default period: straight after the last pay run, same length.
async function suggestedPeriod() {
  const last = await db.get('SELECT * FROM pay_runs ORDER BY period_end DESC LIMIT 1');
  if (last) {
    const start = time.addDays(last.period_end, 1);
    return { period_start: start, period_end: time.addDays(start, time.daysBetween(last.period_start, last.period_end)) };
  }
  const thisMonday = time.startOfWeek(time.todayStr());
  return { period_start: time.addDays(thisMonday, -14), period_end: time.addDays(thisMonday, -1) };
}

function draftOnly(req, res, run) {
  if (run.status === 'draft') return true;
  req.flash('error', 'This pay run is finalized and can no longer be changed.');
  res.redirect(`/pay/${run.id}`);
  return false;
}

// Makes a value safe for a CSV (spreadsheet) file.
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) && typeof value === 'string') text = `'${text}`; // stop spreadsheet formulas
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// ---- Tax rates ---------------------------------------------------------------------

// The rates and tables DMI uses for a year, laid out like the publications, so
// they can be checked once a year before the first payday.
router.get('/taxes', (req, res) => {
  const years = tableYears();
  const thisYear = Number(time.todayStr().slice(0, 4));
  const year = years.includes(Number(req.query.year)) ? Number(req.query.year) : (years.includes(thisYear) ? thisYear : years.at(-1));
  const tables = TABLES[year];
  const statuses = ['single', 'married', 'head'];
  res.render('pay/taxes', {
    title: `Tax rates for ${year}`,
    year,
    years,
    tables,
    federalRows: Object.fromEntries(statuses.map((s) => [s, { standard: federalTableRows(tables, s, false), stepTwo: federalTableRows(tables, s, true) }])),
    californiaRows: Object.fromEntries(statuses.map((s) => [s, californiaTableRows(tables, s)])),
    frequency: PAY_FREQUENCIES[res.locals.settings.pay_frequency],
    confirmed: res.locals.settings.tax_tables_confirmed === String(year),
  });
});

router.post('/taxes/confirm', async (req, res) => {
  const year = Number(req.body.year);
  if (!tablesFor(year)) return notFound(res, 'tax year');
  if (!req.body.checked) {
    req.flash('error', 'Tick the box to say the rates were checked.');
    return res.redirect(`/pay/taxes?year=${year}`);
  }
  await saveSettings({ tax_tables_confirmed: String(year) });
  await logActivity(req, `Confirmed the ${year} payroll tax rates were checked against the IRS and EDD publications`);
  req.flash('success', `Thanks. The ${year} tax rates are confirmed, so pay runs with W-2 employees can be finalized.`);
  res.redirect(`/pay/taxes?year=${year}`);
});

// ---- Tax payments ------------------------------------------------------------------

const readYear = (value) => (/^\d{4}$/.test(String(value)) && Number(value) >= 2000 && Number(value) <= 2100 ? Number(value) : Number(time.todayStr().slice(0, 4)));

// What's owed to the IRS and the EDD from W-2 pay, when, and what's been paid.
router.get('/deposits', async (req, res) => {
  const year = readYear(req.query.year);
  const [list, payments] = await Promise.all([taxDeposits.obligations(year, res.locals.settings), taxDeposits.recordedPayments()]);
  res.render('pay/deposits', { title: 'Tax payments', year, list, payments, KINDS: taxDeposits.KINDS, today: time.todayStr() });
});

const PERIOD_KEY = /^(M:\d{4}-(0[1-9]|1[0-2])|S:\d{4}-\d{2}-\d{2}|Q:\d{4}-[1-4])$/;

router.post('/deposits', async (req, res) => {
  const kind = String(req.body.kind || '');
  const key = String(req.body.period_key || '');
  const paidOn = String(req.body.paid_on || '');
  const amount = toNumber(req.body.amount, NaN);
  const reference = String(req.body.reference || '').trim().slice(0, 60) || null;
  const back = `/pay/deposits?year=${readYear(req.body.year)}`;
  let error = null;
  if (!taxDeposits.KINDS[kind] || !PERIOD_KEY.test(key)) error = 'Choose which tax payment this was for.';
  else if (!time.isValidDate(paidOn)) error = 'Enter the date it was paid.';
  else if (paidOn > time.todayStr()) error = "The payment date can't be in the future.";
  else if (Number.isNaN(amount) || amount <= 0 || amount > 10000000) error = 'Enter the amount paid, like 1234.56.';
  if (error) {
    req.flash('error', error);
    return res.redirect(back);
  }
  await db.insert(
    'INSERT INTO tax_deposits (kind, period_key, paid_on, amount, reference, recorded_by) VALUES (?, ?, ?, ?, ?, ?)',
    kind, key, paidOn, round2(amount), reference, req.user.id
  );
  const k = taxDeposits.KINDS[kind];
  await logActivity(req, `Recorded a ${k.agency} tax payment of ${round2(amount)} (${k.label}, ${key}, paid ${paidOn})`);
  req.flash('success', `Payment recorded: ${k.label}.`);
  res.redirect(back);
});

// Undo a payment recorded by mistake.
router.post('/deposits/:depositId/delete', async (req, res) => {
  const deposit = await db.get('SELECT * FROM tax_deposits WHERE id = ?', req.params.depositId);
  if (!deposit) return notFound(res, 'tax payment');
  await db.run('DELETE FROM tax_deposits WHERE id = ?', deposit.id);
  await logActivity(req, `Removed a recorded tax payment of ${deposit.amount} (${taxDeposits.KINDS[deposit.kind].label}, ${deposit.period_key}, paid ${deposit.paid_on})`);
  req.flash('success', 'Recorded payment removed.');
  res.redirect(`/pay/deposits?year=${readYear(req.body.year)}`);
});

// ---- Tax reports --------------------------------------------------------------------

function readQuarter(req) {
  const year = readYear(req.query.year);
  const q = Number(req.query.quarter);
  return { year, quarter: [1, 2, 3, 4].includes(q) ? q : Math.ceil(Number(time.todayStr().slice(5, 7)) / 3) };
}

// The numbers for Form 941, DE 9 and DE 9C (each quarter) and Form 940 (each year).
router.get('/reports', async (req, res) => {
  const { year, quarter } = readQuarter(req);
  const [report, annual] = await Promise.all([taxReports.quarterReport(year, quarter, res.locals.settings), taxReports.yearReport(year)]);
  res.render('pay/reports', {
    title: `Tax reports ${year} Q${quarter}`,
    year,
    quarter,
    report,
    annual,
    quarterDue: taxDeposits.quarterPeriod(year, quarter).due,
    yearDue: taxDeposits.quarterPeriod(year, 4).due,
  });
});

// DE 9C with full Social Security numbers, to type in or upload (asks for a fresh two-step code).
router.get('/reports/de9c.csv', requireRecentCode, async (req, res) => {
  const { year, quarter } = readQuarter(req);
  const report = await taxReports.quarterReport(year, quarter, res.locals.settings);
  const profiles = new Map((await db.all('SELECT employee_id, legal_name, ssn_encrypted FROM withholding_profiles')).map((p) => [p.employee_id, p]));
  const rows = [['Employee', 'Social Security number', 'Total subject wages', 'PIT wages', 'PIT withheld']];
  for (const e of report.de9c.employees) {
    const p = profiles.get(e.employee_id);
    const ssn = p ? (await decrypt(p.ssn_encrypted)).replace(/^(\d{3})(\d{2})(\d{4})$/, '$1-$2-$3') : 'MISSING';
    rows.push([p?.legal_name || `${e.first_name} ${e.last_name}`, ssn, e.wages, e.wages, e.pit]);
  }
  await logActivity(req, `Downloaded the DE 9C for ${year} quarter ${quarter} (with Social Security numbers)`);
  res.attachment(`DE9C-${year}-Q${quarter}.csv`);
  res.type('text/csv').send(rows.map((row) => row.map(csvCell).join(',')).join('\r\n'));
});

// ---- Pages ------------------------------------------------------------------------

router.get('/', async (req, res) => {
  await recordFinishedShifts();
  const [runs, unpaid] = await Promise.all([
    db.all(
      `SELECT p.*, COUNT(i.id)::int AS people, COALESCE(SUM(i.gross_pay), 0) AS gross_total, COALESCE(SUM(i.net_pay), 0) AS net_total,
         COALESCE(SUM(i.regular_hours + i.overtime_hours + i.double_time_hours), 0) AS hours_total
       FROM pay_runs p LEFT JOIN pay_run_items i ON i.pay_run_id = p.id
       GROUP BY p.id ORDER BY p.period_end DESC`
    ),
    db.get("SELECT COUNT(*)::int AS n FROM time_entries WHERE status = 'approved' AND pay_run_id IS NULL"),
  ]);
  res.render('pay/index', { title: 'Pay', runs, approvedUnpaid: unpaid.n });
});

router.get('/new', async (req, res) => {
  res.render('pay/new', { title: 'New pay run', values: { ...(await suggestedPeriod()), notes: '' }, error: null });
});

router.post('/', async (req, res) => {
  const values = {
    period_start: String(req.body.period_start || ''),
    period_end: String(req.body.period_end || ''),
    notes: String(req.body.notes || '').trim() || null,
  };
  let error = null;
  if (!time.isValidDate(values.period_start) || !time.isValidDate(values.period_end)) {
    error = 'Please choose both dates.';
  } else if (values.period_end < values.period_start) {
    error = 'The end date must be on or after the start date.';
  }
  if (error) return res.status(400).render('pay/new', { title: 'New pay run', values, error });

  const id = await db.insert(
    'INSERT INTO pay_runs (period_start, period_end, notes, created_by) VALUES (?, ?, ?, ?)',
    values.period_start,
    values.period_end,
    values.notes,
    req.user.id
  );
  await recalculate(await findRun(id), res.locals.settings);
  await logActivity(req, `Created pay run for ${values.period_start} to ${values.period_end}`);
  req.flash('success', 'Draft pay run created. Check the numbers, then finalize it.');
  res.redirect(`/pay/${id}`);
});

router.get('/:id', async (req, res) => {
  const run = await findRun(req.params.id);
  if (!run) return notFound(res, 'pay run');
  if (run.status === 'draft') await recordFinishedShifts();

  const [items, notIncluded, changed] = await Promise.all([
    runItems(run.id),
    // Hours in this period that are NOT included, so nothing gets forgotten.
    db.all(
      `SELECT status, COUNT(*)::int AS n FROM time_entries
       WHERE pay_run_id IS NULL AND status != 'rejected' AND substr(start_at, 1, 10) BETWEEN ? AND ?
       GROUP BY status`,
      run.period_start,
      run.period_end
    ),
    // Hours in this draft that were un-approved after it was calculated.
    db.get("SELECT COUNT(*)::int AS n FROM time_entries WHERE pay_run_id = ? AND status != 'approved'", run.id),
  ]);
  const missing = Object.fromEntries(notIncluded.map((r) => [r.status, r.n]));
  const draft = run.status === 'draft';

  res.render('pay/show', {
    title: `Pay run ${time.fmtDate(run.period_start)} – ${time.fmtDate(run.period_end)}`,
    run,
    items,
    totals: totalsOf(items),
    hasW2: items.some((i) => i.tax_form === 'W-2'),
    payDate: paycheck.payDateOf(run),
    pendingCount: missing.pending || 0,
    approvedNotIncluded: missing.approved || 0,
    changedCount: changed.n,
    problems: draft ? paycheck.finalizeProblems({ run, items, settings: res.locals.settings }) : [],
    noW4: draft ? items.filter((i) => i.tax_form === 'W-2' && !i.has_w4) : [],
    noW9: draft ? items.filter((i) => i.tax_form === '1099' && !i.has_w9) : [],
  });
});

router.post('/:id/recalculate', async (req, res) => {
  const run = await findRun(req.params.id);
  if (!run) return notFound(res, 'pay run');
  if (!draftOnly(req, res, run)) return;
  await recalculate(run, res.locals.settings);
  await logActivity(req, `Recalculated pay run #${run.id}`);
  req.flash('success', 'Pay run recalculated using the latest approved hours, pay rates, overtime settings and tax details.');
  res.redirect(`/pay/${run.id}`);
});

// One person's pay line in detail: how gross became net, and (in a draft) the
// adjustment, paid sick leave and deduction to change.
router.get('/:id/items/:itemId', async (req, res) => {
  const run = await findRun(req.params.id);
  if (!run) return notFound(res, 'pay run');
  const item = (await runItems(run.id)).find((i) => i.id === Number(req.params.itemId));
  if (!item) return notFound(res, 'pay line');
  let sickLimit = null;
  if (run.status === 'draft' && item.tax_form === 'W-2') {
    // What could be used if the office entered more (the line itself already has it applied).
    const employee = await db.get('SELECT id, hourly_rate, tax_form, start_date FROM employees WHERE id = ?', item.employee_id);
    const line = await paycheck.completeLine(db, { run, employee, hours: item, inputs: { ...item, sick_hours: 1e6 }, settings: res.locals.settings });
    sickLimit = line.sick_limit;
  }
  res.render('pay/line', { title: `Pay – ${employeeName(item)}`, run, item, sickLimit, payDate: paycheck.payDateOf(run) });
});

router.post('/:id/items/:itemId', async (req, res) => {
  const run = await findRun(req.params.id);
  if (!run) return notFound(res, 'pay run');
  if (!draftOnly(req, res, run)) return;
  const item = await db.get('SELECT * FROM pay_run_items WHERE id = ? AND pay_run_id = ?', req.params.itemId, run.id);
  if (!item) return notFound(res, 'pay line');
  const back = req.body.back === 'line' ? `/pay/${run.id}/items/${item.id}` : `/pay/${run.id}`;

  // Only the fields on the form that was sent change; the rest stay as they are.
  const inputs = {};
  for (const field of INPUT_FIELDS) {
    if (req.body[field] === undefined) inputs[field] = item[field];
    else if (field.endsWith('_note')) inputs[field] = String(req.body[field]).trim().slice(0, 120) || null;
    else inputs[field] = toNumber(req.body[field], 0);
  }
  let error = null;
  if (Number.isNaN(inputs.adjustment)) error = 'The adjustment must be a number, e.g. 50 or -20.';
  else if (Number.isNaN(inputs.sick_hours) || inputs.sick_hours < 0) error = 'Sick leave is a number of hours, like 8.';
  else if (Number.isNaN(inputs.deduction) || inputs.deduction < 0) error = 'The deduction must be an amount of 0 or more, like 25.';
  if (!error) {
    error = await db.transaction(async (tx) => {
      const employee = await tx.get('SELECT id, hourly_rate, tax_form, start_date FROM employees WHERE id = ?', item.employee_id);
      if (employee.tax_form !== item.tax_form) return 'They are now paid as a different kind of worker (W-2 or 1099). Press Recalculate first.';
      const line = await paycheck.completeLine(tx, { run, employee, hours: item, inputs, settings: res.locals.settings });
      if (inputs.sick_hours > 0 && item.tax_form !== 'W-2') return 'Paid sick leave is for W-2 employees.';
      if (line.sick_hours < inputs.sick_hours) return `Only ${line.sick_hours} hours of paid sick leave can be paid now. ${line.sick_limit.reason}`;
      if (line.net_pay < 0) return 'The deduction is more than the pay left after taxes.';
      await paycheck.updateLine(tx, item.id, line);
      return null;
    });
  }
  if (error) {
    req.flash('error', error);
    return res.redirect(back);
  }
  const changes = INPUT_FIELDS.filter((f) => !f.endsWith('_note') && inputs[f] !== item[f]).map((f) => `${f.replace('_', ' ')} ${inputs[f]}`);
  await logActivity(req, `Changed a pay line on pay run #${run.id}${changes.length ? ` (${changes.join(', ')})` : ''}`);
  req.flash('success', 'Saved. Taxes and net pay are updated.');
  res.redirect(back);
});

router.post('/:id/finalize', async (req, res) => {
  const run = await findRun(req.params.id);
  if (!run) return notFound(res, 'pay run');
  if (!draftOnly(req, res, run)) return;
  // The day the money goes out: it decides the tax year (and 1099s count pay by it).
  const paidOn = time.isValidDate(req.body.paid_on) ? req.body.paid_on : time.todayStr();
  await db.run('UPDATE pay_runs SET paid_on = ? WHERE id = ?', paidOn, run.id);
  // Recalculate first, so hours rejected or edited since the draft was made are never paid by mistake.
  await recalculate({ ...run, paid_on: paidOn }, res.locals.settings);
  const problems = paycheck.finalizeProblems({ run: { ...run, paid_on: paidOn }, items: await runItems(run.id), settings: res.locals.settings });
  if (problems.length) {
    req.flash('error', `Not finalized yet: ${problems.join(' ')}`);
    return res.redirect(`/pay/${run.id}`);
  }
  await db.run(
    "UPDATE pay_runs SET status = 'finalized', finalized_at = app_now(), finalized_by = ? WHERE id = ?",
    req.user.id,
    run.id
  );
  await logActivity(req, `Finalized pay run #${run.id} (${run.period_start} to ${run.period_end})`);
  const paid = await db.all('SELECT employee_id FROM pay_run_items WHERE pay_run_id = ?', run.id);
  await notifyEmployees(paid.map((p) => p.employee_id), {
    title: 'Pay day',
    body: `Your pay stub and timesheet for ${time.fmtDate(run.period_start)} – ${time.fmtDate(run.period_end)} are ready.`,
    url: '/my/pay',
    tag: `pay-${run.id}`,
  });
  req.flash('success', 'Pay run finalized using the latest approved hours. Those hours are now locked, and each officer can see their pay stub and DMI timesheet under My pay.');
  res.redirect(`/pay/${run.id}`);
});

router.post('/:id/delete', async (req, res) => {
  const run = await findRun(req.params.id);
  if (!run) return notFound(res, 'pay run');
  if (!draftOnly(req, res, run)) return;
  await db.run('DELETE FROM pay_runs WHERE id = ?', run.id); // its hours become available again
  await logActivity(req, `Deleted draft pay run #${run.id}`);
  req.flash('success', 'Draft pay run deleted.');
  res.redirect('/pay');
});

// Download as a spreadsheet (CSV) – handy for your accountant.
router.get('/:id/export.csv', async (req, res) => {
  const run = await findRun(req.params.id);
  if (!run) return notFound(res, 'pay run');
  const header = [
    'Employee', 'Position', 'Regular hours', 'Overtime hours', 'Double time hours', 'Hourly rate', 'Overtime multiplier',
    'Regular pay', 'Overtime pay', 'Double time pay', 'Adjustment', 'Adjustment note', 'Gross pay',
    'Paid as', 'Sick leave hours', 'Sick leave pay', 'Federal income tax', 'Social Security', 'Medicare', 'Additional Medicare',
    'California income tax', 'California SDI', 'Deduction', 'Deduction note', 'Net pay',
    'Employer Social Security', 'Employer Medicare', 'FUTA', 'California UI', 'California ETT',
  ];
  const rows = (await runItems(run.id)).map((i) => [
    employeeName(i), i.position, i.regular_hours, i.overtime_hours, i.double_time_hours, i.hourly_rate, i.overtime_multiplier,
    i.regular_pay, i.overtime_pay, i.double_time_pay, i.adjustment, i.adjustment_note, i.gross_pay,
    i.tax_form, i.sick_hours, i.sick_pay, i.fed_income_tax, i.social_security, i.medicare, i.additional_medicare,
    i.ca_income_tax, i.ca_sdi, i.deduction, i.deduction_note, i.net_pay,
    i.employer_social_security, i.employer_medicare, i.futa, i.ca_ui, i.ca_ett,
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  res.attachment(`pay-run-${run.period_start}-to-${run.period_end}.csv`);
  res.type('text/csv').send(csv);
});

// One person's DMI timesheet for a finalized pay run, stamped "Approved by"
// with whoever finalized it. Opens in the browser; ?download=1 saves it.
router.get('/:id/items/:itemId/timesheet.pdf', async (req, res) => {
  const line = await findPayLine(req.params.itemId);
  if (!line || line.pay_run_id !== Number(req.params.id)) return notFound(res, 'pay line');
  if (line.run_status !== 'finalized') {
    req.flash('error', 'The DMI timesheets are made once the pay run is finalized.');
    return res.redirect(`/pay/${line.pay_run_id}`);
  }
  await sendUpload(res, await payLineTimesheet(line), timesheetFileName(line), { inline: !req.query.download });
});

// A printable pay stub for one person.
router.get('/:id/payslips/:itemId', async (req, res) => {
  const run = await findRun(req.params.id);
  if (!run) return notFound(res, 'pay run');
  const item = (await runItems(run.id)).find((i) => i.id === Number(req.params.itemId));
  if (!item) return notFound(res, 'payslip');
  res.render('pay/payslip', { title: `Pay stub – ${employeeName(item)}`, ...(await payslipData(run, item, res.locals.settings)) });
});

module.exports = router;
