// Officers' availability: times they can't work, and times they'd like extra
// shifts. Each entry is either a date range (one day or several) or a weekly
// repeat ("every Tuesday"), all day or between two times.
//
// The schedule uses it everywhere: the conflict checker warns about shifts
// booked while someone is unavailable, "Find cover" and open-shift offers skip
// them, and officers who said they're available are asked first.
const db = require('../db');
const time = require('../time');
const { clean, asArray } = require('../helpers');

const KINDS = { unavailable: "Can't work", available: 'Available for extra shifts' };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // 0 = Monday, like the schedule's repeats
const MAX_RANGE_DAYS = 366;

// The real times one entry covers between two dates: [{ start_at, end_at }].
// (A weekly repeat with no end date counts up to `toDate`.)
function windowsOf(entry, fromDate, toDate) {
  const days = entry.weekdays ? entry.weekdays.split(',').map(Number) : null;
  const first = entry.start_date > fromDate ? entry.start_date : fromDate;
  const end = entry.end_date || toDate;
  const last = end < toDate ? end : toDate;
  const windows = [];
  for (let date = first; date <= last; date = time.addDays(date, 1)) {
    if (days && !days.includes(time.dayOfWeek(date))) continue;
    windows.push(entry.start_time && entry.end_time
      ? time.buildRange(date, entry.start_time, entry.end_time)
      : { start_at: `${date}T00:00`, end_at: `${time.addDays(date, 1)}T00:00` });
  }
  return windows;
}

const overlaps = (w, startAt, endAt) => w.start_at < endAt && w.end_at > startAt;

// Entries for these officers that touch these dates (a day earlier too, for overnight times).
function entriesFor(employeeIds, fromDate, toDate) {
  if (!employeeIds.length) return [];
  return db.all(
    `SELECT * FROM availability WHERE employee_id = ANY(?::int[]) AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)
     ORDER BY start_date, id`,
    employeeIds, toDate, time.addDays(fromDate, -1)
  );
}

// For each officer, during one stretch of time: the entry saying they can't
// work (or null), and the entry saying they'd like shifts (or null).
async function statusDuring(employeeIds, startAt, endAt) {
  const from = time.addDays(startAt.slice(0, 10), -1);
  const to = endAt.slice(0, 10);
  const status = new Map(employeeIds.map((id) => [id, { unavailable: null, available: null }]));
  for (const entry of await entriesFor(employeeIds, from, to)) {
    if (windowsOf(entry, from, to).some((w) => overlaps(w, startAt, endAt))) {
      status.get(entry.employee_id)[entry.kind] ??= entry;
    }
  }
  return status;
}

// "Every Tue, Thu, 18:00–23:00, from 20 Oct" / "Mon 20 Oct – Wed 22 Oct, all day"
function describe(entry) {
  const hours = entry.start_time
    ? `${entry.start_time}–${entry.end_time}${entry.end_time < entry.start_time ? ' (+1)' : ''}`
    : 'all day';
  if (entry.weekdays) {
    const days = entry.weekdays.split(',').map((d) => WEEKDAYS[Number(d)]).join(', ');
    const until = entry.end_date ? ` until ${time.fmtDate(entry.end_date)}` : '';
    return `Every ${days}, ${hours}, from ${time.fmtDate(entry.start_date)}${until}`;
  }
  const dates = entry.end_date && entry.end_date !== entry.start_date
    ? `${time.fmtDay(entry.start_date)} – ${time.fmtDay(entry.end_date)}`
    : time.fmtDay(entry.start_date);
  return `${dates}, ${hours}`;
}

// Reads the form on the officer's availability page. Returns { values, error }.
function readForm(body) {
  const v = clean(body, ['kind', 'start_date', 'end_date', 'start_time', 'end_time', 'note']);
  const weekly = body.repeat === 'weekly';
  const values = {
    kind: KINDS[v.kind] ? v.kind : 'unavailable',
    start_date: v.start_date,
    end_date: v.end_date || (weekly ? null : v.start_date),
    weekdays: weekly ? [...new Set(asArray(body.weekdays).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort().join(',') || null : null,
    start_time: body.all_day ? null : v.start_time,
    end_time: body.all_day ? null : v.end_time,
    note: v.note ? v.note.slice(0, 200) : null,
    repeat: weekly ? 'weekly' : 'once',
  };
  let error = null;
  if (!time.isValidDate(values.start_date)) error = 'Choose the first date.';
  else if (values.end_date && !time.isValidDate(values.end_date)) error = 'Choose a valid last date.';
  else if (values.end_date && values.end_date < values.start_date) error = 'The last date must be on or after the first date.';
  else if ((values.end_date || values.start_date) < time.todayStr()) error = "That's already in the past.";
  else if (!weekly && time.daysBetween(values.start_date, values.end_date) > MAX_RANGE_DAYS) error = 'Please keep it to a year at most.';
  else if (weekly && !values.weekdays) error = 'Tick the days of the week it repeats on.';
  else if (!body.all_day && (!time.isValidTime(values.start_time) || !time.isValidTime(values.end_time))) {
    error = 'Enter a start and end time, or tick "All day".';
  } else if (!body.all_day && values.start_time === values.end_time) error = 'The start and end times are the same.';
  return { values, error };
}

module.exports = { KINDS, WEEKDAYS, windowsOf, entriesFor, statusDuring, describe, readForm };
