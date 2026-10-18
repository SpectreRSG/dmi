// Pay calculations. These functions only do maths (no database), which makes
// them easy to test: see tests/payroll.test.js.
const { hoursBetween, startOfWeek } = require('../time');

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function entryHours(entry) {
  return hoursBetween(entry.start_at, entry.end_at, entry.break_minutes);
}

// Splits someone's worked hours into regular and overtime hours.
// Overtime is counted per week (Monday to Sunday): any hours above the weekly
// limit in that week are overtime. A limit of 0 means "no overtime".
function splitHours(entries, weeklyLimit) {
  const hoursPerWeek = new Map();
  for (const entry of entries) {
    const week = startOfWeek(entry.start_at.slice(0, 10));
    hoursPerWeek.set(week, (hoursPerWeek.get(week) || 0) + entryHours(entry));
  }

  let regular = 0;
  let overtime = 0;
  for (const hours of hoursPerWeek.values()) {
    if (weeklyLimit > 0 && hours > weeklyLimit) {
      regular += weeklyLimit;
      overtime += hours - weeklyLimit;
    } else {
      regular += hours;
    }
  }
  return { regular: round2(regular), overtime: round2(overtime) };
}

// Works out one person's pay for a pay run.
function calculatePayLine({ entries, hourlyRate, weeklyLimit, multiplier, adjustment = 0 }) {
  const { regular, overtime } = splitHours(entries, weeklyLimit);
  const regularPay = round2(regular * hourlyRate);
  const overtimePay = round2(overtime * hourlyRate * multiplier);
  return {
    regular_hours: regular,
    overtime_hours: overtime,
    hourly_rate: hourlyRate,
    overtime_multiplier: multiplier,
    regular_pay: regularPay,
    overtime_pay: overtimePay,
    adjustment: round2(adjustment),
    gross_pay: round2(regularPay + overtimePay + adjustment),
  };
}

module.exports = { round2, entryHours, splitHours, calculatePayLine };
