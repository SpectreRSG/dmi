// Business days, for tax due dates: a payment due on a weekend or a federal
// legal holiday is due the next business day instead. (California has a few
// extra state holidays; using only the federal ones can show a California
// date a day early, never late.)
const { addDays, dayOfWeek } = require('../time');

const pad = (n) => String(n).padStart(2, '0');

// The nth weekday of a month (weekday 0 = Monday … 6 = Sunday); n = -1 is the last.
function nthWeekday(year, month, weekday, n) {
  if (n > 0) {
    const first = `${year}-${pad(month)}-01`;
    return addDays(first, ((weekday - dayOfWeek(first) + 7) % 7) + (n - 1) * 7);
  }
  const last = addDays(month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`, -1);
  return addDays(last, -((dayOfWeek(last) - weekday + 7) % 7));
}

// A fixed-date holiday on a Saturday is observed on Friday, on a Sunday on Monday.
function observed(date) {
  const dow = dayOfWeek(date);
  if (dow === 5) return addDays(date, -1);
  if (dow === 6) return addDays(date, 1);
  return date;
}

// Federal legal holidays (5 U.S.C. 6103) as observed, for a year.
function federalHolidays(year) {
  return new Set([
    observed(`${year}-01-01`), // New Year's Day
    nthWeekday(year, 1, 0, 3), // Martin Luther King Jr. Day
    nthWeekday(year, 2, 0, 3), // Washington's Birthday
    nthWeekday(year, 5, 0, -1), // Memorial Day
    observed(`${year}-06-19`), // Juneteenth
    observed(`${year}-07-04`), // Independence Day
    nthWeekday(year, 9, 0, 1), // Labor Day
    nthWeekday(year, 10, 0, 2), // Columbus Day
    observed(`${year}-11-11`), // Veterans Day
    nthWeekday(year, 11, 3, 4), // Thanksgiving
    observed(`${year}-12-25`), // Christmas
    observed(`${year + 1}-01-01`), // next New Year's Day, when observed on Dec 31
  ]);
}

function isBusinessDay(date) {
  return dayOfWeek(date) < 5 && !federalHolidays(Number(date.slice(0, 4))).has(date);
}

// The date itself if it's a business day, otherwise the next one.
function businessDayOnOrAfter(date) {
  let day = date;
  while (!isBusinessDay(day)) day = addDays(day, 1);
  return day;
}

module.exports = { federalHolidays, isBusinessDay, businessDayOnOrAfter, nthWeekday };
