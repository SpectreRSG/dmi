// Pay runs: turn approved hours into pay for a period (admins only).
//
// How it works:
// 1. Create a pay run for a period (e.g. 1st-14th). It starts as a "draft".
// 2. The app finds every APPROVED timesheet entry in that period and works out
//    regular hours, overtime and gross pay for each person.
// 3. Add any adjustments (bonus, allowance, deduction) and check the numbers.
// 4. "Finalize" it. The hours are then locked so they can never be paid twice.
const express = require('express');
const db = require('../db');
const { toNumber, notFound, numericIdParam, logActivity, employeeName } = require('../helpers');
const time = require('../time');
const { calculatePayLine, entryHours, round2 } = require('../services/payroll');
const { recordFinishedShifts } = require('../services/hoursFromSchedule');
const { findPayLine, payLineTimesheet, timesheetFileName } = require('../services/payTimesheet');
const { sendUpload } = require('../uploads');
const { notifyEmployees } = require('../services/notify');

const router = express.Router();
numericIdParam(router);
router.param('itemId', (req, res, next, id) => (/^\d+$/.test(id) ? next() : next('route')));

function findRun(id) {
  return db.get(
    'SELECT p.*, u.name AS created_by_name FROM pay_runs p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?',
    id
  );
}

function runItems(runId) {
  return db.all(
    `SELECT i.*, e.first_name, e.last_name, e.position, e.email
     FROM pay_run_items i JOIN employees e ON e.id = i.employee_id
     WHERE i.pay_run_id = ? ORDER BY e.last_name, e.first_name`,
    runId
  );
}

function totalsOf(items) {
  return {
    regular_hours: round2(items.reduce((s, i) => s + i.regular_hours, 0)),
    overtime_hours: round2(items.reduce((s, i) => s + i.overtime_hours, 0)),
    adjustment: round2(items.reduce((s, i) => s + i.adjustment, 0)),
    gross_pay: round2(items.reduce((s, i) => s + i.gross_pay, 0)),
  };
}

// (Re)builds a draft pay run from the approved hours in its period.
async function recalculate(run, settings) {
  await recordFinishedShifts(); // shifts that just ended count too
  await db.transaction(async (tx) => {
    // Keep any adjustments already typed in.
    const previous = new Map(
      (await tx.all('SELECT employee_id, adjustment, adjustment_note FROM pay_run_items WHERE pay_run_id = ?', run.id)).map(
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

    for (const [employeeId, list] of byEmployee) {
      const old = previous.get(employeeId);
      const { hourly_rate } = await tx.get('SELECT hourly_rate FROM employees WHERE id = ?', employeeId);
      const line = calculatePayLine({
        entries: list,
        hourlyRate: hourly_rate,
        weeklyLimit: settings.overtime_weekly_hours,
        multiplier: settings.overtime_multiplier,
        adjustment: old?.adjustment || 0,
      });
      await tx.run(
        `INSERT INTO pay_run_items (pay_run_id, employee_id, regular_hours, overtime_hours, hourly_rate,
           overtime_multiplier, regular_pay, overtime_pay, adjustment, adjustment_note, gross_pay)
         VALUES (@pay_run_id, @employee_id, @regular_hours, @overtime_hours, @hourly_rate,
           @overtime_multiplier, @regular_pay, @overtime_pay, @adjustment, @adjustment_note, @gross_pay)`,
        { pay_run_id: run.id, employee_id: employeeId, adjustment_note: old?.adjustment_note ?? null, ...line }
      );
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

// ---- Pages ------------------------------------------------------------------------

router.get('/', async (req, res) => {
  await recordFinishedShifts();
  const [runs, unpaid] = await Promise.all([
    db.all(
      `SELECT p.*, COUNT(i.id)::int AS people, COALESCE(SUM(i.gross_pay), 0) AS gross_total,
         COALESCE(SUM(i.regular_hours + i.overtime_hours), 0) AS hours_total
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

  res.render('pay/show', {
    title: `Pay run ${time.fmtDate(run.period_start)} – ${time.fmtDate(run.period_end)}`,
    run,
    items,
    totals: totalsOf(items),
    pendingCount: missing.pending || 0,
    approvedNotIncluded: missing.approved || 0,
    changedCount: changed.n,
  });
});

router.post('/:id/recalculate', async (req, res) => {
  const run = await findRun(req.params.id);
  if (!run) return notFound(res, 'pay run');
  if (!draftOnly(req, res, run)) return;
  await recalculate(run, res.locals.settings);
  await logActivity(req, `Recalculated pay run #${run.id}`);
  req.flash('success', 'Pay run recalculated using the latest approved hours, pay rates and overtime settings.');
  res.redirect(`/pay/${run.id}`);
});

router.post('/:id/items/:itemId', async (req, res) => {
  const run = await findRun(req.params.id);
  if (!run) return notFound(res, 'pay run');
  if (!draftOnly(req, res, run)) return;
  const item = await db.get('SELECT * FROM pay_run_items WHERE id = ? AND pay_run_id = ?', req.params.itemId, run.id);
  if (!item) return notFound(res, 'pay line');
  const adjustment = toNumber(req.body.adjustment, 0);
  if (Number.isNaN(adjustment)) {
    req.flash('error', 'The adjustment must be a number, e.g. 50 or -20.');
    return res.redirect(`/pay/${run.id}`);
  }
  const note = String(req.body.adjustment_note || '').trim() || null;
  await db.run(
    'UPDATE pay_run_items SET adjustment = ?, adjustment_note = ?, gross_pay = ? WHERE id = ?',
    round2(adjustment),
    note,
    round2(item.regular_pay + item.overtime_pay + adjustment),
    item.id
  );
  await logActivity(req, `Set adjustment of ${adjustment} on pay run #${run.id}`);
  req.flash('success', 'Adjustment saved.');
  res.redirect(`/pay/${run.id}`);
});

router.post('/:id/finalize', async (req, res) => {
  const run = await findRun(req.params.id);
  if (!run) return notFound(res, 'pay run');
  if (!draftOnly(req, res, run)) return;
  // The day the money goes out (1099s count pay by the year it was paid).
  const paidOn = time.isValidDate(req.body.paid_on) ? req.body.paid_on : time.todayStr();
  // Recalculate first, so hours rejected or edited since the draft was made are never paid by mistake.
  await recalculate(run, res.locals.settings);
  await db.run(
    "UPDATE pay_runs SET status = 'finalized', finalized_at = app_now(), finalized_by = ?, paid_on = ? WHERE id = ?",
    req.user.id,
    paidOn,
    run.id
  );
  await logActivity(req, `Finalized pay run #${run.id} (${run.period_start} to ${run.period_end})`);
  const paid = await db.all('SELECT employee_id FROM pay_run_items WHERE pay_run_id = ?', run.id);
  await notifyEmployees(paid.map((p) => p.employee_id), {
    title: 'Pay day',
    body: `Your payslip and timesheet for ${time.fmtDate(run.period_start)} – ${time.fmtDate(run.period_end)} are ready.`,
    url: '/my/pay',
    tag: `pay-${run.id}`,
  });
  req.flash('success', 'Pay run finalized using the latest approved hours. Those hours are now locked, and each officer can see their payslip and DMI timesheet under My pay.');
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

// Download as a spreadsheet (CSV) – handy for your accountant or payroll provider.
router.get('/:id/export.csv', async (req, res) => {
  const run = await findRun(req.params.id);
  if (!run) return notFound(res, 'pay run');
  const header = [
    'Employee', 'Position', 'Regular hours', 'Overtime hours', 'Hourly rate', 'Overtime multiplier',
    'Regular pay', 'Overtime pay', 'Adjustment', 'Adjustment note', 'Gross pay',
  ];
  const rows = (await runItems(run.id)).map((i) => [
    employeeName(i), i.position, i.regular_hours, i.overtime_hours, i.hourly_rate, i.overtime_multiplier,
    i.regular_pay, i.overtime_pay, i.adjustment, i.adjustment_note, i.gross_pay,
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

// A printable payslip for one person.
router.get('/:id/payslips/:itemId', async (req, res) => {
  const run = await findRun(req.params.id);
  if (!run) return notFound(res, 'pay run');
  const item = (await runItems(run.id)).find((i) => i.id === Number(req.params.itemId));
  if (!item) return notFound(res, 'payslip');
  const entries = await db.all(
    `SELECT t.*, si.name AS site_name FROM time_entries t LEFT JOIN sites si ON si.id = t.site_id
     WHERE t.pay_run_id = ? AND t.employee_id = ? ORDER BY t.start_at`,
    run.id,
    item.employee_id
  );
  for (const entry of entries) entry.hours = round2(entryHours(entry));
  res.render('pay/payslip', { title: `Payslip – ${employeeName(item)}`, run, item, entries });
});

module.exports = router;
