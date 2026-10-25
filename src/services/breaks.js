// California meal and rest breaks (Labor Code 512 and 226.7, IWC Wage Order 4),
// for W-2 employees who aren't exempt from overtime. Only maths here: see
// tests/breaks.test.js.
//
// Meal breaks: 30 minutes, unpaid and off duty, before the end of the 5th hour
// worked, and a second one before the end of the 10th. Someone who signed a
// waiver can skip the first on days of 6 hours or less, and the second on days
// of 12 hours or less. Where the job means a guard can't leave the post, a
// signed on-duty meal agreement lets them eat at the post, paid.
// Rest breaks: 10 minutes, paid, for every 4 hours worked or "major fraction"
// (none under 3.5 hours; 1 up to 6 hours; 2 up to 10; 3 up to 14 ...).
// A workday with a missed (or short, or late) meal break earns one extra hour
// of pay at the regular rate; a missed rest break, another. At most one of each a day.
const { entryHours, round2 } = require('./payroll');
const { addDays, minutesSinceEpoch } = require('../time');

const MEAL_MINUTES = 30;

function mealsNeeded(hours, { waiver = false } = {}) {
  if (hours > 10) return waiver && hours <= 12 ? 1 : 2;
  if (hours > 5) return waiver && hours <= 6 ? 0 : 1;
  return 0;
}

const restsNeeded = (hours) => (hours < 3.5 ? 0 : Math.ceil((hours - 2) / 4 - 1e-9));

// The workday a shift belongs to: the 24 hours from the workday start time
// (Settings), so a night shift counts on the day it started.
function workdayOf(startAt, workdayStart = '00:00') {
  const date = startAt.slice(0, 10);
  return startAt.slice(11, 16) < workdayStart ? addDays(date, -1) : date;
}

// The break premiums someone earned for these hours. Time off the clock
// between two entries on the same workday counts as an unpaid break.
// `onDutyMeals`: a signed on-duty meal agreement; `waiver`: a signed meal waiver.
// Returns { meal, rest, days: [{ date, hours, unpaidMinutes, meals, rests, missedMeal, missedRest, why }] }.
function premiums(entries, { onDutyMeals = false, waiver = false, workdayStart = '00:00' } = {}) {
  const byDay = new Map();
  for (const e of [...entries].sort((a, b) => a.start_at.localeCompare(b.start_at))) {
    const date = workdayOf(e.start_at, workdayStart);
    const day = byDay.get(date) || { date, hours: 0, unpaidMinutes: 0, reportedMeal: false, reportedRest: false, lastEnd: null };
    day.hours += entryHours(e);
    day.unpaidMinutes += Number(e.break_minutes) || 0;
    if (day.lastEnd && e.start_at > day.lastEnd) day.unpaidMinutes += minutesSinceEpoch(e.start_at) - minutesSinceEpoch(day.lastEnd);
    day.lastEnd = day.lastEnd && day.lastEnd > e.end_at ? day.lastEnd : e.end_at;
    day.reportedMeal ||= Boolean(e.missed_meal);
    day.reportedRest ||= Boolean(e.missed_rest);
    byDay.set(date, day);
  }
  const days = [];
  for (const day of [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const hours = round2(day.hours);
    const meals = mealsNeeded(hours, { waiver });
    const rests = restsNeeded(hours);
    const why = [];
    let missedMeal = false;
    if (meals && day.reportedMeal) {
      missedMeal = true;
      why.push('meal break marked as missed');
    } else if (meals && !onDutyMeals && day.unpaidMinutes < meals * MEAL_MINUTES) {
      missedMeal = true;
      why.push(`${hours} hours worked needs ${meals * MEAL_MINUTES} minutes of meal breaks; ${day.unpaidMinutes} recorded`);
    }
    const missedRest = rests > 0 && day.reportedRest;
    if (missedRest) why.push('rest break marked as missed');
    days.push({ date: day.date, hours, unpaidMinutes: day.unpaidMinutes, meals, rests, missedMeal, missedRest, why });
  }
  return { meal: days.filter((d) => d.missedMeal).length, rest: days.filter((d) => d.missedRest).length, days };
}

module.exports = { mealsNeeded, restsNeeded, workdayOf, premiums, MEAL_MINUTES };
