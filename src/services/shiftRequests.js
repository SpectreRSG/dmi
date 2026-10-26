// Shift requests from site representatives (client accounts). They ask for a
// shift at one of their sites, and can name officers they'd like. A request
// can repeat: every ticked weekday from the first date up to a last date. The
// office approves it (or declines, with a reason). Approved: the shifts go on
// the schedule as open shifts and are offered to officers, the named ones
// first: a one-off request's straight away, a repeating one's about two weeks
// ahead, as their dates come up. The site hears when it's approved and when
// each shift is covered.
const db = require('../db');
const time = require('../time');
const { clean, toId, toNumber, asArray } = require('../helpers');
const openShifts = require('./openShifts');
const { WEEKDAYS } = require('./availability');
const { notifyOffice, notifyClient } = require('./notify');

const MAX_OFFICERS = 10;
const MAX_REPEAT_DAYS = 92; // a repeating request covers up to about 3 months
const MAX_SHIFTS = 200; // dates × officers, in one request
const OFFER_AHEAD_DAYS = 14; // a repeating request's shifts are offered to officers this far ahead
const STATUS_LABELS = { pending: 'Waiting for approval', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled' };

const shortName = (e) => `${e.first_name} ${e.last_name.charAt(0)}.`;
const repeatDaysOf = (r) => (r.repeat_days ? r.repeat_days.split(',').map(Number) : []);

// Every date from `first` to `last` that falls on one of these weekdays (0 = Monday).
function matchingDates(first, last, weekdays) {
  const dates = [];
  for (let d = first; d <= last; d = time.addDays(d, 1)) {
    if (weekdays.includes(time.dayOfWeek(d))) dates.push(d);
  }
  return dates;
}

// The dates a request covers: one, or each ticked weekday up to the last date.
function datesFor(r) {
  const days = repeatDaysOf(r);
  return days.length && r.repeat_until ? matchingDates(r.start_at.slice(0, 10), r.repeat_until, days) : [r.start_at.slice(0, 10)];
}

// The times of each of its shifts: [{ start_at, end_at }].
function timesFor(r) {
  return datesFor(r).map((date) => time.buildRange(date, r.start_at.slice(11, 16), r.end_at.slice(11, 16)));
}

// When its last shift starts. After that there's nothing left to approve
// (it can only be declined), so it no longer counts as waiting.
function lastStartOf(r) {
  return timesFor(r).at(-1).start_at;
}

// Requests waiting for approval that still have a shift to come.
async function pendingCount(now = time.nowStr()) {
  return (await db.get(
    `SELECT COUNT(*)::int AS n FROM shift_requests
     WHERE status = 'pending' AND last_end_at::timestamp - (end_at::timestamp - start_at::timestamp) > ?::timestamp`,
    now
  )).n;
}

// "Mon 2 Nov, 18:00–06:00 (+1)", or for a repeating request
// "Every Mon, Wed, Fri, 18:00–06:00 (+1), Mon 2 Nov – 30 Nov 2026 (13 dates)".
function when(r) {
  const hours = time.fmtRange(r.start_at, r.end_at);
  const dates = datesFor(r);
  if (dates.length === 1) return `${time.fmtDay(r.start_at)}, ${hours}`;
  const days = repeatDaysOf(r).map((d) => WEEKDAYS[d]).join(', ');
  return `Every ${days}, ${hours}, ${time.fmtDay(dates[0])} – ${time.fmtDate(dates.at(-1))} (${dates.length} dates)`;
}

// Officers a site can ask for by name: the ones who worked at any of the
// client's sites in the last six months (shown as "Jordan S.").
function knownOfficers(clientId) {
  return db.all(
    `SELECT DISTINCT e.id, e.first_name, e.last_name FROM shifts s
     JOIN sites si ON si.id = s.site_id JOIN employees e ON e.id = s.employee_id
     WHERE si.client_id = ? AND e.status = 'active' AND s.status != 'cancelled' AND s.start_at >= ?
     ORDER BY e.first_name, e.last_name`,
    clientId,
    `${time.addDays(time.todayStr(), -180)}T00:00`
  );
}

function clientSites(clientId) {
  return db.all('SELECT id, name, address FROM sites WHERE client_id = ? AND active = 1 ORDER BY name', clientId);
}

// Reads the request form. Returns { values, error }.
async function readForm(body, clientId) {
  const v = clean(body, ['site_id', 'date', 'start_time', 'end_time', 'break_minutes', 'officers_needed', 'notes', 'repeat_until']);
  const known = new Set((await knownOfficers(clientId)).map((e) => e.id));
  const values = {
    site_id: toId(v.site_id),
    date: v.date,
    start_time: v.start_time,
    end_time: v.end_time,
    break_minutes: toNumber(v.break_minutes, 0),
    officers_needed: toNumber(v.officers_needed, 1),
    notes: v.notes ? v.notes.slice(0, 500) : null,
    officers: [...new Set(asArray(body.officers).map(toId).filter((id) => id && known.has(id)))],
    // Days of the week to repeat on (0 = Monday … 6 = Sunday), and the last date.
    repeat_days: [...new Set(asArray(body.repeat_days).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(),
    repeat_until: v.repeat_until,
  };
  let error = null;
  if (!values.site_id || !(await db.get('SELECT 1 FROM sites WHERE id = ? AND client_id = ? AND active = 1', values.site_id, clientId))) {
    error = 'Choose one of your sites.';
  } else if (!time.isValidDate(values.date)) error = 'Choose the date.';
  else if (!time.isValidTime(values.start_time) || !time.isValidTime(values.end_time)) error = 'Enter a start time and an end time.';
  else if (values.start_time === values.end_time) error = 'The start and end times are the same.';
  else if (!Number.isInteger(values.officers_needed) || values.officers_needed < 1 || values.officers_needed > MAX_OFFICERS) {
    error = `Ask for between 1 and ${MAX_OFFICERS} officers.`;
  } else if (!Number.isInteger(values.break_minutes) || values.break_minutes < 0 || values.break_minutes > 600) {
    error = 'The break must be a whole number of minutes.';
  } else if (values.repeat_days.length && !time.isValidDate(values.repeat_until)) {
    error = 'Choose the last date to repeat until.';
  } else if (values.repeat_days.length && values.repeat_until < values.date) {
    error = 'The last date must be on or after the first date.';
  } else if (values.repeat_days.length && time.daysBetween(values.date, values.repeat_until) > MAX_REPEAT_DAYS) {
    error = 'A request can repeat for up to 3 months. Send another request for later dates.';
  }
  if (!error) {
    const dates = values.repeat_days.length ? matchingDates(values.date, values.repeat_until, values.repeat_days) : [values.date];
    if (!dates.length) error = 'None of the ticked days fall between those two dates.';
    else if (dates.length * values.officers_needed > MAX_SHIFTS) {
      error = `That's ${dates.length * values.officers_needed} shifts. Please ask for ${MAX_SHIFTS} or fewer in one request.`;
    } else {
      // The first shift is on the first ticked day (the date itself, if it isn't repeating).
      Object.assign(values, time.buildRange(dates[0], values.start_time, values.end_time));
      values.last_end_at = time.buildRange(dates.at(-1), values.start_time, values.end_time).end_at;
      values.dates = dates;
      if (values.start_at <= time.nowStr()) error = 'That time has already passed.';
      else if (time.daysBetween(time.todayStr(), dates[0]) > 366) error = 'Please request shifts up to a year ahead.';
    }
  }
  return { values, error };
}

// Saves a request and tells the office.
async function create(clientId, userId, values) {
  const id = await db.transaction(async (tx) => {
    const requestId = await tx.insert(
      `INSERT INTO shift_requests (client_id, site_id, requested_by, start_at, end_at, last_end_at, repeat_days, repeat_until,
         break_minutes, officers_needed, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      clientId, values.site_id, userId, values.start_at, values.end_at, values.last_end_at,
      values.repeat_days.length ? values.repeat_days.join(',') : null, values.repeat_days.length ? values.repeat_until : null,
      values.break_minutes, values.officers_needed, values.notes
    );
    for (const employeeId of values.officers) {
      await tx.run('INSERT INTO shift_request_officers (request_id, employee_id) VALUES (?, ?)', requestId, employeeId);
    }
    return requestId;
  });
  const request = await find(id);
  await notifyOffice({
    title: `Shift request from ${request.client_name}`,
    body: `${when(request)} at ${request.site_name}, ${request.officers_needed} officer${request.officers_needed === 1 ? '' : 's'}${datesFor(request).length > 1 ? ' each time' : ''}. Tap to approve or decline.`,
    url: '/schedule/requests',
    tag: `request-${id}`,
  });
  return request;
}

function find(id) {
  return db.get(
    `SELECT r.*, si.name AS site_name, c.name AS client_name, u.name AS requested_by_name, d.name AS decided_by_name
     FROM shift_requests r JOIN sites si ON si.id = r.site_id JOIN clients c ON c.id = r.client_id
     LEFT JOIN users u ON u.id = r.requested_by LEFT JOIN users d ON d.id = r.decided_by
     WHERE r.id = ?`,
    id
  );
}

// Adds what a list page needs: the officers asked for, and the shifts made
// (with who's on them).
async function withDetails(requests) {
  const ids = requests.map((r) => r.id);
  if (!ids.length) return requests;
  const [asked, shifts] = await Promise.all([
    db.all(
      `SELECT ro.request_id, e.id, e.first_name, e.last_name FROM shift_request_officers ro JOIN employees e ON e.id = ro.employee_id
       WHERE ro.request_id = ANY(?::int[]) ORDER BY e.first_name`,
      ids
    ),
    db.all(
      `SELECT s.id, s.request_id, s.status, s.employee_id, s.start_at, s.end_at, e.first_name, e.last_name,
         EXISTS (SELECT 1 FROM shift_offers o WHERE o.shift_id = s.id AND o.status = 'open') AS offered
       FROM shifts s LEFT JOIN employees e ON e.id = s.employee_id WHERE s.request_id = ANY(?::int[]) ORDER BY s.start_at, s.id`,
      ids
    ),
  ]);
  for (const r of requests) {
    r.asked = asked.filter((a) => a.request_id === r.id).map((a) => ({ id: a.id, name: shortName(a) }));
    r.shifts = shifts.filter((s) => s.request_id === r.id).map((s) => ({ ...s, name: s.employee_id ? shortName(s) : null }));
    r.covered = r.shifts.filter((s) => s.employee_id && s.status !== 'cancelled').length;
    r.when = when(r);
    r.dateCount = datesFor(r).length;
    r.repeating = r.dateCount > 1;
    // How many shifts it is: the ones made, once approved; otherwise dates × officers.
    r.total = r.status === 'approved' ? r.shifts.filter((s) => s.status !== 'cancelled').length : r.dateCount * r.officers_needed;
  }
  return requests;
}

// The office approves: makes the shifts (for dates still to come), offers
// them (the officers the site asked for first) and tells the site. A one-off
// request's shifts are offered now; a repeating one's when they're within two
// weeks (the rest by the 5-minute job, see offerUpcoming). Returns { request,
// shifts, offered, later, nobody, skipped, firstChoice } or { error }.
async function approve(id, { user, settings }) {
  const request = await find(id);
  if (!request) return { error: 'That request no longer exists.' };
  if (request.status !== 'pending') return { error: `This request was already ${request.status}.` };
  const now = time.nowStr();
  const allTimes = timesFor(request);
  const times = allTimes.filter((t) => t.start_at > now);
  if (!times.length) return { error: 'This request is for a time that has already passed. Decline it instead.' };
  const asked = (await db.all('SELECT employee_id FROM shift_request_officers WHERE request_id = ?', id)).map((r) => r.employee_id);
  const note = [`Requested by ${request.requested_by_name || request.client_name}`, request.notes].filter(Boolean).join(': ');

  const made = await db.transaction(async (tx) => {
    // Only one approval can win, even if two people press it at once.
    const claimed = await tx.run(
      "UPDATE shift_requests SET status = 'approved', decided_by = ?, decided_at = app_now() WHERE id = ? AND status = 'pending'",
      user.id, id
    );
    if (!claimed.changes) return null;
    const shifts = [];
    for (const t of times) {
      for (let i = 0; i < request.officers_needed; i += 1) {
        const shiftId = await tx.insert(
          'INSERT INTO shifts (site_id, start_at, end_at, break_minutes, notes, request_id) VALUES (?, ?, ?, ?, ?, ?)',
          request.site_id, t.start_at, t.end_at, request.break_minutes, note, id
        );
        shifts.push({ id: shiftId, start_at: t.start_at });
      }
    }
    return shifts;
  });
  if (!made) return { error: 'Someone else has just dealt with this request.' };

  const repeating = allTimes.length > 1;
  const offerUntil = repeating ? offerHorizon() : null;
  const digest = openShifts.newDigest();
  const firstChoice = new Set();
  const nobodyFree = [];
  let offered = 0;
  for (const shift of made) {
    if (offerUntil && shift.start_at > offerUntil) continue;
    const result = await openShifts.offerShift(shift.id, { userId: user.id, settings, firstChoice: asked, digest });
    if (result.offer) offered += 1;
    else if (await markNobodyFree(shift.id)) nobodyFree.push(shift);
    for (const e of result.firstChoice || []) firstChoice.add(e);
  }
  await openShifts.sendDigest(digest);
  await notifyClient(request.client_id, {
    title: `Approved: ${when(request)}`,
    body: repeating
      ? `${request.site_name}, ${request.officers_needed} officer${request.officers_needed === 1 ? '' : 's'} each time. Each shift is offered to officers about two weeks ahead; you'll hear as each one is covered.`
      : `${request.site_name}, ${request.officers_needed} officer${request.officers_needed === 1 ? '' : 's'}. We're offering it to officers now; you'll hear when it's covered.`,
    url: `/my/requests/${id}`,
    tag: `request-${id}`,
  });
  return {
    request: await find(id),
    shifts: made.map((m) => m.id),
    offered,
    nobody: nobodyFree.length,
    later: made.length - offered - nobodyFree.length,
    skipped: allTimes.length - times.length,
    firstChoice: [...firstChoice],
  };
}

// The last moment a repeating request's shifts are offered up to: two weeks from today.
function offerHorizon() {
  return `${time.addDays(time.todayStr(), OFFER_AHEAD_DAYS)}T23:59`;
}

// Nobody could take this shift when it was offered: a closed offer records
// that, so it isn't tried again every few minutes (the office finds cover).
// True if this call recorded it (so only one caller tells the office).
async function markNobodyFree(shiftId) {
  const now = time.nowStr();
  const row = await db.get(
    `INSERT INTO shift_offers (shift_id, status, escalate_at, escalated_at, closed_note)
     SELECT ?, 'withdrawn', ?, ?, 'Nobody was free to take it'
     WHERE NOT EXISTS (SELECT 1 FROM shift_offers WHERE shift_id = ?) RETURNING id`,
    shiftId, now, now, shiftId
  );
  return Boolean(row);
}

// The 5-minute job: offers approved requests' shifts as they come within two
// weeks, the officers the site asked for first. Only shifts never offered:
// one whose offer closed has already been dealt with.
async function offerUpcoming(settings) {
  const due = await db.all(
    `SELECT s.id, s.request_id FROM shifts s JOIN shift_requests r ON r.id = s.request_id
     WHERE r.status = 'approved' AND s.employee_id IS NULL AND s.status = 'scheduled' AND s.start_at > ? AND s.start_at <= ?
       AND NOT EXISTS (SELECT 1 FROM shift_offers o WHERE o.shift_id = s.id)
     ORDER BY s.start_at LIMIT 30`,
    time.nowStr(),
    offerHorizon()
  );
  if (!due.length) return;
  const digest = openShifts.newDigest();
  const askedFor = new Map();
  const nobodyFree = [];
  for (const shift of due) {
    if (!askedFor.has(shift.request_id)) {
      askedFor.set(shift.request_id, (await db.all('SELECT employee_id FROM shift_request_officers WHERE request_id = ?', shift.request_id)).map((r) => r.employee_id));
    }
    const result = await openShifts.offerShift(shift.id, { settings, firstChoice: askedFor.get(shift.request_id), digest });
    if (!result.offer && !result.error && (await markNobodyFree(shift.id))) nobodyFree.push(await openShifts.findShift(shift.id));
  }
  await openShifts.sendDigest(digest);
  if (nobodyFree.length) {
    const [first] = nobodyFree;
    await notifyOffice({
      title: nobodyFree.length === 1 ? `No officer free: ${time.fmtDay(first.start_at)}, ${time.fmtRange(first.start_at, first.end_at)}` : `No officer free for ${nobodyFree.length} requested shifts`,
      body: `${first.site_name} (${first.client_name})${nobodyFree.length > 1 ? `, from ${time.fmtDay(first.start_at)}` : ''}. Nobody who could take it is free. Tap to find cover.`,
      url: nobodyFree.length === 1 ? `/schedule/${first.id}/cover` : `/schedule?week=${time.startOfWeek(first.start_at.slice(0, 10))}`,
      tag: `nobody-free-${first.id}`,
    });
  }
}

async function decline(id, { user, reason }) {
  const request = await find(id);
  if (!request || request.status !== 'pending') return { error: 'Only requests waiting for approval can be declined.' };
  await db.run(
    "UPDATE shift_requests SET status = 'declined', decided_by = ?, decided_at = app_now(), decline_reason = ? WHERE id = ? AND status = 'pending'",
    user.id, reason, id
  );
  await notifyClient(request.client_id, {
    title: `Not approved: ${when(request)}`,
    body: `${request.site_name}${reason ? `: ${reason}` : ''}. Please contact the office if you have questions.`,
    url: `/my/requests/${id}`,
    tag: `request-${id}`,
  });
  return { request: await find(id) };
}

// The site changes its mind (only while it's still waiting for approval).
async function cancel(id, clientId) {
  const result = await db.run(
    "UPDATE shift_requests SET status = 'cancelled', decided_at = app_now() WHERE id = ? AND client_id = ? AND status = 'pending'",
    id, clientId
  );
  if (!result.changes) return { error: 'Only requests still waiting for approval can be cancelled. Please contact the office.' };
  const request = await find(id);
  await notifyOffice({ title: `Request cancelled by ${request.client_name}`, body: `${when(request)} at ${request.site_name}.`, url: '/schedule/requests', tag: `request-${id}` });
  return { request };
}

module.exports = {
  STATUS_LABELS, MAX_OFFICERS, MAX_REPEAT_DAYS, OFFER_AHEAD_DAYS, WEEKDAYS,
  knownOfficers, clientSites, readForm, create, find, withDetails, datesFor, timesFor, lastStartOf, pendingCount, when,
  approve, decline, cancel, offerUpcoming,
};
