// Timesheets: hours actually worked. Most are recorded (and approved) from the
// schedule by themselves when a shift ends; the office adds or fixes the rest.
const express = require('express');
const db = require('../db');
const { clean, toId, toNumber, asArray, notFound, numericIdParam, logActivity, goBack, employeeName } = require('../helpers');
const time = require('../time');
const { entryHours, round2 } = require('../services/payroll');
const { sendUpload } = require('../uploads');
const { finishCheckedTimesheets, makeApprovedCopy } = require('../services/timesheetApproval');
const { recordFinishedShifts } = require('../services/hoursFromSchedule');

const router = express.Router();
numericIdParam(router);

const STATUSES = ['pending', 'approved', 'rejected'];

const ENTRY_SELECT = `
  SELECT t.*, e.first_name, e.last_name, si.name AS site_name, u.name AS approver_name, p.status AS pay_run_status
  FROM time_entries t
  JOIN employees e ON e.id = t.employee_id
  LEFT JOIN sites si ON si.id = t.site_id
  LEFT JOIN users u ON u.id = t.approved_by
  LEFT JOIN pay_runs p ON p.id = t.pay_run_id`;

function findEntry(id) {
  return db.get(`${ENTRY_SELECT} WHERE t.id = ?`, id);
}

// Once hours have been paid in a finalized pay run they can't be changed.
function isLocked(entry) {
  return entry.pay_run_status === 'finalized';
}

function lockedMessage(req, res) {
  req.flash('error', 'These hours are part of a finalized pay run, so they can no longer be changed.');
  goBack(req, res, '/timesheets');
}

function siteOptions(includeId) {
  return db.all(
    `SELECT si.id, si.name, c.name AS client_name FROM sites si JOIN clients c ON c.id = si.client_id
     WHERE si.active = 1 OR si.id = ? ORDER BY c.name, si.name`,
    includeId || 0
  );
}

function staffOptions(includeId) {
  return db.all(
    `SELECT id, first_name, last_name FROM employees WHERE status = 'active' OR id = ? ORDER BY last_name, first_name`,
    includeId || 0
  );
}

async function readForm(body, entryId = 0) {
  const v = clean(body, ['employee_id', 'site_id', 'date', 'start_time', 'end_time', 'break_minutes', 'notes', 'break_note']);
  const values = {
    employee_id: toId(v.employee_id),
    site_id: toId(v.site_id),
    date: v.date,
    start_time: v.start_time,
    end_time: v.end_time,
    break_minutes: toNumber(v.break_minutes, 0),
    notes: v.notes,
    // Missed meal or rest breaks (each adds an hour's pay for W-2 employees, see services/breaks.js).
    missed_meal: body.missed_meal ? 1 : 0,
    missed_rest: body.missed_rest ? 1 : 0,
    break_note: v.break_note ? v.break_note.slice(0, 500) : null,
    approve_now: body.approve_now ? 1 : 0,
  };

  let error = null;
  if (!values.employee_id || !(await db.get('SELECT 1 FROM employees WHERE id = ?', values.employee_id))) {
    error = 'Please choose a staff member.';
  } else if (values.site_id && !(await db.get('SELECT 1 FROM sites WHERE id = ?', values.site_id))) {
    error = 'Please choose a site from the list.';
  } else if (!time.isValidDate(values.date)) {
    error = 'Please choose the date the work started.';
  } else if (!time.isValidTime(values.start_time) || !time.isValidTime(values.end_time)) {
    error = 'Please enter a start time and an end time.';
  } else if (!Number.isInteger(values.break_minutes) || values.break_minutes < 0 || values.break_minutes > 600) {
    error = 'Break must be a whole number of minutes.';
  }

  if (!error) {
    Object.assign(values, time.buildRange(values.date, values.start_time, values.end_time));
    // Stop the same hours being entered twice.
    const overlap = await db.get(
      `SELECT * FROM time_entries WHERE employee_id = ? AND id != ? AND status != 'rejected'
       AND start_at < ? AND end_at > ? LIMIT 1`,
      values.employee_id,
      entryId,
      values.end_at,
      values.start_at
    );
    if (overlap) {
      error = `These hours overlap another entry for the same person (${time.fmtDay(overlap.start_at)} ${time.fmtRange(overlap.start_at, overlap.end_at)}).`;
    }
  }
  return { values, error };
}

async function renderForm(res, entry, error, status = 200) {
  const [sites, staff] = await Promise.all([siteOptions(entry.site_id), staffOptions(entry.employee_id)]);
  res.status(status).render('timesheets/form', {
    title: entry.id ? 'Edit hours' : 'Add hours',
    entry,
    error,
    sites,
    staff,
  });
}

async function setStatus(entryIds, status, userId) {
  let changed = 0;
  await db.transaction(async (tx) => {
    for (const id of entryIds) {
      const result = await tx.run(
        `UPDATE time_entries SET status = ?, approved_by = ?, approved_at = app_now()
         WHERE id = ? AND (pay_run_id IS NULL OR pay_run_id NOT IN (SELECT id FROM pay_runs WHERE status = 'finalized'))`,
        status,
        userId,
        id
      );
      changed += result.changes;
    }
  });
  return changed;
}

// ---- Approved copies of officers' timesheets -----------------------------------

// After approving or rejecting: officer timesheets with no days left to check
// get their approved copy (which the officer sees in their account).
async function afterReview(req, entryIds) {
  const { approved, problems } = await finishCheckedTimesheets(entryIds, req.user);
  if (approved) {
    req.flash('success', `${approved} officer timesheet${approved === 1 ? ' is' : 's are'} now fully approved. The approved cop${approved === 1 ? 'y is' : 'ies are'} in the officer's account to view or download.`);
  }
  if (problems.length) req.flash('error', `The approved copy couldn't be made: ${problems.join('; ')}`);
}

// ---- List -----------------------------------------------------------------------

router.get('/', async (req, res) => {
  const status = [...STATUSES, 'all'].includes(req.query.status) ? req.query.status : 'pending';
  const employeeId = toId(req.query.employee);
  const from = time.isValidDate(req.query.from) ? req.query.from : null;
  const to = time.isValidDate(req.query.to) ? req.query.to : null;

  const where = ['1 = 1'];
  const params = [];
  if (status !== 'all') {
    where.push('t.status = ?');
    params.push(status);
  }
  if (employeeId) {
    where.push('t.employee_id = ?');
    params.push(employeeId);
  }
  if (from) {
    where.push('t.start_at >= ?');
    params.push(`${from}T00:00`);
  }
  if (to) {
    where.push('t.start_at < ?');
    params.push(`${time.addDays(to, 1)}T00:00`);
  }

  await recordFinishedShifts();
  const [entries, countRows, staff] = await Promise.all([
    db.all(`${ENTRY_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.start_at DESC LIMIT 500`, ...params),
    db.all('SELECT status, COUNT(*)::int AS n FROM time_entries GROUP BY status'),
    staffOptions(),
  ]);
  for (const entry of entries) entry.hours = round2(entryHours(entry));

  res.render('timesheets/index', {
    title: 'Timesheets',
    entries,
    totalHours: round2(entries.reduce((sum, e) => sum + e.hours, 0)),
    counts: Object.fromEntries(countRows.map((r) => [r.status, r.n])),
    status,
    employeeId,
    from,
    to,
    staff,
    isLocked,
  });
});

// ---- Timesheets officers sent in (with their PDF) ---------------------------------

router.get('/submissions', async (req, res) => {
  const submissions = await db.all(
    `SELECT s.*, e.first_name, e.last_name,
       (SELECT COUNT(*)::int FROM time_entries t WHERE t.submission_id = s.id AND t.status = 'pending') AS pending,
       u.name AS approver_name
     FROM timesheet_submissions s JOIN employees e ON e.id = s.employee_id LEFT JOIN users u ON u.id = s.approved_by
     WHERE s.status = 'submitted' ORDER BY s.submitted_at DESC LIMIT 200`
  );
  const counts = Object.fromEntries((await db.all('SELECT status, COUNT(*)::int AS n FROM time_entries GROUP BY status')).map((r) => [r.status, r.n]));
  res.render('timesheets/submissions', { title: 'Officer timesheets', submissions, counts });
});

// If making the approved copy failed when it was approved, try again.
router.post('/submissions/:id/approved-copy', async (req, res) => {
  const submission = await db.get('SELECT * FROM timesheet_submissions WHERE id = ?', req.params.id);
  if (!submission) return notFound(res, 'timesheet');
  if (submission.approved_at && !submission.approved_file_name) {
    try {
      await makeApprovedCopy(submission.id);
      req.flash('success', 'Approved copy made.');
    } catch (err) {
      req.flash('error', `The approved copy couldn't be made: ${err.message}`);
    }
  }
  res.redirect('/timesheets/submissions');
});

router.get('/submissions/:id/approved-pdf', async (req, res) => {
  const submission = await db.get('SELECT s.*, e.first_name, e.last_name FROM timesheet_submissions s JOIN employees e ON e.id = s.employee_id WHERE s.id = ?', req.params.id);
  if (!submission?.approved_file_name) return notFound(res, 'approved timesheet');
  const who = `${submission.last_name}_${submission.first_name}`.replace(/[^A-Za-z0-9_-]+/g, '');
  await sendUpload(res, submission.approved_file_name, `DMI_Timesheet_${who}_${submission.period_start}_to_${submission.period_end}_approved.pdf`, { inline: !req.query.download });
});

router.get('/submissions/:id/pdf', async (req, res) => {
  const submission = await db.get('SELECT * FROM timesheet_submissions WHERE id = ?', req.params.id);
  if (!submission?.file_name) return notFound(res, 'timesheet');
  const employee = await db.get('SELECT last_name, first_name FROM employees WHERE id = ?', submission.employee_id);
  const who = `${employee.last_name}_${employee.first_name}`.replace(/[^A-Za-z0-9_-]+/g, '');
  await sendUpload(res, submission.file_name, `DMI_Timesheet_${who}_${submission.period_start}_to_${submission.period_end}.pdf`, { inline: !req.query.download });
});

// ---- Add / edit -------------------------------------------------------------------

router.get('/new', async (req, res) => {
  await renderForm(
    res,
    {
      employee_id: toId(req.query.employee),
      date: time.isValidDate(req.query.date) ? req.query.date : time.todayStr(),
      start_time: '07:00',
      end_time: '19:00',
      break_minutes: 0,
    },
    null
  );
});

router.post('/', async (req, res) => {
  const { values, error } = await readForm(req.body);
  if (error) return renderForm(res, values, error, 400);
  const id = await db.insert(
    `INSERT INTO time_entries (employee_id, site_id, start_at, end_at, break_minutes, notes, missed_meal, missed_rest, break_note)
     VALUES (@employee_id, @site_id, @start_at, @end_at, @break_minutes, @notes, @missed_meal, @missed_rest, @break_note)`,
    values
  );
  if (values.approve_now) await setStatus([id], 'approved', req.user.id);
  const employee = await db.get('SELECT * FROM employees WHERE id = ?', values.employee_id);
  await logActivity(req, `Added hours for ${employeeName(employee)} on ${values.date}`);
  req.flash('success', `Hours added for ${employeeName(employee)}.`);
  res.redirect(values.approve_now ? '/timesheets?status=approved' : '/timesheets');
});

// Approve or reject many ticked rows at once.
router.post('/bulk', async (req, res) => {
  const ids = asArray(req.body.ids).map(toId).filter(Boolean);
  const status = req.body.action === 'reject' ? 'rejected' : 'approved';
  if (!ids.length) {
    req.flash('warning', 'Tick at least one row first.');
    return goBack(req, res, '/timesheets');
  }
  const changed = await setStatus(ids, status, req.user.id);
  await logActivity(req, `${status === 'approved' ? 'Approved' : 'Rejected'} ${changed} timesheet entries`);
  req.flash('success', `${changed} entr${changed === 1 ? 'y' : 'ies'} ${status}.`);
  await afterReview(req, ids);
  goBack(req, res, '/timesheets');
});

router.get('/:id/edit', async (req, res) => {
  const entry = await findEntry(req.params.id);
  if (!entry) return notFound(res, 'timesheet entry');
  if (isLocked(entry)) return lockedMessage(req, res);
  await renderForm(res, {
    ...entry,
    date: entry.start_at.slice(0, 10),
    start_time: time.fmtTime(entry.start_at),
    end_time: time.fmtTime(entry.end_at),
  });
});

router.post('/:id', async (req, res) => {
  const entry = await findEntry(req.params.id);
  if (!entry) return notFound(res, 'timesheet entry');
  if (isLocked(entry)) return lockedMessage(req, res);
  const { values, error } = await readForm(req.body, entry.id);
  if (error) return renderForm(res, { ...values, id: entry.id, status: entry.status }, error, 400);
  await db.run(
    // Edited here, they're the office's hours now: changing the shift no longer changes them.
    `UPDATE time_entries SET employee_id = @employee_id, site_id = @site_id, start_at = @start_at, end_at = @end_at,
     break_minutes = @break_minutes, notes = @notes, missed_meal = @missed_meal, missed_rest = @missed_rest, break_note = @break_note,
     source = CASE WHEN source = 'schedule' THEN 'office' ELSE source END WHERE id = @id`,
    { ...values, id: entry.id }
  );
  await logActivity(req, `Edited hours #${entry.id} for ${employeeName(entry)}`);
  req.flash('success', 'Hours saved.');
  if (entry.pay_run_id) req.flash('warning', 'These hours are in a draft pay run. Open the pay run and press "Recalculate".');
  res.redirect('/timesheets?status=all');
});

router.post('/:id/delete', async (req, res) => {
  const entry = await findEntry(req.params.id);
  if (!entry) return notFound(res, 'timesheet entry');
  if (isLocked(entry)) return lockedMessage(req, res);
  await db.run('DELETE FROM time_entries WHERE id = ?', entry.id);
  await logActivity(req, `Deleted hours #${entry.id} for ${employeeName(entry)} (${entry.start_at.slice(0, 10)})`);
  req.flash('success', 'Hours deleted.');
  goBack(req, res, '/timesheets');
});

// ---- Approve / reject one entry ---------------------------------------------------

for (const [action, status] of [['approve', 'approved'], ['reject', 'rejected']]) {
  router.post(`/:id/${action}`, async (req, res) => {
    const entry = await findEntry(req.params.id);
    if (!entry) return notFound(res, 'timesheet entry');
    if (isLocked(entry)) return lockedMessage(req, res);
    await setStatus([entry.id], status, req.user.id);
    await logActivity(req, `${status === 'approved' ? 'Approved' : 'Rejected'} hours #${entry.id} for ${employeeName(entry)}`);
    req.flash('success', `Hours ${status}.`);
    await afterReview(req, [entry.id]);
    goBack(req, res, '/timesheets');
  });
}

module.exports = router;
