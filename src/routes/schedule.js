// Schedule (the roster): planning who works where and when.
const express = require('express');
const db = require('../db');
const { clean, toId, toNumber, asArray, notFound, numericIdParam, logActivity, employeeName } = require('../helpers');
const time = require('../time');
const { entryHours, round2 } = require('../services/payroll');
const { complianceForEmployee } = require('../services/compliance');
const { TYPES, findConflicts, coverOptions } = require('../services/conflicts');
const { recordFinishedShifts, hoursFromShift, syncHoursWithShift } = require('../services/hoursFromSchedule');
const openShifts = require('../services/openShifts');
const { tellAboutShiftChange, tellAboutNewShifts } = require('../services/shiftNews');
const availability = require('../services/availability');
const shiftRequests = require('../services/shiftRequests');

const router = express.Router();
numericIdParam(router);

// The conflict checker looks at most this many days at once.
const MAX_CHECK_DAYS = 92;

// Repeating shifts can run for up to a year, and at most this many at once.
const MAX_REPEAT_DAYS = 366;
const MAX_REPEAT_SHIFTS = 400;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const SHIFT_SELECT = `
  SELECT s.*, si.name AS site_name, c.name AS client_name, e.first_name, e.last_name
  FROM shifts s
  JOIN sites si ON si.id = s.site_id
  JOIN clients c ON c.id = si.client_id
  LEFT JOIN employees e ON e.id = s.employee_id`;

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

function findShift(id) {
  return db.get(`${SHIFT_SELECT} WHERE s.id = ?`, id);
}

// Is this person already booked for a shift that overlaps these times?
function findClash(conn, employeeId, startAt, endAt, ignoreShiftId = 0) {
  return conn.get(
    `${SHIFT_SELECT} WHERE s.employee_id = ? AND s.status != 'cancelled' AND s.id != ?
     AND s.start_at < ? AND s.end_at > ? LIMIT 1`,
    employeeId,
    ignoreShiftId,
    endAt,
    startAt
  );
}

function clashMessage(clash) {
  return `${employeeName(clash)} is already booked ${time.fmtDay(clash.start_at)} ${time.fmtRange(clash.start_at, clash.end_at)} at ${clash.site_name}.`;
}

// Warn (but don't block) if the person's license or required training will
// be missing or expired on the day of the shift.
async function complianceWarning(employeeId, shiftDate, warningDays) {
  const employee = await db.get('SELECT * FROM employees WHERE id = ?', employeeId);
  const { items } = await complianceForEmployee(employee, warningDays);
  const problems = items.filter((i) => i.status === 'missing' || (i.expires_on && i.expires_on < shiftDate));
  if (!problems.length) return null;
  const list = problems.map((p) => `${p.label} (${p.status === 'missing' ? 'missing' : 'expired'})`).join(', ');
  return `Check ${employeeName(employee)}'s compliance: ${list}.`;
}

// Warn (but don't block) if the person said they can't work then.
async function availabilityWarning(employeeId, startAt, endAt) {
  const { unavailable } = (await availability.statusDuring([employeeId], startAt, endAt)).get(employeeId);
  if (!unavailable) return null;
  const employee = await db.get('SELECT first_name, last_name FROM employees WHERE id = ?', employeeId);
  return `${employeeName(employee)} said they can't work then (${availability.describe(unavailable)}${unavailable.note ? `: ${unavailable.note}` : ''}). Check with them first.`;
}

async function readForm(body) {
  const v = clean(body, ['site_id', 'employee_id', 'date', 'start_time', 'end_time', 'break_minutes', 'notes', 'status', 'repeat_until']);
  const values = {
    site_id: toId(v.site_id),
    employee_id: toId(v.employee_id),
    date: v.date,
    start_time: v.start_time,
    end_time: v.end_time,
    break_minutes: toNumber(v.break_minutes, 0),
    notes: v.notes,
    status: ['scheduled', 'completed', 'cancelled'].includes(v.status) ? v.status : 'scheduled',
    // Days of the week to repeat on (0 = Monday … 6 = Sunday), and the last date to repeat to.
    repeat_days: [...new Set(asArray(body.repeat_days).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))],
    repeat_until: v.repeat_until,
  };

  let error = null;
  if (!values.site_id || !(await db.get('SELECT 1 FROM sites WHERE id = ?', values.site_id))) {
    error = 'Please choose a site.';
  } else if (values.employee_id && !(await db.get('SELECT 1 FROM employees WHERE id = ?', values.employee_id))) {
    error = 'Please choose a staff member from the list.';
  } else if (!time.isValidDate(values.date)) {
    error = 'Please choose a date.';
  } else if (!time.isValidTime(values.start_time) || !time.isValidTime(values.end_time)) {
    error = 'Please enter a start time and an end time.';
  } else if (!Number.isInteger(values.break_minutes) || values.break_minutes < 0 || values.break_minutes > 600) {
    error = 'Break must be a whole number of minutes.';
  } else if (values.repeat_days.length && !time.isValidDate(values.repeat_until)) {
    error = 'Choose the last date the shift should repeat until.';
  } else if (values.repeat_days.length && values.repeat_until < values.date) {
    error = 'The repeat end date must be on or after the first date.';
  } else if (values.repeat_days.length && time.daysBetween(values.date, values.repeat_until) > MAX_REPEAT_DAYS) {
    error = 'Shifts can repeat for up to one year at a time.';
  }
  if (!error) Object.assign(values, time.buildRange(values.date, values.start_time, values.end_time));
  return { values, error };
}

// Every date to create a shift on: the first date, then each ticked weekday up to the end date.
function repeatDates(values) {
  const dates = [values.date];
  if (!values.repeat_days.length) return dates;
  for (let d = time.addDays(values.date, 1); d <= values.repeat_until; d = time.addDays(d, 1)) {
    if (values.repeat_days.includes(time.dayOfWeek(d))) dates.push(d);
  }
  return dates;
}

async function renderForm(res, shift, error, status = 200) {
  const [sites, staff] = await Promise.all([siteOptions(shift.site_id), staffOptions(shift.employee_id)]);
  res.status(status).render('schedule/form', {
    title: shift.id ? 'Edit shift' : 'Add shift',
    shift,
    error,
    sites,
    staff,
    WEEKDAYS,
  });
}

// Moves a '2026-10-20T22:00' style value forward by a number of days.
function shiftDateTime(dateTime, days) {
  return time.addDays(dateTime.slice(0, 10), days) + dateTime.slice(10);
}

// ---- Week view ------------------------------------------------------------------

router.get('/', async (req, res) => {
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
  await recordFinishedShifts(); // so shifts that have ended show as completed
  const now = time.nowStr();
  const pendingRequests = await shiftRequests.pendingCount(now);
  // Conflicts from now on: days that have passed aren't checked.
  const checkFrom = week > today ? week : today;
  const checkTo = time.addDays(week, 6);
  const [shifts, sites, staff, conflicts] = await Promise.all([
    db.all(
      `SELECT x.*, EXISTS (SELECT 1 FROM shift_offers o WHERE o.shift_id = x.id AND o.status = 'open') AS offered
       FROM (${SHIFT_SELECT} WHERE ${where.join(' AND ')}) x ORDER BY x.start_at, x.site_name`,
      ...params
    ),
    siteOptions(),
    staffOptions(),
    checkFrom <= checkTo ? findConflicts(checkFrom, checkTo, res.locals.settings) : [],
  ]);

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
    pendingRequests,
    prevWeek: time.addDays(week, -7),
    nextWeek: time.addDays(week, 7),
    thisWeek: time.startOfWeek(today),
    today,
    days,
    totals: [...totals.values()].sort((a, b) => b.hours - a.hours),
    now,
    checkFrom,
    unfilled: shifts.filter((s) => !s.employee_id && s.status === 'scheduled' && s.start_at > now).length,
    conflictCount: conflicts.filter((c) => c.type !== 'unfilled').length,
    sites,
    staff,
    siteId,
    employeeId,
  });
});

// ---- Conflict checker -----------------------------------------------------------

// Only send people back to schedule pages after assigning cover.
function backTo(value, fallback) {
  return typeof value === 'string' && /^\/schedule(\/conflicts)?(\?[\w=&%.:-]*)?$/.test(value) ? value : fallback;
}

router.get('/conflicts', async (req, res) => {
  const today = time.todayStr();
  let from = time.isValidDate(req.query.from) ? req.query.from : today;
  let to = time.isValidDate(req.query.to) ? req.query.to : time.addDays(from, 27);
  let notice = null;
  if (to < from) [from, to] = [to, from];
  if (time.daysBetween(from, to) >= MAX_CHECK_DAYS) {
    to = time.addDays(from, MAX_CHECK_DAYS - 1);
    notice = `The checker looks at up to ${MAX_CHECK_DAYS} days at a time, so it stopped at ${time.fmtDate(to)}.`;
  }
  const type = TYPES[req.query.type] ? req.query.type : '';
  const issues = await findConflicts(from, to, res.locals.settings);
  const counts = Object.fromEntries(Object.keys(TYPES).map((t) => [t, issues.filter((i) => i.type === t).length]));
  res.render('schedule/conflicts', {
    title: 'Schedule conflicts',
    from,
    to,
    type,
    notice,
    issues: type ? issues.filter((i) => i.type === type) : issues,
    total: issues.length,
    counts,
    TYPES,
    here: req.originalUrl,
  });
});

// ---- Shift requests from sites --------------------------------------------------------
// Site representatives ask for shifts; approving one puts the shifts on the
// schedule as open shifts and offers them to officers (the ones asked for first).

router.get('/requests', async (req, res) => {
  const [pending, recent] = await Promise.all([
    db.all(
      `SELECT r.*, si.name AS site_name, c.name AS client_name, u.name AS requested_by_name FROM shift_requests r
       JOIN sites si ON si.id = r.site_id JOIN clients c ON c.id = r.client_id LEFT JOIN users u ON u.id = r.requested_by
       WHERE r.status = 'pending' ORDER BY r.start_at`
    ),
    db.all(
      `SELECT r.*, si.name AS site_name, c.name AS client_name, d.name AS decided_by_name FROM shift_requests r
       JOIN sites si ON si.id = r.site_id JOIN clients c ON c.id = r.client_id LEFT JOIN users d ON d.id = r.decided_by
       WHERE r.status != 'pending' ORDER BY r.decided_at DESC NULLS LAST LIMIT 30`
    ),
  ]);
  await shiftRequests.withDetails(pending);
  await shiftRequests.withDetails(recent);
  // For each officer a site asked for: can they actually take it? (For a
  // repeating request: on how many of its dates they can't.)
  for (const r of pending) {
    if (!r.asked.length) continue;
    r.dates = shiftRequests.datesFor(r);
    if (!r.repeating) {
      const said = await availability.statusDuring(r.asked.map((a) => a.id), r.start_at, r.end_at);
      for (const a of r.asked) {
        const clash = await findClash(db, a.id, r.start_at, r.end_at);
        a.problem = clash ? 'already booked' : said.get(a.id).unavailable ? "said they can't work" : null;
      }
      continue;
    }
    const times = shiftRequests.timesFor(r);
    const unavailable = await availability.unavailableCounts(r.asked.map((a) => a.id), times);
    for (const a of r.asked) {
      const { n: booked } = await db.get(
        `SELECT COUNT(*)::int AS n FROM unnest(?::text[], ?::text[]) AS t(start_at, end_at)
         WHERE EXISTS (SELECT 1 FROM shifts s WHERE s.employee_id = ? AND s.status != 'cancelled' AND s.start_at < t.end_at AND s.end_at > t.start_at)`,
        times.map((t) => t.start_at), times.map((t) => t.end_at), a.id
      );
      const cant = unavailable.get(a.id);
      a.problem = [booked && `already booked on ${booked} of ${times.length} dates`, cant && `said they can't work on ${cant}`].filter(Boolean).join('; ') || null;
    }
  }
  for (const r of pending) {
    r.dates ??= shiftRequests.datesFor(r);
    r.lastStart = shiftRequests.lastStartOf(r);
  }
  res.render('schedule/requests', { title: 'Shift requests', pending, recent, now: time.nowStr(), STATUS_LABELS: shiftRequests.STATUS_LABELS });
});

router.post('/requests/:id/approve', async (req, res) => {
  const result = await shiftRequests.approve(Number(req.params.id), { user: req.user, settings: res.locals.settings });
  if (result.error) {
    req.flash('error', result.error);
    return res.redirect('/schedule/requests');
  }
  const r = result.request;
  const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  await logActivity(req, `Approved shift request #${r.id} from ${r.client_name}: ${n(result.shifts.length, 'shift')}, ${shiftRequests.when(r)}`);
  const parts = [`Approved: ${n(result.shifts.length, 'open shift')} added to the schedule.`];
  if (result.offered) {
    parts.push(`${result.offered === result.shifts.length ? (result.offered === 1 ? "It's" : "They're") : `${result.offered} ${result.offered === 1 ? 'is' : 'are'}`} being offered to officers now${result.firstChoice.length ? ', the officers the site asked for first' : ''}.`);
  }
  if (result.later) parts.push(`The other ${result.later} will be offered about two weeks before each date.`);
  if (result.nobody) parts.push(`Nobody who could take ${result.nobody === 1 ? 'one' : result.nobody} is free, so use "Find cover" for ${result.nobody === 1 ? 'it' : 'them'}.`);
  if (result.skipped) parts.push(`${n(result.skipped, 'date')} had already passed and ${result.skipped === 1 ? 'was' : 'were'} skipped.`);
  parts.push('The site has been told.');
  req.flash('success', parts.join(' '));
  res.redirect('/schedule/requests');
});

router.post('/requests/:id/decline', async (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 300) || null;
  const result = await shiftRequests.decline(Number(req.params.id), { user: req.user, reason });
  if (result.error) req.flash('error', result.error);
  else {
    await logActivity(req, `Declined shift request #${req.params.id} from ${result.request.client_name}`);
    req.flash('success', 'Request declined. The site has been told.');
  }
  res.redirect('/schedule/requests');
});

// Everyone's availability for the next four weeks: when they can't work, and
// when they'd like extra shifts.
router.get('/availability', async (req, res) => {
  const from = time.todayStr();
  const to = time.addDays(from, 27);
  const staff = await db.all("SELECT id, first_name, last_name FROM employees WHERE status = 'active' ORDER BY last_name, first_name");
  const entries = await availability.entriesFor(staff.map((e) => e.id), from, to);
  const people = staff
    .map((e) => ({
      ...e,
      entries: entries.filter((x) => x.employee_id === e.id).map((x) => ({ ...x, label: availability.describe(x) })),
    }))
    .filter((e) => e.entries.length);
  res.render('schedule/availability', { title: 'Availability', people, from, to, KINDS: availability.KINDS });
});

router.get('/:id/cover', async (req, res) => {
  const shift = await findShift(req.params.id);
  if (!shift) return notFound(res, 'shift');
  const back = backTo(req.query.back, `/schedule?week=${time.startOfWeek(shift.start_at.slice(0, 10))}`);
  res.render('schedule/cover', {
    title: 'Find cover',
    shift,
    back,
    options: await coverOptions(shift, res.locals.settings),
  });
});

router.post('/:id/assign', async (req, res) => {
  const shift = await findShift(req.params.id);
  if (!shift) return notFound(res, 'shift');
  const back = backTo(req.body.back, `/schedule?week=${time.startOfWeek(shift.start_at.slice(0, 10))}`);
  const employeeId = toId(req.body.employee_id);
  const employee = employeeId && (await db.get("SELECT * FROM employees WHERE id = ? AND status = 'active'", employeeId));
  if (shift.status !== 'scheduled') {
    req.flash('error', 'Only scheduled shifts can be reassigned.');
    return res.redirect(back);
  }
  if (!employee) {
    req.flash('error', 'Please choose an active staff member.');
    return res.redirect(`/schedule/${shift.id}/cover?back=${encodeURIComponent(back)}`);
  }
  const clash = await findClash(db, employee.id, shift.start_at, shift.end_at, shift.id);
  if (clash) {
    req.flash('error', clashMessage(clash));
    return res.redirect(`/schedule/${shift.id}/cover?back=${encodeURIComponent(back)}`);
  }
  await db.run('UPDATE shifts SET employee_id = ? WHERE id = ?', employee.id, shift.id);
  await openShifts.withdrawOffer(shift.id, 'Assigned by the office');
  await tellAboutShiftChange(shift, await findShift(shift.id));
  const was = shift.employee_id ? ` (was ${employeeName(shift)})` : '';
  await logActivity(req, `Assigned ${employeeName(employee)} to shift #${shift.id} on ${shift.start_at.slice(0, 10)}${was}`);
  req.flash('success', `${employeeName(employee)} is now covering ${time.fmtDay(shift.start_at)} ${time.fmtRange(shift.start_at, shift.end_at)} at ${shift.site_name}.`);
  for (const warning of [
    await complianceWarning(employee.id, shift.start_at.slice(0, 10), res.locals.settings.expiry_warning_days),
    await availabilityWarning(employee.id, shift.start_at, shift.end_at),
  ]) if (warning) req.flash('warning', warning);
  res.redirect(back);
});

// ---- Add / edit -------------------------------------------------------------------

router.get('/new', async (req, res) => {
  await renderForm(
    res,
    {
      date: time.isValidDate(req.query.date) ? req.query.date : time.todayStr(),
      site_id: toId(req.query.site),
      employee_id: toId(req.query.employee),
      start_time: '07:00',
      end_time: '19:00',
      break_minutes: 0,
      repeat_days: [],
    },
    null
  );
});

router.post('/', async (req, res) => {
  const { values, error } = await readForm(req.body);
  if (error) return renderForm(res, values, error, 400);

  if (values.employee_id) {
    const clash = await findClash(db, values.employee_id, values.start_at, values.end_at);
    if (clash) return renderForm(res, values, clashMessage(clash), 400);
  }

  const dates = repeatDates(values);
  if (dates.length > MAX_REPEAT_SHIFTS) {
    return renderForm(res, values, `That would create ${dates.length} shifts. Please make it ${MAX_REPEAT_SHIFTS} or fewer at a time.`, 400);
  }

  let created = 0;
  let skipped = 0;
  const made = [];
  await db.transaction(async (tx) => {
    for (const date of dates) {
      const offset = time.daysBetween(values.date, date);
      const start_at = shiftDateTime(values.start_at, offset);
      const end_at = shiftDateTime(values.end_at, offset);
      if (offset > 0 && values.employee_id && (await findClash(tx, values.employee_id, start_at, end_at))) {
        skipped += 1;
        continue;
      }
      await tx.run(
        `INSERT INTO shifts (site_id, employee_id, start_at, end_at, break_minutes, notes)
         VALUES (@site_id, @employee_id, @start_at, @end_at, @break_minutes, @notes)`,
        { ...values, start_at, end_at }
      );
      made.push({ start_at, end_at });
      created += 1;
    }
  });

  await logActivity(req, `Added ${created} shift(s) starting ${values.date}`);
  if (values.employee_id) {
    const site = await db.get('SELECT name FROM sites WHERE id = ?', values.site_id);
    await tellAboutNewShifts(values.employee_id, made.map((m) => ({ ...m, site_name: site.name })));
  }
  req.flash('success', created === 1 ? 'Shift added.' : `${created} shifts added.`);
  if (skipped) req.flash('warning', `${skipped} repeat shift(s) were skipped because the person was already booked.`);
  if (values.employee_id) {
    for (const warning of [
      await complianceWarning(values.employee_id, values.date, res.locals.settings.expiry_warning_days),
      await availabilityWarning(values.employee_id, values.start_at, values.end_at),
    ]) if (warning) req.flash('warning', warning);
  }
  res.redirect(`/schedule?week=${time.startOfWeek(values.date)}`);
});

router.get('/:id/edit', async (req, res) => {
  const shift = await findShift(req.params.id);
  if (!shift) return notFound(res, 'shift');
  const timeEntry = await db.get(
    `SELECT t.id, t.source, t.status, p.status AS pay_run_status FROM time_entries t LEFT JOIN pay_runs p ON p.id = t.pay_run_id
     WHERE t.shift_id = ?`,
    shift.id
  );
  const [offer, callouts] = await Promise.all([
    db.get(
      `SELECT o.*, e.first_name AS filled_first, e.last_name AS filled_last,
         (SELECT COUNT(*)::int FROM shift_offer_recipients r WHERE r.offer_id = o.id AND r.notified_at IS NOT NULL) AS told,
         (SELECT COUNT(*)::int FROM shift_offer_recipients r WHERE r.offer_id = o.id AND r.notified_at IS NULL) AS waiting
       FROM shift_offers o LEFT JOIN employees e ON e.id = o.filled_by WHERE o.shift_id = ? ORDER BY o.id DESC LIMIT 1`,
      shift.id
    ),
    db.all(
      `SELECT c.*, e.first_name, e.last_name FROM shift_callouts c JOIN employees e ON e.id = c.employee_id
       WHERE c.shift_id = ? ORDER BY c.id`,
      shift.id
    ),
  ]);
  await renderForm(res, {
    ...shift,
    date: shift.start_at.slice(0, 10),
    start_time: time.fmtTime(shift.start_at),
    end_time: time.fmtTime(shift.end_at),
    time_entry: timeEntry,
    offer,
    callouts,
    upcoming: shift.status === 'scheduled' && shift.start_at > time.nowStr(),
  });
});

router.post('/:id', async (req, res) => {
  const shift = await findShift(req.params.id);
  if (!shift) return notFound(res, 'shift');
  const { values, error } = await readForm(req.body);
  if (error) return renderForm(res, { ...values, id: shift.id }, error, 400);

  if (values.employee_id && values.status !== 'cancelled') {
    const clash = await findClash(db, values.employee_id, values.start_at, values.end_at, shift.id);
    if (clash) return renderForm(res, { ...values, id: shift.id }, clashMessage(clash), 400);
  }
  // Once its hours are paid, only the notes can change.
  const recorded = await hoursFromShift(db, shift.id);
  if (recorded?.pay_run_status === 'finalized') {
    const same = ['site_id', 'employee_id', 'start_at', 'end_at', 'break_minutes', 'status'].every((f) => values[f] === shift[f]);
    if (!same) return renderForm(res, { ...values, id: shift.id }, 'The hours from this shift have already been paid, so only its notes can change now.', 400);
  }

  await db.transaction(async (tx) => {
    await tx.run(
      `UPDATE shifts SET site_id = @site_id, employee_id = @employee_id, start_at = @start_at, end_at = @end_at,
       break_minutes = @break_minutes, status = @status, notes = @notes WHERE id = @id`,
      { ...values, id: shift.id }
    );
    await syncHoursWithShift(tx, shift.id); // the hours recorded from it follow
  });

  const after = await findShift(shift.id);
  if (after.employee_id || after.status !== 'scheduled') await openShifts.withdrawOffer(shift.id, 'Changed by the office');
  await tellAboutShiftChange(shift, after);
  await logActivity(req, `Updated shift #${shift.id} on ${values.date}`);
  if (!recorded) req.flash('success', 'Shift saved.');
  else if (await hoursFromShift(db, shift.id)) req.flash('success', 'Shift saved, and the hours recorded from it now match.');
  else req.flash('success', 'Shift saved, and the hours recorded from it were removed.');
  if (recorded?.pay_run_id) req.flash('warning', 'Its hours were in a draft pay run. Open the pay run and press "Recalculate".');
  if (values.employee_id && values.employee_id !== shift.employee_id) {
    const warning = await complianceWarning(values.employee_id, values.date, res.locals.settings.expiry_warning_days);
    if (warning) req.flash('warning', warning);
  }
  if (values.employee_id && values.status === 'scheduled') {
    const warning = await availabilityWarning(values.employee_id, values.start_at, values.end_at);
    if (warning) req.flash('warning', warning);
  }
  res.redirect(`/schedule?week=${time.startOfWeek(values.date)}`);
});

// ---- Call-outs and open shifts -----------------------------------------------------

// Someone phoned in: take them off and offer the shift to the officers who could take it.
router.post('/:id/call-out', async (req, res) => {
  const shift = await findShift(req.params.id);
  if (!shift) return notFound(res, 'shift');
  if (!shift.employee_id) {
    req.flash('error', 'Nobody is on this shift.');
    return res.redirect(`/schedule/${shift.id}/edit`);
  }
  const reason = String(req.body.reason || '').trim().slice(0, 200) || null;
  const result = await openShifts.callOut(shift.id, {
    employeeId: shift.employee_id, reason, userId: req.user.id, byOffice: true, settings: res.locals.settings,
  });
  if (result.error) {
    req.flash('error', result.error);
    return res.redirect(`/schedule/${shift.id}/edit`);
  }
  await logActivity(req, `Noted a call-out by ${employeeName(shift)} for shift #${shift.id} (${shift.start_at.slice(0, 10)})`);
  flashOffer(req, result, `${employeeName(shift)} is off the shift.`);
  res.redirect(`/schedule/${shift.id}/edit`);
});

router.post('/:id/offer', async (req, res) => {
  const shift = await findShift(req.params.id);
  if (!shift) return notFound(res, 'shift');
  const result = await openShifts.offerShift(shift.id, { userId: req.user.id, settings: res.locals.settings });
  if (result.error) {
    req.flash('error', result.error);
    return res.redirect(`/schedule/${shift.id}/edit`);
  }
  if (!result.already) await logActivity(req, `Offered shift #${shift.id} (${shift.start_at.slice(0, 10)}) to officers`);
  flashOffer(req, { ...result, asked: result.already ? 0 : result.toldNow + result.toldLater }, '');
  res.redirect(`/schedule/${shift.id}/edit`);
});

router.post('/:id/withdraw-offer', async (req, res) => {
  const shift = await findShift(req.params.id);
  if (!shift) return notFound(res, 'shift');
  await openShifts.withdrawOffer(shift.id, 'Withdrawn by the office');
  await logActivity(req, `Withdrew the offer of shift #${shift.id}`);
  req.flash('success', "Offer withdrawn. Officers can't claim this shift any more.");
  res.redirect(`/schedule/${shift.id}/edit`);
});

function flashOffer(req, result, start) {
  if (result.already) req.flash('success', `${start} It was already offered to officers.`.trim());
  else if (result.asked) {
    const later = result.toldLater ? ` (${result.toldNow} regulars now, ${result.toldLater} more in 10 minutes)` : '';
    req.flash('success', `${start} Offered to ${result.asked} officer${result.asked === 1 ? '' : 's'}${later}. The first to claim it gets it; you'll be told if nobody does.`.trim());
  } else req.flash('warning', `${start} Nobody else is free, rested and qualified for it. Use "Find cover" to see who's closest.`.trim());
}

router.post('/:id/delete', async (req, res) => {
  const shift = await findShift(req.params.id);
  if (!shift) return notFound(res, 'shift');
  const recorded = await hoursFromShift(db, shift.id);
  if (recorded?.pay_run_status === 'finalized') {
    req.flash('error', 'The hours from this shift have already been paid, so it can no longer be deleted.');
    return res.redirect(`/schedule/${shift.id}/edit`);
  }
  await db.transaction(async (tx) => {
    if (recorded) await tx.run('DELETE FROM time_entries WHERE id = ?', recorded.id); // its hours go with it
    await tx.run('DELETE FROM shifts WHERE id = ?', shift.id);
  });
  await tellAboutShiftChange(shift, null);
  await logActivity(req, `Deleted shift #${shift.id} (${shift.site_name}, ${shift.start_at.slice(0, 10)})`);
  req.flash('success', recorded ? 'Shift deleted, with the hours recorded from it.' : 'Shift deleted.');
  res.redirect(`/schedule?week=${time.startOfWeek(shift.start_at.slice(0, 10))}`);
});

module.exports = router;
