// Call-outs and open shifts: when someone can't work a shift, it's offered to
// the officers who could take it, and the first one to claim it gets it. The
// office is only told when nobody has, so it can step in.
//
// Who gets offered a shift: officers with an account who are free, rested
// enough, licensed and trained on the day, and haven't said they can't work
// then (the same checks as "Find cover"). They're told in two waves: first
// the regulars at that site and anyone who said they'd like shifts then (as
// long as it wouldn't put them into overtime), then ten minutes later
// everyone else. When the shift starts within a few hours, everyone is told
// at once. A site's request can name officers: they get first choice, for
// longer, before anyone else is told.
const db = require('../db');
const time = require('../time');
const { coverOptions, SHIFT_SELECT } = require('./conflicts');
const { notifyEmployees, notifyOffice, notifyClient } = require('./notify');

const WAVE_GAP_MINUTES = 10; // between the regulars and everyone else
const FIRST_CHOICE_MINUTES = 120; // how long officers a site asked for have it to themselves (at most)
const ESCALATE_MINUTES = 30; // tell the office if nobody has claimed it by then
const SHORT_NOTICE_HOURS = 3; // starting this soon: everyone at once, office after 15 minutes
const SHORT_NOTICE_ESCALATE_MINUTES = 15;

function addMinutes(at, minutes) {
  return new Date(Date.parse(`${at}:00Z`) + minutes * 60000).toISOString().slice(0, 16);
}

const hoursUntil = (at) => time.hoursBetween(time.nowStr(), at);
const shortName = (e) => `${e.first_name} ${e.last_name.charAt(0)}.`;
const when = (s) => `${time.fmtDay(s.start_at)}, ${time.fmtRange(s.start_at, s.end_at)}`;

function findShift(id) {
  return db.get(`${SHIFT_SELECT} WHERE s.id = ?`, id);
}

function openOfferFor(shiftId) {
  return db.get("SELECT * FROM shift_offers WHERE shift_id = ? AND status = 'open'", shiftId);
}

// Can this officer take this shift? Returns null if so, or the reason not.
function claimProblem(option) {
  if (!option) return 'You can no longer take this shift.';
  if (option.blockers.length) return `You can't take this shift: ${option.blockers[0].toLowerCase()}.`;
  if (option.restProblem || option.complianceProblem) {
    return `You can't take this shift: ${option.warnings.find((w) => !w.startsWith('Would go into overtime')).toLowerCase()}.`;
  }
  return null;
}

// Officers who could take the shift (and have an account to claim it with).
async function eligibleOfficers(shift, settings) {
  const [options, accounts, calledOut] = await Promise.all([
    coverOptions(shift, settings),
    db.all("SELECT employee_id FROM users WHERE role = 'officer' AND active = 1 AND employee_id IS NOT NULL"),
    db.all('SELECT employee_id FROM shift_callouts WHERE shift_id = ?', shift.id),
  ]);
  const canSignIn = new Set(accounts.map((a) => a.employee_id));
  const saidNo = new Set(calledOut.map((c) => c.employee_id)); // never offer it back to someone who called out
  return options.filter((o) => canSignIn.has(o.employee.id) && !saidNo.has(o.employee.id) && !claimProblem(o));
}

// Officers offered several shifts at once (a repeating request, or several
// waves due together) get one alert listing them, not one per shift. Collect
// the offers in a digest, then send it.
function newDigest() {
  return new Map(); // employee id -> [{ offer, shift, requested }]
}

function addToDigest(digest, employeeIds, item) {
  for (const id of employeeIds) {
    if (!digest.has(id)) digest.set(id, []);
    digest.get(id).push(item);
  }
}

async function sendDigest(digest) {
  // Officers offered exactly the same shifts share one send.
  const groups = new Map();
  for (const [employeeId, items] of digest) {
    const key = items.map((i) => `${i.offer.id}${i.requested ? '*' : ''}`).join(',');
    if (!groups.has(key)) groups.set(key, { items, employeeIds: [] });
    groups.get(key).employeeIds.push(employeeId);
  }
  for (const { items, employeeIds } of groups.values()) {
    if (items.length === 1) {
      await tellOfficers(items[0].offer, items[0].shift, employeeIds, { requested: items[0].requested });
      continue;
    }
    const sorted = [...items].sort((a, b) => (a.shift.start_at < b.shift.start_at ? -1 : 1));
    const sites = [...new Set(sorted.map((i) => i.shift.site_name))];
    const requested = sorted.every((i) => i.requested) && new Set(sorted.map((i) => i.shift.client_name)).size === 1;
    await notifyEmployees(employeeIds, {
      title: requested ? `${sorted[0].shift.client_name} asked for you: ${sorted.length} shifts` : `${sorted.length} open shifts`,
      body: `${sites.length === 1 ? sites[0] : `${sites.length} sites`}, ${time.fmtDay(sorted[0].shift.start_at)} – ${time.fmtDay(sorted.at(-1).shift.start_at)}. `
        + (requested ? "You have first choice before they're offered to others." : 'First to claim each one gets it.') + ' Tap to see them.',
      url: '/my/schedule#open-shifts',
      tag: `offers-${sorted[0].offer.id}`,
    });
  }
}

// Offers an unfilled, upcoming shift to officers. `firstChoice` = officers a
// site asked for by name. With a `digest`, the officers are told when it's
// sent (see above). Returns { offer, toldNow, toldLater, firstChoice } (offer
// is null when nobody could take it) or { error }.
async function offerShift(shiftId, { userId = null, settings, firstChoice = [], digest = null }) {
  const shift = await findShift(shiftId);
  const now = time.nowStr();
  if (!shift || shift.status !== 'scheduled') return { error: 'Only scheduled shifts can be offered.' };
  if (shift.employee_id) return { error: 'This shift already has someone on it.' };
  if (shift.start_at <= now) return { error: 'This shift has already started.' };
  const existing = await openOfferFor(shift.id);
  if (existing) return { offer: existing, already: true };

  const eligible = await eligibleOfficers(shift, settings);
  if (!eligible.length) return { offer: null, toldNow: 0, toldLater: 0 }; // the office has to find cover
  const shortNotice = hoursUntil(shift.start_at) <= SHORT_NOTICE_HOURS;
  const asked = eligible.filter((o) => firstChoice.includes(o.employee.id));
  const regulars = shortNotice ? [] : eligible.filter((o) => (o.siteShifts > 0 || o.markedAvailable) && !o.overtime);
  const first = asked.length ? asked : regulars.length ? regulars : eligible;
  const later = eligible.filter((o) => !first.includes(o));
  // Officers the site asked for get it to themselves for up to 2 hours (less
  // if the shift is soon: at most a quarter of the time left, at least 10 minutes).
  const gap = asked.length
    ? Math.max(WAVE_GAP_MINUTES, Math.min(FIRST_CHOICE_MINUTES, Math.floor((hoursUntil(shift.start_at) * 60) / 4)))
    : WAVE_GAP_MINUTES;
  const nextWaveAt = later.length ? addMinutes(now, gap) : null;
  let escalateAt = addMinutes(nextWaveAt || now, shortNotice ? SHORT_NOTICE_ESCALATE_MINUTES : ESCALATE_MINUTES);
  if (escalateAt > shift.start_at) escalateAt = shift.start_at;

  let offerId;
  try {
    offerId = await db.transaction(async (tx) => {
      const id = await tx.insert(
        'INSERT INTO shift_offers (shift_id, created_by, next_wave_at, escalate_at) VALUES (?, ?, ?, ?)',
        shift.id,
        userId,
        nextWaveAt,
        escalateAt
      );
      for (const [wave, group] of [[1, first], [2, later]]) {
        for (const o of group) {
          await tx.run(
            'INSERT INTO shift_offer_recipients (offer_id, employee_id, wave, notified_at) VALUES (?, ?, ?, ?)',
            id, o.employee.id, wave, wave === 1 ? now : null
          );
        }
      }
      return id;
    });
  } catch (err) {
    // Offered at the same moment by someone else: use theirs.
    const theirs = await openOfferFor(shift.id);
    if (theirs) return { offer: theirs, already: true };
    throw err;
  }
  const offer = await db.get('SELECT * FROM shift_offers WHERE id = ?', offerId);
  const told = first.map((o) => o.employee.id);
  if (digest) addToDigest(digest, told, { offer, shift, requested: asked.length > 0 });
  else await tellOfficers(offer, shift, told, { requested: asked.length > 0 });
  return { offer, toldNow: first.length, toldLater: later.length, firstChoice: asked.map((o) => o.employee.id) };
}

function tellOfficers(offer, shift, employeeIds, { requested = false } = {}) {
  return notifyEmployees(employeeIds, {
    title: requested ? `${shift.client_name} asked for you: ${when(shift)}` : `Open shift: ${when(shift)}`,
    body: requested
      ? `${shift.site_name}. You have first choice before it's offered to others. Tap to claim it.`
      : `${shift.site_name} (${shift.client_name}). First to claim it gets it.`,
    url: `/my/open-shifts/${offer.id}`,
    tag: `offer-${offer.id}`,
  });
}

// Someone can't work their shift: takes them off it, keeps a record, offers
// it to other officers, and tells the office (or the officer, when the office
// noted it for them). Returns the offer result, or { error }.
async function callOut(shiftId, { employeeId, reason = null, userId, byOffice = false, settings }) {
  const shift = await findShift(shiftId);
  const now = time.nowStr();
  if (!shift || shift.employee_id !== employeeId) return { error: "This shift isn't yours." };
  if (shift.status !== 'scheduled') return { error: 'This shift is no longer scheduled.' };
  if (shift.start_at <= now) return { error: 'This shift has already started. Please call the office.' };

  const taken = await db.transaction(async (tx) => {
    const result = await tx.run("UPDATE shifts SET employee_id = NULL WHERE id = ? AND employee_id = ? AND status = 'scheduled'", shift.id, employeeId);
    if (!result.changes) return false;
    await tx.run(
      `INSERT INTO shift_callouts (shift_id, employee_id, reason, reported_by, hours_notice, shift_start) VALUES (?, ?, ?, ?, ?, ?)`,
      shift.id, employeeId, reason, userId, Math.round(hoursUntil(shift.start_at) * 10) / 10, shift.start_at
    );
    return true;
  });
  if (!taken) return { error: 'This shift has just changed. Please refresh the page.' };

  const result = await offerShift(shift.id, { userId, settings });
  const who = shortName(shift);
  const asked = result.offer && !result.already ? result.toldNow + result.toldLater : 0;
  const next = asked
    ? `Offered to ${asked} officer${asked === 1 ? '' : 's'}; you'll hear if nobody claims it.`
    : 'Nobody else is free to take it. Find cover.';
  if (byOffice) {
    await notifyEmployees([employeeId], {
      title: 'Taken off a shift',
      body: `The office has taken you off ${when(shift)} at ${shift.site_name}.`,
      url: '/my/schedule',
    });
  } else {
    await notifyOffice({
      title: `Call-out: ${who}, ${when(shift)}`,
      body: `${shift.site_name}${reason ? ` – "${reason}"` : ''}. ${next}`,
      url: asked ? `/schedule/${shift.id}/edit` : `/schedule/${shift.id}/cover`,
      tag: `shift-${shift.id}`,
    });
  }
  return { ...result, asked };
}

// An officer claims an open shift. The first eligible one wins: the shift is
// given to whoever's claim reaches the database first. Returns { shift } or { error }.
async function claimShift(offerId, employeeId, settings) {
  const offer = await db.get('SELECT * FROM shift_offers WHERE id = ?', offerId);
  const offered = offer && (await db.get(
    'SELECT 1 FROM shift_offer_recipients WHERE offer_id = ? AND employee_id = ? AND notified_at IS NOT NULL', offerId, employeeId
  ));
  if (!offered) return { error: "This shift wasn't offered to you." };
  if (offer.status === 'filled') return { error: offer.filled_by === employeeId ? "It's already yours." : 'Someone else already took this shift.' };
  if (offer.status !== 'open') return { error: 'This shift is no longer open.' };
  const shift = await findShift(offer.shift_id);
  const now = time.nowStr();
  if (shift.start_at <= now) return { error: 'This shift has already started.' };

  // Still free, rested and qualified right now?
  const problem = claimProblem((await coverOptions(shift, settings)).find((o) => o.employee.id === employeeId));
  if (problem) return { error: problem };

  const won = await db.transaction(async (tx) => {
    const result = await tx.run(
      `UPDATE shifts SET employee_id = ? WHERE id = ? AND employee_id IS NULL AND status = 'scheduled'
       AND NOT EXISTS (SELECT 1 FROM shifts o WHERE o.employee_id = ? AND o.id != shifts.id AND o.status != 'cancelled'
                       AND o.start_at < shifts.end_at AND o.end_at > shifts.start_at)`,
      employeeId, shift.id, employeeId
    );
    if (!result.changes) return false;
    await tx.run(
      "UPDATE shift_offers SET status = 'filled', filled_by = ?, filled_at = ?, next_wave_at = NULL WHERE id = ?",
      employeeId, now, offer.id
    );
    return true;
  });
  if (!won) return { error: 'Someone else already took this shift.' };

  const employee = await db.get('SELECT * FROM employees WHERE id = ?', employeeId);
  await notifyOffice({
    title: `Covered: ${shortName(employee)} took ${when(shift)}`,
    body: `${shift.site_name} (${shift.client_name}). Nothing for you to do.`,
    url: `/schedule/${shift.id}/edit`,
    tag: `shift-${shift.id}`,
  });
  // A shift the site asked for: they hear who's coming.
  if (shift.request_id) {
    await notifyClient(shift.client_id, {
      title: `Covered: ${when(shift)}`,
      body: `${shortName(employee)} will work at ${shift.site_name}.`,
      url: `/my/requests/${shift.request_id}`,
      tag: `request-${shift.request_id}`,
    });
  }
  return { shift: await findShift(shift.id), employee };
}

// Closes a shift's open offer, e.g. when the office assigns someone itself.
async function withdrawOffer(shiftId, note) {
  await db.run("UPDATE shift_offers SET status = 'withdrawn', closed_note = ?, next_wave_at = NULL WHERE shift_id = ? AND status = 'open'", note, shiftId);
}

// The timed steps, run every few minutes: tell the next wave, tell the office
// when nobody has claimed a shift, and close offers that no longer apply.
async function advanceOffers() {
  const now = time.nowStr();
  const digest = newDigest();
  const stillOpen = [];
  const offers = await db.all(
    `SELECT o.*, s.employee_id AS shift_employee, s.status AS shift_status, s.start_at
     FROM shift_offers o JOIN shifts s ON s.id = o.shift_id WHERE o.status = 'open'`
  );
  for (const offer of offers) {
    if (offer.shift_employee || offer.shift_status !== 'scheduled') {
      await withdrawOffer(offer.shift_id, 'The office changed the shift');
      continue;
    }
    if (offer.start_at <= now) {
      await withdrawOffer(offer.shift_id, 'Started without anyone claiming it');
      continue;
    }
    // Each step is claimed by exactly one run, so nobody is told twice.
    if (offer.next_wave_at && offer.next_wave_at <= now) {
      const claimed = await db.run('UPDATE shift_offers SET next_wave_at = NULL WHERE id = ? AND next_wave_at = ?', offer.id, offer.next_wave_at);
      if (claimed.changes) {
        const rows = await db.all(
          'UPDATE shift_offer_recipients SET notified_at = ? WHERE offer_id = ? AND notified_at IS NULL RETURNING employee_id',
          now, offer.id
        );
        addToDigest(digest, rows.map((r) => r.employee_id), { offer, shift: await findShift(offer.shift_id), requested: false });
      }
    }
    if (!offer.escalated_at && offer.escalate_at <= now) {
      const claimed = await db.run('UPDATE shift_offers SET escalated_at = ? WHERE id = ? AND escalated_at IS NULL', now, offer.id);
      if (claimed.changes) stillOpen.push(await findShift(offer.shift_id));
    }
  }
  await sendDigest(digest);
  await tellOfficeStillOpen(stillOpen);
}

// When advanceOffers next has something to do: the next group to tell, the
// office to tell, or an offer whose shift starts. (Anything already past is
// left over from a run that failed, so it's due now.)
async function nextOfferStep() {
  const row = await db.get(
    `SELECT MIN(at) AS at FROM (
       SELECT next_wave_at AS at FROM shift_offers WHERE status = 'open'
       UNION ALL SELECT escalate_at FROM shift_offers WHERE status = 'open' AND escalated_at IS NULL
       UNION ALL SELECT s.start_at FROM shift_offers o JOIN shifts s ON s.id = o.shift_id WHERE o.status = 'open'
     ) steps`
  );
  return row.at || undefined;
}

// Nobody has claimed these shifts: one alert for the office (one per shift
// would be a lot when a repeating request's shifts are offered together).
async function tellOfficeStillOpen(shifts) {
  if (shifts.length === 1) {
    const [shift] = shifts;
    await notifyOffice({
      title: `Still open: ${when(shift)}`,
      body: `Nobody has claimed ${shift.site_name} (${shift.client_name}) yet. Tap to find cover.`,
      url: `/schedule/${shift.id}/cover`,
      tag: `shift-${shift.id}`,
    });
  } else if (shifts.length > 1) {
    const sorted = [...shifts].sort((a, b) => (a.start_at < b.start_at ? -1 : 1));
    const sites = [...new Set(sorted.map((s) => s.site_name))];
    await notifyOffice({
      title: `${sorted.length} shifts still open`,
      body: `Nobody has claimed them yet: ${sites.length === 1 ? sites[0] : `${sites.length} sites`}, ${time.fmtDay(sorted[0].start_at)} – ${time.fmtDay(sorted.at(-1).start_at)}. Tap to find cover.`,
      url: `/schedule?week=${time.startOfWeek(sorted[0].start_at.slice(0, 10))}`,
      tag: `still-open-${sorted[0].id}`,
    });
  }
}

// Open shifts this officer has been told about and could still take.
async function openShiftsFor(employeeId) {
  return db.all(
    `SELECT o.id AS offer_id, s.*, si.name AS site_name, si.address AS site_address, c.name AS client_name
     FROM shift_offer_recipients r
     JOIN shift_offers o ON o.id = r.offer_id
     JOIN shifts s ON s.id = o.shift_id
     JOIN sites si ON si.id = s.site_id
     JOIN clients c ON c.id = si.client_id
     WHERE r.employee_id = ? AND r.notified_at IS NOT NULL AND o.status = 'open'
       AND s.employee_id IS NULL AND s.status = 'scheduled' AND s.start_at > ?
     ORDER BY s.start_at`,
    employeeId,
    time.nowStr()
  );
}

module.exports = { offerShift, newDigest, sendDigest, callOut, claimShift, withdrawOffer, advanceOffers, nextOfferStep, openShiftsFor, findShift };
