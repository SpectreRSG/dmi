// California paid sick leave for W-2 employees (Labor Code 245–249), using
// the limits the law lets an employer set:
// - 1 hour earned for every 30 hours worked
// - earning stops while 80 hours (10 days) are available
// - up to 40 hours (5 days) can be used in a year
// - it can be used from the 90th day of employment
const { round2 } = require('./payroll');
const { addDays } = require('../time');

const HOURS_WORKED_PER_HOUR = 30;
const BALANCE_CAP = 80;
const YEARLY_USE_CAP = 40;
const WAITING_DAYS = 90;

// Hours earned for `hoursWorked`, when `available` hours are already banked.
function earned(hoursWorked, available) {
  return round2(Math.max(0, Math.min(Math.max(0, hoursWorked) / HOURS_WORKED_PER_HOUR, BALANCE_CAP - available)));
}

// The most sick leave that can be paid in a pay run, and why it's limited.
function usable({ available, earnedNow, usedThisYear, startDate, payDate }) {
  if (startDate && payDate < addDays(startDate, WAITING_DAYS - 1)) {
    return { hours: 0, reason: `Paid sick leave can be used from the 90th day of employment (${addDays(startDate, WAITING_DAYS - 1)}).` };
  }
  const yearLeft = Math.max(0, YEARLY_USE_CAP - usedThisYear);
  const banked = Math.max(0, available + earnedNow);
  if (yearLeft < banked) return { hours: round2(yearLeft), reason: `Up to ${YEARLY_USE_CAP} hours can be used a year; ${round2(usedThisYear)} already used.` };
  return { hours: round2(banked), reason: `${round2(banked)} hours available.` };
}

module.exports = { earned, usable, HOURS_WORKED_PER_HOUR, BALANCE_CAP, YEARLY_USE_CAP, WAITING_DAYS };
