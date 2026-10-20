// Date and time helpers.
//
// We store dates as text: '2026-10-20' for a date, '2026-10-20T22:00' for a
// date with a time. Text in this format sorts correctly and is easy to read.
// For maths we use UTC internally so daylight-saving changes never move a date.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n) => String(n).padStart(2, '0');

function parseDate(dateStr) {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUTC(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// The company's time zone (from Settings). Servers often run on UTC, so "today"
// and "now" are worked out for this zone rather than the server's own clock.
let timeZone;
function setTimeZone(zone) {
  timeZone = zone;
}

function clockParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

// Today's date in the company's time zone, like '2026-10-20'.
function todayStr() {
  const p = clockParts();
  return `${p.year}-${p.month}-${p.day}`;
}

// Now in the company's time zone, like '2026-10-20T14:30'.
function nowStr() {
  const p = clockParts();
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function addDays(dateStr, days) {
  const d = parseDate(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUTC(d);
}

// Adds months, keeping the day where possible (31 Jan + 1 month = 28/29 Feb).
function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return fromUTC(target);
}

// The Monday of the week containing this date.
function startOfWeek(dateStr) {
  const d = parseDate(dateStr);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return fromUTC(d);
}

// 0 = Monday … 6 = Sunday.
function dayOfWeek(dateStr) {
  return (parseDate(dateStr).getUTCDay() + 6) % 7;
}

// The first and last day of a month written like '2026-10'.
function monthRange(month) {
  const first = `${month}-01`;
  return { first, last: addDays(addMonths(first, 1), -1) };
}

function isValidMonth(str) {
  return typeof str === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(str);
}

function daysBetween(fromDate, toDate) {
  return Math.round((parseDate(toDate) - parseDate(fromDate)) / 86400000);
}

function isValidDate(str) {
  return typeof str === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(str) && fromUTC(parseDate(str)) === str;
}

function isValidTime(str) {
  return typeof str === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(str);
}

function minutesSinceEpoch(dateTime) {
  const [h, m] = dateTime.slice(11, 16).split(':').map(Number);
  return parseDate(dateTime).getTime() / 60000 + h * 60 + m;
}

// '2026-10-20T22:30' plus some minutes (may be negative): '2026-10-21T00:30' for 120.
function addMinutes(dateTime, minutes) {
  const total = minutesSinceEpoch(dateTime) + minutes;
  const date = addDays('1970-01-01', Math.floor(total / 1440));
  const inDay = total - Math.floor(total / 1440) * 1440;
  return `${date}T${pad(Math.floor(inDay / 60))}:${pad(inDay % 60)}`;
}

// Hours between two date-times, minus any unpaid break.
function hoursBetween(startAt, endAt, breakMinutes = 0) {
  const minutes = minutesSinceEpoch(endAt) - minutesSinceEpoch(startAt) - (Number(breakMinutes) || 0);
  return Math.max(0, minutes) / 60;
}

// Turns a date plus start/end times into full date-times. If the end time is
// not after the start time, the shift finishes the next day (e.g. 22:00-06:00).
function buildRange(date, startTime, endTime) {
  const endDate = endTime <= startTime ? addDays(date, 1) : date;
  return { start_at: `${date}T${startTime}`, end_at: `${endDate}T${endTime}` };
}

// ---- Formatting for display -------------------------------------------------

function fmtDate(str) {
  if (!str) return '';
  const d = parseDate(str);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// '2026-10' -> 'October 2026'
function fmtMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function fmtDay(str) {
  if (!str) return '';
  const d = parseDate(str);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function fmtTime(dateTime) {
  return dateTime ? dateTime.slice(11, 16) : '';
}

function fmtDateTime(dateTime) {
  return dateTime ? `${fmtDate(dateTime)}, ${fmtTime(dateTime)}` : '';
}

// '22:00–06:00 (+1)' – the (+1) means it finishes the next day.
function fmtRange(startAt, endAt) {
  const extraDays = daysBetween(startAt.slice(0, 10), endAt.slice(0, 10));
  return `${fmtTime(startAt)}–${fmtTime(endAt)}${extraDays > 0 ? ` (+${extraDays})` : ''}`;
}

module.exports = {
  setTimeZone,
  todayStr,
  nowStr,
  addDays,
  addMonths,
  startOfWeek,
  dayOfWeek,
  monthRange,
  isValidMonth,
  daysBetween,
  isValidDate,
  isValidTime,
  hoursBetween,
  addMinutes,
  buildRange,
  fmtDate,
  fmtMonth,
  fmtDay,
  fmtTime,
  fmtDateTime,
  fmtRange,
};
