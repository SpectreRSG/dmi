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
const openShifts = require('../services/openShifts');
const notify = require('../services/notify');
const availability = require('../services/availability');
const shiftRequests = require('../services/shiftRequests');
const { sendUpload } = require('../uploads');

const router = express.Router();
numericIdParam(router);

router.use((req, res, next) => {
  if (req.user.role === 'officer' || req.user.role === 'client') return next();
  if (req.method === 'GET') return res.redirect(homeFor(req.user));
  res.status(403).render('error', { title: 'Not allowed', message: 'These pages are for officers and clients.' });
});

// Setting the app up on a phone: on the Home Screen, with notifications on.
// Officers do this before anything else (see requireNotifications in auth.js).
router.get('/setup', async (req, res) => {
  const done = Boolean(req.user.push_devices || req.user.push_exempt);
  res.render('my/setup', { title: 'Set up the app', pushKey: await notify.publicKey(), firstTime: req.user.role === 'officer' && !done });
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
            e.first_name, e.last_name,
            EXISTS (SELECT 1 FROM shift_offers o WHERE o.shift_id = s.id AND o.status = 'open') AS offered
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
  // Officers: open shifts offered to them, and what they said about their availability.
  // Clients: shifts they've asked for that the office hasn't approved yet.
  const offered = isOfficer ? (await openShifts.openShiftsFor(scopeId)).filter((o) => o.start_at >= range[0] && o.start_at < range[1]) : [];
  const said = isOfficer
    ? (await availability.entriesFor([scopeId], gridStart, gridEnd)).flatMap((entry) =>
        availability.windowsOf(entry, gridStart, gridEnd).map((w) => ({ ...w, entry })))
    : [];
  // Requests waiting for approval: each of their dates in this month.
  const requested = isOfficer
    ? []
    : (await db.all(
        `SELECT r.*, si.name AS site_name FROM shift_requests r JOIN sites si ON si.id = r.site_id
         WHERE r.client_id = ? AND r.status = 'pending' AND r.start_at < ? AND r.last_end_at > ? ORDER BY r.start_at`,
        scopeId,
        range[1],
        range[0]
      )).flatMap((r) => shiftRequests.timesFor(r).filter((t) => t.start_at >= range[0] && t.start_at < range[1]).map((t) => ({ ...r, ...t })));

  const items = [
    ...shifts.map((s) => ({
      kind: 'shift',
      id: s.id,
      canCallOut: isOfficer && s.status === 'scheduled' && s.start_at > time.nowStr(),
      start_at: s.start_at,
      end_at: s.end_at,
      status: s.status,
      site: s.site_name,
      client: s.client_name,
      address: s.site_address,
      instructions: s.site_instructions,
      notes: s.notes,
      guard: shortName(s),
      offered: s.offered,
      hours: entryHours(s),
    })),
    ...training.map((t) => ({
      kind: 'training',
      start_at: t.starts_at,
      end_at: endOf(t.starts_at, t.duration_minutes),
      course: t.course_name,
      location: t.location,
    })),
    ...offered.map((o) => ({ kind: 'open', offerId: o.offer_id, start_at: o.start_at, end_at: o.end_at, site: o.site_name, client: o.client_name })),
    ...said.map((w) => ({ kind: w.entry.kind, start_at: w.start_at, end_at: w.end_at, note: w.entry.note, allDay: !w.entry.start_time })),
    ...requested.map((r) => ({ kind: 'request', start_at: r.start_at, end_at: r.end_at, site: r.site_name, count: r.officers_needed })),
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
  const offers = isOfficer ? await openShifts.openShiftsFor(scopeId) : [];

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
    openShifts: offers,
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

// ---- Can't make a shift / open shifts (officers) --------------------------------------
// "I can't make it" takes them off the shift and offers it to the officers who
// could take it; the first to claim it gets it. The office only hears about it
// (and only has to act) if nobody does.

async function myUpcomingShift(req, res, next) {
  const shift = await openShifts.findShift(req.params.id);
  if (!shift || shift.employee_id !== req.me.id) return notFound(res, 'shift');
  if (shift.status !== 'scheduled' || shift.start_at <= time.nowStr()) {
    req.flash('error', "This shift has already started or changed. If you can't work it, please call the office.");
    return res.redirect('/my/schedule');
  }
  req.shift = shift;
  next();
}

router.get('/shifts/:id/call-out', officerOnly, myUpcomingShift, (req, res) => {
  res.render('my/call-out', { title: "Can't make a shift", shift: req.shift, hoursNotice: time.hoursBetween(time.nowStr(), req.shift.start_at) });
});

router.post('/shifts/:id/call-out', officerOnly, myUpcomingShift, async (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 200) || null;
  const result = await openShifts.callOut(req.shift.id, {
    employeeId: req.me.id, reason, userId: req.user.id, settings: res.locals.settings,
  });
  if (result.error) {
    req.flash('error', result.error);
    return res.redirect('/my/schedule');
  }
  await logActivity(req, `${employeeName(req.me)} called out of shift #${req.shift.id} (${req.shift.start_at.slice(0, 10)})${reason ? `: ${reason}` : ''}`);
  req.flash('success', "Thanks for letting us know. You're off that shift, and the office has been told." +
    (result.asked ? ' Other officers are being offered it.' : ''));
  res.redirect(`/my/schedule?month=${req.shift.start_at.slice(0, 7)}`);
});

router.get('/open-shifts/:id', officerOnly, async (req, res) => {
  const offer = await db.get('SELECT * FROM shift_offers WHERE id = ?', req.params.id);
  const offered = offer && (await db.get(
    'SELECT 1 FROM shift_offer_recipients WHERE offer_id = ? AND employee_id = ? AND notified_at IS NOT NULL', offer.id, req.me.id
  ));
  if (!offered) return notFound(res, 'open shift');
  const shift = await db.get(
    `SELECT s.*, si.name AS site_name, si.address AS site_address, si.instructions AS site_instructions, c.name AS client_name
     FROM shifts s JOIN sites si ON si.id = s.site_id JOIN clients c ON c.id = si.client_id WHERE s.id = ?`,
    offer.shift_id
  );
  const open = offer.status === 'open' && !shift.employee_id && shift.status === 'scheduled' && shift.start_at > time.nowStr();
  res.render('my/open-shift', { title: 'Open shift', offer, shift, open, mine: offer.filled_by === req.me.id, hours: round2(entryHours(shift)) });
});

router.post('/open-shifts/:id/claim', officerOnly, async (req, res) => {
  const result = await openShifts.claimShift(Number(req.params.id), req.me.id, res.locals.settings);
  if (result.error) {
    req.flash('error', result.error);
    return res.redirect(`/my/open-shifts/${req.params.id}`);
  }
  await logActivity(req, `${employeeName(req.me)} claimed open shift #${result.shift.id} (${result.shift.start_at.slice(0, 10)})`);
  req.flash('success', `It's yours: ${time.fmtDay(result.shift.start_at)}, ${time.fmtRange(result.shift.start_at, result.shift.end_at)} at ${result.shift.site_name}. It's on your schedule now.`);
  res.redirect(`/my/schedule?month=${result.shift.start_at.slice(0, 7)}`);
});

// ---- Shift requests (site representatives, i.e. client accounts) -------------------
// They ask for shifts at their sites; the office approves them, and officers
// (the ones they asked for first) are offered them.

function clientOnly(req, res, next) {
  if (req.user.role === 'client' && req.user.client_id) return next();
  res.status(403).render('error', { title: 'Not allowed', message: 'Shift requests are for site representatives.' });
}

const REQUEST_SELECT = `SELECT r.*, si.name AS site_name, u.name AS requested_by_name FROM shift_requests r
  JOIN sites si ON si.id = r.site_id LEFT JOIN users u ON u.id = r.requested_by`;
const HISTORY_PAGE = 25;

// Two tabs. Current: requests with shifts still to come (and ones turned down
// in the last week, so the news stays in view). History: every request the
// client has sent, newest first.
router.get('/requests', clientOnly, async (req, res) => {
  const view = req.query.view === 'history' ? 'history' : 'current';
  const page = Math.max(1, Math.min(1000, Number.parseInt(req.query.page, 10) || 1));
  const requests = view === 'current'
    ? await db.all(
      `${REQUEST_SELECT} WHERE r.client_id = ? AND r.last_end_at > ?
         AND (r.status IN ('pending', 'approved') OR (r.status = 'declined' AND r.decided_at > ?))
       ORDER BY (r.status = 'pending') DESC, r.start_at LIMIT 100`,
      req.user.client_id, time.nowStr(), `${time.addDays(time.todayStr(), -7)} 00:00:00`
    )
    : await db.all(
      `${REQUEST_SELECT} WHERE r.client_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
      req.user.client_id, HISTORY_PAGE + 1, (page - 1) * HISTORY_PAGE
    );
  const more = view === 'history' && requests.length > HISTORY_PAGE;
  res.render('my/requests', {
    title: 'Shift requests',
    view,
    page,
    more,
    now: time.nowStr(),
    requests: await shiftRequests.withDetails(view === 'history' ? requests.slice(0, HISTORY_PAGE) : requests),
    STATUS_LABELS: shiftRequests.STATUS_LABELS,
  });
});

async function renderRequestForm(req, res, values, error, status = 200) {
  const [sites, officers] = await Promise.all([shiftRequests.clientSites(req.user.client_id), shiftRequests.knownOfficers(req.user.client_id)]);
  res.status(status).render('my/request-form', {
    title: 'Request a shift',
    values,
    error,
    sites,
    officers: officers.map((e) => ({ id: e.id, name: `${e.first_name} ${e.last_name.charAt(0)}.` })),
    maxOfficers: shiftRequests.MAX_OFFICERS,
    WEEKDAYS: shiftRequests.WEEKDAYS,
  });
}

router.get('/requests/new', clientOnly, (req, res) =>
  renderRequestForm(req, res, {
    date: time.addDays(time.todayStr(), 1), start_time: '08:00', end_time: '16:00', break_minutes: 0, officers_needed: 1, officers: [], repeat_days: [],
  }, null));

router.post('/requests', clientOnly, async (req, res) => {
  const { values, error } = await shiftRequests.readForm(req.body, req.user.client_id);
  if (error) return renderRequestForm(req, res, values, error, 400);
  const request = await shiftRequests.create(req.user.client_id, req.user.id, values);
  const dates = values.dates.length;
  await logActivity(req, `Requested ${values.officers_needed} officer(s) at ${request.site_name}: ${shiftRequests.when(request)}`);
  req.flash('success', `Request sent${dates > 1 ? ` for ${dates} dates` : ''}. The office will approve it, then it's offered to officers` +
    (values.officers.length ? ' (the ones you asked for first)' : '') + ". You'll get a notification at each step.");
  res.redirect('/my/requests');
});

// One request in full: each date, and who's covering it.
router.get('/requests/:id', clientOnly, async (req, res) => {
  const row = await db.get(`${REQUEST_SELECT} WHERE r.id = ? AND r.client_id = ?`, Number(req.params.id), req.user.client_id);
  if (!row) return res.status(404).render('error', { title: 'Not found', message: "That request doesn't exist, or it's for another client." });
  const [request] = await shiftRequests.withDetails([row]);
  const decider = request.decided_by ? await db.get('SELECT name FROM users WHERE id = ?', request.decided_by) : null;
  const now = time.nowStr();
  let rows;
  if (request.status === 'approved') {
    // Each shift made, and how it stands.
    const offers = await db.all(
      `SELECT DISTINCT ON (o.shift_id) o.shift_id, o.status, o.closed_note FROM shift_offers o
       WHERE o.shift_id = ANY(?::int[]) ORDER BY o.shift_id, o.id DESC`,
      request.shifts.map((sh) => sh.id)
    );
    const latest = new Map(offers.map((o) => [o.shift_id, o]));
    rows = request.shifts
      .slice()
      .sort((a, b) => (a.start_at < b.start_at ? -1 : a.start_at > b.start_at ? 1 : a.id - b.id))
      .map((sh) => {
        const offer = latest.get(sh.id);
        const status = sh.status === 'cancelled' ? 'cancelled'
          : sh.employee_id ? (sh.end_at <= now ? 'worked' : 'covered')
            : sh.start_at <= now ? 'missed'
              : offer?.status === 'open' ? 'offered'
                : offer ? 'finding' : 'later';
        return { start_at: sh.start_at, end_at: sh.end_at, name: sh.name, status };
      });
  } else {
    rows = shiftRequests.timesFor(request).map((t) => ({ ...t, status: request.status }));
  }
  res.render('my/request', { title: 'Shift request', request, rows, decidedBy: decider?.name, now, STATUS_LABELS: shiftRequests.STATUS_LABELS });
});

router.post('/requests/:id/cancel', clientOnly, async (req, res) => {
  const result = await shiftRequests.cancel(Number(req.params.id), req.user.client_id);
  if (result.error) req.flash('error', result.error);
  else {
    await logActivity(req, `Cancelled shift request #${req.params.id}`);
    req.flash('success', 'Request cancelled.');
  }
  res.redirect('/my/requests');
});

// ---- My availability (officers) ---------------------------------------------------
// Times they can't work, or would like extra shifts. The office sees it, the
// conflict checker warns about it, and open shifts are offered accordingly.

async function renderAvailability(req, res, values, error, status = 200) {
  const entries = await db.all(
    `SELECT * FROM availability WHERE employee_id = ? AND COALESCE(end_date, '9999-12-31') >= ? ORDER BY start_date, id`,
    req.me.id,
    time.todayStr()
  );
  for (const entry of entries) entry.label = availability.describe(entry);
  res.status(status).render('my/availability', {
    title: 'My availability',
    entries,
    values,
    error,
    KINDS: availability.KINDS,
    WEEKDAYS: availability.WEEKDAYS,
  });
}

router.get('/availability', officerOnly, (req, res) =>
  renderAvailability(req, res, { kind: 'unavailable', repeat: 'once', start_date: time.todayStr(), all_day: true }, null));

router.post('/availability', officerOnly, async (req, res) => {
  const { values, error } = availability.readForm(req.body);
  if (error) return renderAvailability(req, res, { ...values, all_day: Boolean(req.body.all_day) }, error, 400);
  const id = await db.insert(
    `INSERT INTO availability (employee_id, kind, start_date, end_date, weekdays, start_time, end_time, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    req.me.id, values.kind, values.start_date, values.end_date, values.weekdays, values.start_time, values.end_time, values.note
  );
  const entry = await db.get('SELECT * FROM availability WHERE id = ?', id);
  await logActivity(req, `${employeeName(req.me)} added availability: ${availability.KINDS[entry.kind]}, ${availability.describe(entry)}`);

  // Already booked during time they can't work? Tell them what to do, and tell the office.
  if (entry.kind === 'unavailable') {
    const until = entry.end_date || time.addDays(time.todayStr(), 180);
    const windows = availability.windowsOf(entry, entry.start_date, until);
    const booked = (await db.all(
      `SELECT s.*, si.name AS site_name FROM shifts s JOIN sites si ON si.id = s.site_id
       WHERE s.employee_id = ? AND s.status = 'scheduled' AND s.start_at > ? AND s.start_at < ? ORDER BY s.start_at`,
      req.me.id, time.nowStr(), `${time.addDays(until, 1)}T23:59`
    )).filter((shift) => windows.some((w) => w.start_at < shift.end_at && w.end_at > shift.start_at));
    if (booked.length) {
      const first = `${time.fmtDay(booked[0].start_at)} ${time.fmtRange(booked[0].start_at, booked[0].end_at)} at ${booked[0].site_name}`;
      req.flash('warning', `You're already booked then (${first}${booked.length > 1 ? ` and ${booked.length - 1} more` : ''}). Saving this doesn't take you off: press "I can't make it" on the shift, or call the office.`);
      await notify.notifyOffice({
        title: `${req.me.first_name} ${req.me.last_name.charAt(0)}. says they can't work, but is booked`,
        body: `${first}${booked.length > 1 ? ` (and ${booked.length - 1} more)` : ''}. Check the conflict checker.`,
        url: `/schedule/${booked[0].id}/edit`,
      });
    }
  }
  req.flash('success', 'Saved. The office can see it, and open shifts are offered to you accordingly.');
  res.redirect('/my/availability');
});

router.post('/availability/:id/delete', officerOnly, async (req, res) => {
  const entry = await db.get('SELECT * FROM availability WHERE id = ? AND employee_id = ?', req.params.id, req.me.id);
  if (!entry) return notFound(res, 'availability');
  await db.run('DELETE FROM availability WHERE id = ?', entry.id);
  await logActivity(req, `${employeeName(req.me)} removed availability: ${availability.KINDS[entry.kind]}, ${availability.describe(entry)}`);
  req.flash('success', 'Removed.');
  res.redirect('/my/availability');
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

async function renderDetails(res, values, error, status = 200) {
  res.status(status).render('my/details', { title: 'My details', values, error, pushKey: await notify.publicKey() });
}

router.get('/details', officerOnly, (req, res) => renderDetails(res, req.me, null));

router.post('/details', officerOnly, async (req, res) => {
  const { values, error } = readDetails(req.body);
  if (error) return renderDetails(res, values, error, 400);
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
