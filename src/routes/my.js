// "My" pages for officers and clients: their monthly schedule, and (officers)
// their pay, contact details and tax forms. They never see other people's pay,
// phone numbers or anything else from the back office.
const express = require('express');
const db = require('../db');
const { clean, notFound, numericIdParam, logActivity, employeeName } = require('../helpers');
const time = require('../time');
const { homeFor } = require('../auth');
const { entryHours, round2, calculatePayLine } = require('../services/payroll');
const { recordFinishedShifts } = require('../services/hoursFromSchedule');
const { findPayLine, payLineTimesheet, timesheetFileName } = require('../services/payTimesheet');
const { sendUpload } = require('../uploads');

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

// What an officer still needs to do once, after their account is set up.
// After that, there's nothing to fill in: hours come from the schedule.
async function setupSteps(employeeId) {
  const me = await db.get('SELECT * FROM employees WHERE id = ?', employeeId);
  const steps = [];
  if (!me.phone) steps.push({ label: 'Add your phone number', href: '/my/details' });
  if (!me.emergency_contact_name || !me.emergency_contact_phone) steps.push({ label: 'Add an emergency contact', href: '/my/details' });
  if (me.tax_form === '1099' && !(await db.get('SELECT 1 FROM tax_profiles WHERE employee_id = ?', employeeId))) {
    steps.push({ label: 'Fill in your W-9 (for your 1099)', href: '/my/tax/w9' });
  }
  return steps;
}

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
  const setup = isOfficer ? await setupSteps(scopeId) : [];

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
    setup,
    totals: {
      shifts: live.length,
      hours: round2(live.reduce((sum, i) => sum + i.hours, 0)),
      unfilled: live.filter((i) => !i.guard).length,
    },
  });
});

// ---- My pay (officers) ------------------------------------------------------------
// Hours come from the schedule by themselves, so officers don't fill in
// timesheets: they just see what's been recorded and what they were paid.

router.get('/pay', officerOnly, async (req, res) => {
  await recordFinishedShifts();
  const [recorded, paid, sent, taxProfile, taxForms] = await Promise.all([
    // Hours not paid yet (not in a finalized pay run).
    db.all(
      `SELECT t.*, si.name AS site_name FROM time_entries t
       LEFT JOIN sites si ON si.id = t.site_id LEFT JOIN pay_runs p ON p.id = t.pay_run_id
       WHERE t.employee_id = ? AND t.status != 'rejected' AND (p.id IS NULL OR p.status != 'finalized')
       ORDER BY t.start_at DESC LIMIT 200`,
      req.me.id
    ),
    db.all(
      `SELECT i.*, p.period_start, p.period_end, p.paid_on FROM pay_run_items i JOIN pay_runs p ON p.id = i.pay_run_id
       WHERE i.employee_id = ? AND p.status = 'finalized' ORDER BY p.period_end DESC LIMIT 52`,
      req.me.id
    ),
    // Timesheets they sent in themselves, before hours came from the schedule.
    db.all(
      `SELECT s.*, u.name AS approver_name FROM timesheet_submissions s LEFT JOIN users u ON u.id = s.approved_by
       WHERE s.employee_id = ? AND s.status = 'submitted' ORDER BY s.period_start DESC LIMIT 52`,
      req.me.id
    ),
    db.get('SELECT 1 FROM tax_profiles WHERE employee_id = ?', req.me.id),
    db.get("SELECT COUNT(*)::int AS n FROM tax_forms WHERE employee_id = ? AND status = 'issued' AND released = 1", req.me.id),
  ]);
  for (const entry of recorded) entry.hours = round2(entryHours(entry));
  const approved = recorded.filter((e) => e.status === 'approved');
  const { settings } = res.locals;
  const estimate = calculatePayLine({
    entries: approved,
    hourlyRate: req.me.hourly_rate,
    weeklyLimit: settings.overtime_weekly_hours,
    multiplier: settings.overtime_multiplier,
  });
  res.render('my/pay', {
    title: 'My pay',
    recorded,
    recordedHours: round2(recorded.reduce((sum, e) => sum + e.hours, 0)),
    waiting: recorded.filter((e) => e.status === 'pending').length,
    estimate,
    paid,
    sent,
    needsW9: req.me.tax_form === '1099' && !taxProfile,
    taxFormsReady: taxForms.n,
  });
});

// One of their pay lines from a finalized pay run (never drafts, never anyone else's).
async function myPayLine(req, res, next) {
  const line = await findPayLine(req.params.id);
  if (!line || line.employee_id !== req.me.id || line.run_status !== 'finalized') return notFound(res, 'payslip');
  req.line = line;
  next();
}

router.get('/pay/:id', officerOnly, myPayLine, async (req, res) => {
  const run = await db.get('SELECT * FROM pay_runs WHERE id = ?', req.line.pay_run_id);
  const item = { ...req.line, position: req.me.position };
  const entries = await db.all(
    `SELECT t.*, si.name AS site_name FROM time_entries t LEFT JOIN sites si ON si.id = t.site_id
     WHERE t.pay_run_id = ? AND t.employee_id = ? ORDER BY t.start_at`,
    run.id,
    req.me.id
  );
  for (const entry of entries) entry.hours = round2(entryHours(entry));
  res.render('pay/payslip', { title: 'Payslip', run, item, entries, back: '/my/pay', timesheetHref: `/my/pay/${item.id}/timesheet.pdf` });
});

// Their DMI timesheet for that pay period: opens in the browser; ?download=1 saves it.
router.get('/pay/:id/timesheet.pdf', officerOnly, myPayLine, async (req, res) => {
  const file = await payLineTimesheet(req.line);
  await sendUpload(res, file, timesheetFileName(req.line), { inline: !req.query.download });
});

// Old links to the timesheet pages now go to My pay.
router.get(['/timesheets', '/timesheets/new'], officerOnly, (req, res) => res.redirect('/my/pay'));

// A timesheet they sent before hours came from the schedule: the approved copy
// once the office approved it, otherwise the one they signed. It opens in the
// browser to look at; ?download=1 saves it instead.
router.get('/timesheets/:id/pdf', officerOnly, async (req, res) => {
  const submission = await db.get('SELECT * FROM timesheet_submissions WHERE id = ? AND employee_id = ?', req.params.id, req.me.id);
  if (!submission?.file_name) return notFound(res, 'timesheet');
  const approved = Boolean(submission.approved_file_name);
  await sendUpload(
    res,
    approved ? submission.approved_file_name : submission.file_name,
    `DMI_Timesheet_${submission.period_start}_to_${submission.period_end}${approved ? '_approved' : ''}.pdf`,
    { inline: !req.query.download }
  );
});

// ---- My details (officers) ---------------------------------------------------------
// Their phone, email, address and emergency contact: the office sees the
// changes straight away on their staff record.

const DETAIL_FIELDS = ['phone', 'email', 'address', 'emergency_contact_name', 'emergency_contact_phone'];
const DETAIL_LABELS = {
  phone: 'phone',
  email: 'email',
  address: 'address',
  emergency_contact_name: 'emergency contact',
  emergency_contact_phone: 'emergency contact phone',
};
const looksLikePhone = (value) => (value.match(/\d/g) || []).length >= 7;

function readDetails(body) {
  const values = clean(body, DETAIL_FIELDS);
  for (const field of DETAIL_FIELDS) if (values[field]) values[field] = values[field].slice(0, field === 'address' ? 200 : 100);
  let error = null;
  if (!values.phone || !looksLikePhone(values.phone)) error = 'Please enter your phone number, so the office can reach you about shifts.';
  else if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) error = 'That email address doesn\'t look right.';
  else if (values.emergency_contact_phone && !looksLikePhone(values.emergency_contact_phone)) error = 'Please check the emergency contact\'s phone number.';
  return { values, error };
}

router.get('/details', officerOnly, (req, res) => {
  res.render('my/details', { title: 'My details', values: req.me, error: null });
});

router.post('/details', officerOnly, async (req, res) => {
  const { values, error } = readDetails(req.body);
  if (error) return res.status(400).render('my/details', { title: 'My details', values, error });
  const changed = DETAIL_FIELDS.filter((f) => (values[f] || null) !== (req.me[f] || null));
  if (changed.length) {
    await db.transaction(async (tx) => {
      await tx.run(
        `UPDATE employees SET phone = @phone, email = @email, address = @address,
         emergency_contact_name = @emergency_contact_name, emergency_contact_phone = @emergency_contact_phone WHERE id = @id`,
        { ...values, id: req.me.id }
      );
      await tx.run('UPDATE users SET phone = ? WHERE id = ?', values.phone, req.user.id);
    });
    await logActivity(req, `${employeeName(req.me)} updated their ${changed.map((f) => DETAIL_LABELS[f]).join(', ')}`);
  }
  req.flash('success', changed.length ? 'Your details were saved. The office can see them now.' : 'Nothing had changed.');
  res.redirect('/my/details');
});

router.use('/tax', officerOnly, require('./myTax'));

module.exports = router;
