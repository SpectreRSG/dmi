// Shift requests from site representatives (client accounts). They ask for a
// shift at one of their sites, and can name officers they'd like. The office
// approves it (or declines, with a reason). Approved: the shifts go on the
// schedule as open shifts and are offered to officers, the named ones first.
// The site hears when it's approved and when each shift is covered.
const db = require('../db');
const time = require('../time');
const { clean, toId, toNumber, asArray } = require('../helpers');
const openShifts = require('./openShifts');
const { notifyOffice, notifyClient } = require('./notify');

const MAX_OFFICERS = 10;
const STATUS_LABELS = { pending: 'Waiting for approval', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled' };

const when = (r) => `${time.fmtDay(r.start_at)}, ${time.fmtRange(r.start_at, r.end_at)}`;
const shortName = (e) => `${e.first_name} ${e.last_name.charAt(0)}.`;

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
  const v = clean(body, ['site_id', 'date', 'start_time', 'end_time', 'break_minutes', 'officers_needed', 'notes']);
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
  }
  if (!error) {
    Object.assign(values, time.buildRange(values.date, values.start_time, values.end_time));
    if (values.start_at <= time.nowStr()) error = 'That time has already passed.';
    else if (time.daysBetween(time.todayStr(), values.date) > 366) error = 'Please request shifts up to a year ahead.';
  }
  return { values, error };
}

// Saves a request and tells the office.
async function create(clientId, userId, values) {
  const id = await db.transaction(async (tx) => {
    const requestId = await tx.insert(
      `INSERT INTO shift_requests (client_id, site_id, requested_by, start_at, end_at, break_minutes, officers_needed, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      clientId, values.site_id, userId, values.start_at, values.end_at, values.break_minutes, values.officers_needed, values.notes
    );
    for (const employeeId of values.officers) {
      await tx.run('INSERT INTO shift_request_officers (request_id, employee_id) VALUES (?, ?)', requestId, employeeId);
    }
    return requestId;
  });
  const request = await find(id);
  await notifyOffice({
    title: `Shift request from ${request.client_name}`,
    body: `${when(request)} at ${request.site_name}, ${request.officers_needed} officer${request.officers_needed === 1 ? '' : 's'}. Tap to approve or decline.`,
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
      `SELECT s.id, s.request_id, s.status, s.employee_id, e.first_name, e.last_name,
         EXISTS (SELECT 1 FROM shift_offers o WHERE o.shift_id = s.id AND o.status = 'open') AS offered
       FROM shifts s LEFT JOIN employees e ON e.id = s.employee_id WHERE s.request_id = ANY(?::int[]) ORDER BY s.id`,
      ids
    ),
  ]);
  for (const r of requests) {
    r.asked = asked.filter((a) => a.request_id === r.id).map((a) => ({ id: a.id, name: shortName(a) }));
    r.shifts = shifts.filter((s) => s.request_id === r.id).map((s) => ({ ...s, name: s.employee_id ? shortName(s) : null }));
    r.covered = r.shifts.filter((s) => s.employee_id && s.status !== 'cancelled').length;
  }
  return requests;
}

// The office approves: makes the shifts, offers them (the officers the site
// asked for first) and tells the site. Returns { request, shifts, offered,
// firstChoice } or { error }.
async function approve(id, { user, settings }) {
  const request = await find(id);
  if (!request) return { error: 'That request no longer exists.' };
  if (request.status !== 'pending') return { error: `This request was already ${request.status}.` };
  if (request.start_at <= time.nowStr()) return { error: 'This request is for a time that has already passed. Decline it instead.' };
  const asked = (await db.all('SELECT employee_id FROM shift_request_officers WHERE request_id = ?', id)).map((r) => r.employee_id);
  const note = [`Requested by ${request.requested_by_name || request.client_name}`, request.notes].filter(Boolean).join(': ');

  const shiftIds = await db.transaction(async (tx) => {
    // Only one approval can win, even if two people press it at once.
    const claimed = await tx.run(
      "UPDATE shift_requests SET status = 'approved', decided_by = ?, decided_at = app_now() WHERE id = ? AND status = 'pending'",
      user.id, id
    );
    if (!claimed.changes) return null;
    const made = [];
    for (let i = 0; i < request.officers_needed; i += 1) {
      made.push(await tx.insert(
        'INSERT INTO shifts (site_id, start_at, end_at, break_minutes, notes, request_id) VALUES (?, ?, ?, ?, ?, ?)',
        request.site_id, request.start_at, request.end_at, request.break_minutes, note, id
      ));
    }
    return made;
  });
  if (!shiftIds) return { error: 'Someone else has just dealt with this request.' };

  let offered = 0;
  const firstChoice = new Set();
  for (const shiftId of shiftIds) {
    const result = await openShifts.offerShift(shiftId, { userId: user.id, settings, firstChoice: asked });
    if (result.offer) offered += 1;
    for (const e of result.firstChoice || []) firstChoice.add(e);
  }
  await notifyClient(request.client_id, {
    title: `Approved: ${when(request)}`,
    body: `${request.site_name}, ${request.officers_needed} officer${request.officers_needed === 1 ? '' : 's'}. We're offering it to officers now; you'll hear when it's covered.`,
    url: '/my/requests',
    tag: `request-${id}`,
  });
  return { request: await find(id), shifts: shiftIds, offered, firstChoice: [...firstChoice] };
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
    url: '/my/requests',
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

module.exports = { STATUS_LABELS, MAX_OFFICERS, knownOfficers, clientSites, readForm, create, find, withDetails, approve, decline, cancel };
