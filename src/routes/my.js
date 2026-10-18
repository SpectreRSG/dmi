// "My" pages for officers and clients: their monthly schedule, and (officers)
// timesheets and tax forms. They never see pay rates, other people's phone
// numbers or anything else from the back office.
const express = require('express');
const db = require('../db');
const { notFound, numericIdParam, logActivity, employeeName } = require('../helpers');
const time = require('../time');
const { homeFor } = require('../auth');
const { entryHours, round2 } = require('../services/payroll');
const sheets = require('../services/officerTimesheet');
const { saveUpload, sendUpload } = require('../uploads');

const router = express.Router();
numericIdParam(router);

router.use((req, res, next) => {
  if (req.user.role === 'officer' || req.user.role === 'client') return next();
  if (req.method === 'GET') return res.redirect(homeFor(req.user));
  res.status(403).render('error', { title: 'Not allowed', message: 'These pages are for officers and clients.' });
});

// Officers' pages need the account to be linked to their staff record.
async function officerOnly(req, res, next) {
  const me = req.user.role === 'officer' && req.user.employee_id
    ? await db.get('SELECT * FROM employees WHERE id = ?', req.user.employee_id)
    : null;
  if (!me) {
    return res.status(403).render('error', {
      title: 'Not set up yet',
      message: req.user.role === 'officer'
        ? "Your account isn't linked to your staff record yet. Please ask the office to finish setting it up."
        : 'These pages are for officers.',
    });
  }
  req.me = me;
  res.locals.me = me;
  next();
}

router.get('/', (req, res) => res.redirect('/my/schedule'));

// ---- Monthly calendar ---------------------------------------------------------

// Colleagues and clients see guards as "Jordan S." rather than full names.
const shortName = (s) => (s.employee_id ? `${s.first_name} ${s.last_name.charAt(0)}.` : null);
// 0 = Sunday … 6 = Saturday (US calendars start on Sunday).
const sundayIndex = (date) => (time.dayOfWeek(date) + 1) % 7;

function endOf(startAt, minutes) {
  return new Date(Date.parse(`${startAt}:00Z`) + minutes * 60000).toISOString().slice(0, 16);
}

router.get('/schedule', async (req, res) => {
  const today = time.todayStr();
  const month = time.isValidMonth(req.query.month) ? req.query.month : today.slice(0, 7);
  const { first, last } = time.monthRange(month);
  const gridStart = time.addDays(first, -sundayIndex(first));
  const gridEnd = time.addDays(last, 6 - sundayIndex(last));
  const range = [`${gridStart}T00:00`, `${time.addDays(gridEnd, 1)}T00:00`];
  const isOfficer = req.user.role === 'officer';
  const scopeId = isOfficer ? req.user.employee_id : req.user.client_id;
  if (!scopeId) {
    return res.render('my/not-linked', { title: 'Schedule' });
  }

  const shifts = await db.all(
    `SELECT s.id, s.employee_id, s.start_at, s.end_at, s.break_minutes, s.status, s.notes,
            si.name AS site_name, si.address AS site_address, si.instructions AS site_instructions, c.name AS client_name,
            e.first_name, e.last_name
     FROM shifts s
     JOIN sites si ON si.id = s.site_id
     JOIN clients c ON c.id = si.client_id
     LEFT JOIN employees e ON e.id = s.employee_id
     WHERE ${isOfficer ? 's.employee_id = ?' : 'si.client_id = ?'} AND s.start_at >= ? AND s.start_at < ?
     ORDER BY s.start_at, si.name, s.id`,
    scopeId,
    ...range
  );
  const training = isOfficer
    ? await db.all(
        `SELECT ts.starts_at, ts.duration_minutes, ts.location, c.name AS course_name
         FROM training_attendees ta
         JOIN training_sessions ts ON ts.id = ta.session_id
         JOIN training_courses c ON c.id = ts.course_id
         WHERE ta.employee_id = ? AND ts.status = 'scheduled' AND ts.starts_at >= ? AND ts.starts_at < ?
         ORDER BY ts.starts_at`,
        scopeId,
        ...range
      )
    : [];

  const items = [
    ...shifts.map((s) => ({
      kind: 'shift',
      start_at: s.start_at,
      end_at: s.end_at,
      status: s.status,
      site: s.site_name,
      client: s.client_name,
      address: s.site_address,
      instructions: s.site_instructions,
      notes: s.notes,
      guard: shortName(s),
      hours: entryHours(s),
    })),
    ...training.map((t) => ({
      kind: 'training',
      start_at: t.starts_at,
      end_at: endOf(t.starts_at, t.duration_minutes),
      course: t.course_name,
      location: t.location,
    })),
  ].sort((a, b) => a.start_at.localeCompare(b.start_at));

  // The calendar: whole weeks, Sunday to Saturday, covering the month.
  const weeks = [];
  for (let date = gridStart; date <= gridEnd; date = time.addDays(date, 1)) {
    if (sundayIndex(date) === 0) weeks.push([]);
    weeks.at(-1).push({ date, inMonth: date.startsWith(month), items: items.filter((i) => i.start_at.startsWith(date)) });
  }
  const monthItems = items.filter((i) => i.start_at.startsWith(month));
  const live = monthItems.filter((i) => i.kind === 'shift' && i.status !== 'cancelled');
  // The officer's next shift, even if it's in a later month.
  const nextShift = isOfficer
    ? await db.get(
        `SELECT s.start_at, s.end_at, si.name AS site, si.address, c.name AS client
         FROM shifts s JOIN sites si ON si.id = s.site_id JOIN clients c ON c.id = si.client_id
         WHERE s.employee_id = ? AND s.status = 'scheduled' AND s.end_at > ? ORDER BY s.start_at LIMIT 1`,
        scopeId,
        time.nowStr()
      )
    : null;
  const sites = isOfficer
    ? []
    : await db.all('SELECT name, address, instructions FROM sites WHERE client_id = ? AND active = 1 ORDER BY name', scopeId);
  const client = isOfficer ? null : await db.get('SELECT name FROM clients WHERE id = ?', scopeId);

  res.render('my/schedule', {
    title: isOfficer ? 'My schedule' : 'Schedule',
    isOfficer,
    heading: isOfficer ? req.user.name : client?.name,
    month,
    prevMonth: time.addMonths(first, -1).slice(0, 7),
    nextMonth: time.addMonths(first, 1).slice(0, 7),
    thisMonth: today.slice(0, 7),
    today,
    weeks,
    monthItems,
    next: nextShift,
    sites,
    totals: {
      shifts: live.length,
      hours: round2(live.reduce((sum, i) => sum + i.hours, 0)),
      unfilled: live.filter((i) => !i.guard).length,
    },
  });
});

// ---- Timesheets (officers) ------------------------------------------------------

async function submissionStatus(submissionId) {
  const rows = await db.all(
    `SELECT t.status, p.status AS pay_run_status, COUNT(*)::int AS n FROM time_entries t
     LEFT JOIN pay_runs p ON p.id = t.pay_run_id WHERE t.submission_id = ? GROUP BY t.status, p.status`,
    submissionId
  );
  const count = (status) => rows.filter((r) => r.status === status).reduce((sum, r) => sum + r.n, 0);
  return {
    pending: count('pending'),
    approved: count('approved'),
    rejected: count('rejected'),
    paid: rows.filter((r) => r.pay_run_status === 'finalized').reduce((sum, r) => sum + r.n, 0),
  };
}

function currentSubmission(employeeId, periodStart) {
  return db.get(
    "SELECT * FROM timesheet_submissions WHERE employee_id = ? AND period_start = ? AND status = 'submitted' ORDER BY id DESC LIMIT 1",
    employeeId,
    periodStart
  );
}

router.get('/timesheets', officerOnly, async (req, res) => {
  const submissions = await db.all(
    "SELECT * FROM timesheet_submissions WHERE employee_id = ? AND status = 'submitted' ORDER BY period_start DESC LIMIT 52",
    req.me.id
  );
  for (const s of submissions) s.counts = await submissionStatus(s.id);
  const current = sheets.periodStartFor(time.todayStr());
  res.render('my/timesheets', {
    title: 'Timesheets',
    submissions,
    currentPeriod: current,
    previousPeriod: time.addDays(current, -sheets.PERIOD_DAYS),
  });
});

// "Last, First" like the paper form.
const sheetName = (e) => `${e.last_name}, ${e.first_name}`;

async function renderSheet(req, res, start, values, error, status = 200) {
  const existing = await currentSubmission(req.me.id, start);
  const counts = existing ? await submissionStatus(existing.id) : null;
  res.status(status).render('my/timesheet-form', {
    title: `Timesheet ${sheets.periodLabel(start)}`,
    start,
    end: sheets.periodEnd(start),
    prev: time.addDays(start, -sheets.PERIOD_DAYS),
    next: time.addDays(start, sheets.PERIOD_DAYS),
    current: sheets.periodStartFor(time.todayStr()),
    values,
    error,
    existing,
    locked: Boolean(counts && (counts.approved || counts.rejected)),
    short: sheets.short,
  });
}

router.get('/timesheets/new', officerOnly, async (req, res) => {
  const start = sheets.periodStartFor(time.isValidDate(req.query.period) ? req.query.period : time.todayStr());
  const end = sheets.periodEnd(start);
  const existing = await currentSubmission(req.me.id, start);
  const last = await db.get('SELECT location, phone FROM timesheet_submissions WHERE employee_id = ? ORDER BY id DESC LIMIT 1', req.me.id);
  const values = {
    name: sheetName(req.me),
    phone: existing?.phone || last?.phone || req.user.phone || req.me.phone || '',
    location: existing?.location || last?.location || '',
    rows: {},
  };
  const toRow = (startAt, endAt, comment) => ({
    in: time.fmtTime(startAt).replace(':', ''),
    out: time.fmtTime(endAt).replace(':', ''),
    comment: comment || '',
  });
  if (req.query.fill === 'schedule') {
    // Start from the shifts on the schedule so far (the officer then fixes any times that were different).
    const planned = await db.all(
      `SELECT s.start_at, s.end_at, si.name AS site_name FROM shifts s JOIN sites si ON si.id = s.site_id
       WHERE s.employee_id = ? AND s.status != 'cancelled' AND s.start_at >= ? AND s.start_at < ? AND s.start_at <= ?
       AND NOT EXISTS (SELECT 1 FROM time_entries t WHERE t.shift_id = s.id AND t.submission_id IS NULL)
       ORDER BY s.start_at`,
      req.me.id,
      `${start}T00:00`,
      `${time.addDays(end, 1)}T00:00`,
      time.nowStr() // only shifts that have started, not ones still to come
    );
    for (const s of planned) values.rows[s.start_at.slice(0, 10)] ??= toRow(s.start_at, s.end_at, s.site_name);
    if (!values.location && planned.length) values.location = planned[0].site_name;
  } else if (existing) {
    const entries = await db.all('SELECT start_at, end_at, notes FROM time_entries WHERE submission_id = ? ORDER BY start_at', existing.id);
    for (const e of entries) values.rows[e.start_at.slice(0, 10)] = toRow(e.start_at, e.end_at, e.notes);
  }
  await renderSheet(req, res, start, values, null);
});

router.post('/timesheets', officerOnly, async (req, res) => {
  const start = sheets.periodStartFor(time.isValidDate(req.body.period) ? req.body.period : time.todayStr());
  const { rows, worked, error: rowError } = sheets.readRows(req.body, start);
  const values = {
    name: sheetName(req.me),
    phone: String(req.body.phone || '').trim().slice(0, 40),
    location: String(req.body.location || '').trim().slice(0, 80),
    rows: Object.fromEntries(rows.map((r) => [r.date, { in: r.clock_in, out: r.clock_out, comment: r.comment }])),
  };
  const fail = (message) => renderSheet(req, res, start, values, message, 400);
  if (rowError) return fail(rowError);
  const future = worked.find((r) => r.date > time.todayStr());
  if (future) return fail(`${sheets.short(future.date)} hasn't happened yet. Only send hours you've already worked.`);
  const signature = sheets.readSignature(req.body.signature);
  if (!signature) return fail('Please sign in the signature box.');
  if (!req.body.confirm) return fail('Please tick the box to confirm these hours are correct.');

  const previous = await currentSubmission(req.me.id, start);
  if (previous) {
    const counts = await submissionStatus(previous.id);
    if (counts.approved || counts.rejected) {
      return fail('The office has already checked this timesheet, so it can no longer be changed here. Please contact the office.');
    }
  }
  // The same hours can't be claimed twice (within this sheet, or against other entries).
  for (let i = 1; i < worked.length; i += 1) {
    if (worked[i].start_at < worked[i - 1].end_at) {
      return fail(`The hours on ${sheets.short(worked[i - 1].date)} and ${sheets.short(worked[i].date)} overlap.`);
    }
  }
  for (const row of worked) {
    const overlap = await db.get(
      `SELECT start_at, end_at FROM time_entries WHERE employee_id = ? AND status != 'rejected'
       AND (submission_id IS NULL OR submission_id != ?) AND start_at < ? AND end_at > ? LIMIT 1`,
      req.me.id,
      previous?.id || 0,
      row.end_at,
      row.start_at
    );
    if (overlap) {
      return fail(`The hours on ${sheets.short(row.date)} overlap hours already recorded for you (${time.fmtDay(overlap.start_at)} ${time.fmtRange(overlap.start_at, overlap.end_at)}). The office may have entered them already.`);
    }
  }

  const pdf = await sheets.buildTimesheetPdf({ ...values, start, worked, signature });
  const stored = await saveUpload({ originalname: 'timesheet.pdf', buffer: pdf, size: pdf.length });
  const totalHours = round2(worked.reduce((sum, r) => sum + r.hours, 0));

  await db.transaction(async (tx) => {
    if (previous) {
      await tx.run("DELETE FROM time_entries WHERE submission_id = ? AND status = 'pending'", previous.id);
      await tx.run("UPDATE timesheet_submissions SET status = 'replaced' WHERE id = ?", previous.id);
    }
    const submissionId = await tx.insert(
      `INSERT INTO timesheet_submissions (employee_id, user_id, period_start, period_end, location, phone, total_hours, file_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      req.me.id, req.user.id, start, sheets.periodEnd(start), values.location, values.phone, totalHours, stored.file_name
    );
    for (const row of worked) {
      // Link the hours to the matching shift on the schedule, if there is one.
      const shift = await tx.get(
        `SELECT s.id, s.site_id FROM shifts s WHERE s.employee_id = ? AND s.status != 'cancelled'
         AND s.start_at < ? AND s.end_at > ? AND NOT EXISTS (SELECT 1 FROM time_entries t WHERE t.shift_id = s.id)
         ORDER BY s.start_at LIMIT 1`,
        req.me.id, row.end_at, row.start_at
      );
      await tx.run(
        `INSERT INTO time_entries (employee_id, site_id, shift_id, start_at, end_at, notes, submission_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        req.me.id, shift?.site_id ?? null, shift?.id ?? null, row.start_at, row.end_at, row.comment || null, submissionId
      );
      if (shift) await tx.run("UPDATE shifts SET status = 'completed' WHERE id = ?", shift.id);
    }
  });
  await logActivity(req, `${employeeName(req.me)} sent a timesheet for ${sheets.periodLabel(start)} (${totalHours} h)${previous ? ', replacing an earlier one' : ''}`);
  req.flash('success', `Timesheet sent: ${worked.length} day(s), ${sheets.fmtHours(totalHours)} hours. The office will check it.`);
  res.redirect('/my/timesheets');
});

router.get('/timesheets/:id/pdf', officerOnly, async (req, res) => {
  const submission = await db.get('SELECT * FROM timesheet_submissions WHERE id = ? AND employee_id = ?', req.params.id, req.me.id);
  if (!submission?.file_name) return notFound(res, 'timesheet');
  await sendUpload(res, submission.file_name, `DMI_Timesheet_${submission.period_start}_to_${submission.period_end}.pdf`);
});

router.use('/tax', officerOnly, require('./myTax'));

module.exports = router;
