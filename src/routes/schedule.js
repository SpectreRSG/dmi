// Schedule (the roster): planning who works where and when.
const express = require('express');
const db = require('../db');
const { clean, toId, toNumber, notFound, numericIdParam, logActivity, employeeName } = require('../helpers');
const time = require('../time');
const { entryHours, round2 } = require('../services/payroll');
const { complianceForEmployee } = require('../services/compliance');

const router = express.Router();
numericIdParam(router);

const MAX_REPEAT_WEEKS = 26;

const SHIFT_SELECT = `
  SELECT s.*, si.name AS site_name, c.name AS client_name, e.first_name, e.last_name
  FROM shifts s
  JOIN sites si ON si.id = s.site_id
  JOIN clients c ON c.id = si.client_id
  LEFT JOIN employees e ON e.id = s.employee_id`;

function siteOptions(includeId) {
  return db
    .prepare(
      `SELECT si.id, si.name, c.name AS client_name FROM sites si JOIN clients c ON c.id = si.client_id
       WHERE si.active = 1 OR si.id = ? ORDER BY c.name, si.name`
    )
    .all(includeId || 0);
}

function staffOptions(includeId) {
  return db
    .prepare(
      `SELECT id, first_name, last_name FROM employees WHERE status = 'active' OR id = ? ORDER BY last_name, first_name`
    )
    .all(includeId || 0);
}

function findShift(id) {
  return db.prepare(`${SHIFT_SELECT} WHERE s.id = ?`).get(id);
}

// Is this person already booked for a shift that overlaps these times?
function findClash(employeeId, startAt, endAt, ignoreShiftId = 0) {
  return db
    .prepare(
      `${SHIFT_SELECT} WHERE s.employee_id = ? AND s.status != 'cancelled' AND s.id != ?
       AND s.start_at < ? AND s.end_at > ? LIMIT 1`
    )
    .get(employeeId, ignoreShiftId, endAt, startAt);
}

function clashMessage(clash) {
  return `${employeeName(clash)} is already booked ${time.fmtDay(clash.start_at)} ${time.fmtRange(clash.start_at, clash.end_at)} at ${clash.site_name}.`;
}

// Warn (but don't block) if the person's license or required training will
// be missing or expired on the day of the shift.
function complianceWarning(employeeId, shiftDate, warningDays) {
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  const { items } = complianceForEmployee(employee, warningDays);
  const problems = items.filter((i) => i.status === 'missing' || (i.expires_on && i.expires_on < shiftDate));
  if (!problems.length) return null;
  const list = problems.map((p) => `${p.label} (${p.status === 'missing' ? 'missing' : 'expired'})`).join(', ');
  return `Check ${employeeName(employee)}'s compliance: ${list}.`;
}

function readForm(body) {
  const v = clean(body, ['site_id', 'employee_id', 'date', 'start_time', 'end_time', 'break_minutes', 'notes', 'status', 'repeat_weeks']);
  const values = {
    site_id: toId(v.site_id),
    employee_id: toId(v.employee_id),
    date: v.date,
    start_time: v.start_time,
    end_time: v.end_time,
    break_minutes: toNumber(v.break_minutes, 0),
    notes: v.notes,
    status: ['scheduled', 'completed', 'cancelled'].includes(v.status) ? v.status : 'scheduled',
    repeat_weeks: Math.min(Math.max(parseInt(v.repeat_weeks, 10) || 0, 0), MAX_REPEAT_WEEKS),
  };

  let error = null;
  if (!values.site_id || !db.prepare('SELECT 1 FROM sites WHERE id = ?').get(values.site_id)) {
    error = 'Please choose a site.';
  } else if (values.employee_id && !db.prepare('SELECT 1 FROM employees WHERE id = ?').get(values.employee_id)) {
    error = 'Please choose a staff member from the list.';
  } else if (!time.isValidDate(values.date)) {
    error = 'Please choose a date.';
  } else if (!time.isValidTime(values.start_time) || !time.isValidTime(values.end_time)) {
    error = 'Please enter a start time and an end time.';
  } else if (!Number.isInteger(values.break_minutes) || values.break_minutes < 0 || values.break_minutes > 600) {
    error = 'Break must be a whole number of minutes.';
  }
  if (!error) Object.assign(values, time.buildRange(values.date, values.start_time, values.end_time));
  return { values, error };
}

function renderForm(res, shift, error, status = 200) {
  res.status(status).render('schedule/form', {
    title: shift.id ? 'Edit shift' : 'Add shift',
    shift,
    error,
    sites: siteOptions(shift.site_id),
    staff: staffOptions(shift.employee_id),
    maxRepeat: MAX_REPEAT_WEEKS,
  });
}

// Moves a '2026-10-20T22:00' style value forward by a number of days.
function shiftDateTime(dateTime, days) {
  return time.addDays(dateTime.slice(0, 10), days) + dateTime.slice(10);
}

// ---- Week view ------------------------------------------------------------------

router.get('/', (req, res) => {
  const today = time.todayStr();
  const week = time.startOfWeek(time.isValidDate(req.query.week) ? req.query.week : today);
  const siteId = toId(req.query.site);
  const employeeId = toId(req.query.employee);

  const where = ['s.start_at >= ?', 's.start_at < ?'];
  const params = [`${week}T00:00`, `${time.addDays(week, 7)}T00:00`];
  if (siteId) {
    where.push('s.site_id = ?');
    params.push(siteId);
  }
  if (employeeId) {
    where.push('s.employee_id = ?');
    params.push(employeeId);
  }
  const shifts = db.prepare(`${SHIFT_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.start_at, si.name`).all(...params);

  const days = Array.from({ length: 7 }, (_, i) => {
    const date = time.addDays(week, i);
    return { date, shifts: shifts.filter((s) => s.start_at.startsWith(date)) };
  });

  // Scheduled hours per person this week (helps spot overtime early).
  const totals = new Map();
  for (const s of shifts) {
    if (!s.employee_id || s.status === 'cancelled') continue;
    const row = totals.get(s.employee_id) || { id: s.employee_id, name: employeeName(s), shifts: 0, hours: 0 };
    row.shifts += 1;
    row.hours = round2(row.hours + entryHours(s));
    totals.set(s.employee_id, row);
  }

  res.render('schedule/week', {
    title: 'Schedule',
    week,
    prevWeek: time.addDays(week, -7),
    nextWeek: time.addDays(week, 7),
    thisWeek: time.startOfWeek(today),
    today,
    days,
    totals: [...totals.values()].sort((a, b) => b.hours - a.hours),
    unfilled: shifts.filter((s) => !s.employee_id && s.status === 'scheduled').length,
    sites: siteOptions(),
    staff: staffOptions(),
    siteId,
    employeeId,
  });
});

// ---- Add / edit -------------------------------------------------------------------

router.get('/new', (req, res) => {
  renderForm(
    res,
    {
      date: time.isValidDate(req.query.date) ? req.query.date : time.todayStr(),
      site_id: toId(req.query.site),
      employee_id: toId(req.query.employee),
      start_time: '07:00',
      end_time: '19:00',
      break_minutes: 0,
      repeat_weeks: 0,
    },
    null
  );
});

router.post('/', (req, res) => {
  const { values, error } = readForm(req.body);
  if (error) return renderForm(res, values, error, 400);

  if (values.employee_id) {
    const clash = findClash(values.employee_id, values.start_at, values.end_at);
    if (clash) return renderForm(res, values, clashMessage(clash), 400);
  }

  const insert = db.prepare(
    `INSERT INTO shifts (site_id, employee_id, start_at, end_at, break_minutes, notes)
     VALUES (@site_id, @employee_id, @start_at, @end_at, @break_minutes, @notes)`
  );
  let created = 0;
  let skipped = 0;
  db.transaction(() => {
    for (let week = 0; week <= values.repeat_weeks; week += 1) {
      const start_at = shiftDateTime(values.start_at, week * 7);
      const end_at = shiftDateTime(values.end_at, week * 7);
      if (week > 0 && values.employee_id && findClash(values.employee_id, start_at, end_at)) {
        skipped += 1;
        continue;
      }
      insert.run({ ...values, start_at, end_at });
      created += 1;
    }
  })();

  logActivity(req, `Added ${created} shift(s) starting ${values.date}`);
  req.flash('success', created === 1 ? 'Shift added.' : `${created} shifts added (one per week).`);
  if (skipped) req.flash('warning', `${skipped} repeat shift(s) were skipped because the person was already booked.`);
  if (values.employee_id) {
    const warning = complianceWarning(values.employee_id, values.date, res.locals.settings.expiry_warning_days);
    if (warning) req.flash('warning', warning);
  }
  res.redirect(`/schedule?week=${time.startOfWeek(values.date)}`);
});

router.get('/:id/edit', (req, res) => {
  const shift = findShift(req.params.id);
  if (!shift) return notFound(res, 'shift');
  const timeEntry = db.prepare('SELECT id FROM time_entries WHERE shift_id = ?').get(shift.id);
  renderForm(res, {
    ...shift,
    date: shift.start_at.slice(0, 10),
    start_time: time.fmtTime(shift.start_at),
    end_time: time.fmtTime(shift.end_at),
    time_entry_id: timeEntry?.id,
  });
});

router.post('/:id', (req, res) => {
  const shift = findShift(req.params.id);
  if (!shift) return notFound(res, 'shift');
  const { values, error } = readForm(req.body);
  if (error) return renderForm(res, { ...values, id: shift.id }, error, 400);

  if (values.employee_id && values.status !== 'cancelled') {
    const clash = findClash(values.employee_id, values.start_at, values.end_at, shift.id);
    if (clash) return renderForm(res, { ...values, id: shift.id }, clashMessage(clash), 400);
  }

  db.prepare(
    `UPDATE shifts SET site_id = @site_id, employee_id = @employee_id, start_at = @start_at, end_at = @end_at,
     break_minutes = @break_minutes, status = @status, notes = @notes WHERE id = @id`
  ).run({ ...values, id: shift.id });

  logActivity(req, `Updated shift #${shift.id} on ${values.date}`);
  req.flash('success', 'Shift saved.');
  if (values.employee_id && values.employee_id !== shift.employee_id) {
    const warning = complianceWarning(values.employee_id, values.date, res.locals.settings.expiry_warning_days);
    if (warning) req.flash('warning', warning);
  }
  res.redirect(`/schedule?week=${time.startOfWeek(values.date)}`);
});

router.post('/:id/delete', (req, res) => {
  const shift = findShift(req.params.id);
  if (!shift) return notFound(res, 'shift');
  db.prepare('DELETE FROM shifts WHERE id = ?').run(shift.id);
  logActivity(req, `Deleted shift #${shift.id} (${shift.site_name}, ${shift.start_at.slice(0, 10)})`);
  req.flash('success', 'Shift deleted.');
  res.redirect(`/schedule?week=${time.startOfWeek(shift.start_at.slice(0, 10))}`);
});

// "Worked as planned": marks the shift completed and copies it into the
// timesheets so it can be approved and paid.
router.post('/:id/complete', (req, res) => {
  const shift = findShift(req.params.id);
  if (!shift) return notFound(res, 'shift');
  const back = `/schedule?week=${time.startOfWeek(shift.start_at.slice(0, 10))}`;
  if (!shift.employee_id) {
    req.flash('error', 'Assign someone to this shift before marking it as worked.');
    return res.redirect(back);
  }
  if (db.prepare('SELECT 1 FROM time_entries WHERE shift_id = ?').get(shift.id)) {
    req.flash('warning', 'This shift is already in the timesheets.');
    return res.redirect(back);
  }
  db.transaction(() => {
    db.prepare(
      `INSERT INTO time_entries (employee_id, site_id, shift_id, start_at, end_at, break_minutes, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(shift.employee_id, shift.site_id, shift.id, shift.start_at, shift.end_at, shift.break_minutes, shift.notes);
    db.prepare("UPDATE shifts SET status = 'completed' WHERE id = ?").run(shift.id);
  })();
  logActivity(req, `Marked shift #${shift.id} as worked by ${employeeName(shift)}`);
  req.flash('success', `Shift marked as worked. ${employeeName(shift)}'s hours are waiting for approval in Timesheets.`);
  res.redirect(back);
});

module.exports = router;
