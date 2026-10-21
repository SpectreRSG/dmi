// Pay calculations. These functions only do maths (no database), which makes
// them easy to test: see tests/payroll.test.js.
const { hoursBetween, startOfWeek, minutesSinceEpoch, addDays } = require('../time');

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function entryHours(entry) {
  return hoursBetween(entry.start_at, entry.end_at, entry.break_minutes);
}

// The overtime rules from the company settings (see settings.js).
// California (daily_overtime = 'california') adds the daily rules to the weekly one:
// over 8 hours in a workday pays the overtime rate, over 12 pays double, and
// on the 7th day in a row in a workweek the first 8 hours are overtime and the
// rest double. Weekly overtime then only counts the remaining regular hours.
function overtimeRules(settings) {
  return {
    weeklyLimit: Number(settings.overtime_weekly_hours) || 0,
    multiplier: Number(settings.overtime_multiplier) || 1,
    daily: settings.daily_overtime === 'california',
    workdayStart: settings.workday_start || '00:00',
  };
}

const DAILY_REGULAR = 8; // hours in a workday before overtime (California)
const DAILY_DOUBLE = 12; // hours in a workday before double time
const DOUBLE_TIME = 2;

// Hours worked in each workday ('2026-10-19' -> 9.5). A workday is the 24 hours
// from workdayStart ('00:00' = midnight to midnight), so a night shift that
// crosses it counts partly in each. An unpaid break comes off the first part.
function hoursByWorkday(entries, workdayStart = '00:00') {
  const [h, m] = workdayStart.split(':').map(Number);
  const offset = (h || 0) * 60 + (m || 0);
  const days = new Map();
  for (const entry of entries) {
    let at = minutesSinceEpoch(entry.start_at);
    const end = minutesSinceEpoch(entry.end_at);
    let breakLeft = Number(entry.break_minutes) || 0;
    while (at < end) {
      const day = Math.floor((at - offset) / 1440);
      const partEnd = Math.min(end, day * 1440 + offset + 1440);
      let minutes = partEnd - at;
      const unpaid = Math.min(breakLeft, minutes);
      minutes -= unpaid;
      breakLeft -= unpaid;
      const date = addDays('1970-01-01', day);
      days.set(date, (days.get(date) || 0) + minutes / 60);
      at = partEnd;
    }
  }
  return days;
}

// Hours on each day by the date the work started (weekly overtime only).
function hoursByStartDate(entries) {
  const days = new Map();
  for (const entry of entries) {
    const date = entry.start_at.slice(0, 10);
    days.set(date, (days.get(date) || 0) + entryHours(entry));
  }
  return days;
}

// Splits someone's worked hours into regular, overtime and double-time hours.
// Weekly overtime is counted per week (Monday to Sunday): hours above the
// weekly limit that week are overtime (a limit of 0 means no weekly overtime).
// With the California daily rules, see overtimeRules above.
// `earlier`: hours already paid earlier in the same weeks (a pay run can start
// mid-week). They count towards the week's totals but aren't paid again.
function splitHours(entries, { weeklyLimit = 0, daily = false, workdayStart = '00:00' } = {}, earlier = []) {
  const perDay = (list) => (daily ? hoursByWorkday(list, workdayStart) : hoursByStartDate(list));
  const paying = perDay(entries);
  const before = perDay(earlier);
  const weeks = new Map(); // Monday -> dates worked that week
  for (const date of new Set([...paying.keys(), ...before.keys()])) {
    const total = (paying.get(date) || 0) + (before.get(date) || 0);
    if (total <= 0) continue;
    const week = startOfWeek(date);
    if (!weeks.has(week)) weeks.set(week, []);
    weeks.get(week).push(date);
  }

  let regular = 0;
  let overtime = 0;
  let doubleTime = 0;
  for (const dates of weeks.values()) {
    dates.sort();
    const everyDay = daily && dates.length === 7; // worked all seven days of the workweek
    let weekRegular = 0;
    dates.forEach((date, i) => {
      const hours = (paying.get(date) || 0) + (before.get(date) || 0);
      let reg = hours;
      let ot = 0;
      let dt = 0;
      if (everyDay && i === 6) {
        reg = 0;
        ot = Math.min(hours, DAILY_REGULAR);
        dt = Math.max(0, hours - DAILY_REGULAR);
      } else {
        if (daily) {
          reg = Math.min(hours, DAILY_REGULAR);
          ot = Math.min(Math.max(0, hours - DAILY_REGULAR), DAILY_DOUBLE - DAILY_REGULAR);
          dt = Math.max(0, hours - DAILY_DOUBLE);
        }
        if (weeklyLimit > 0 && weekRegular + reg > weeklyLimit) {
          const over = weekRegular + reg - weeklyLimit;
          reg -= over;
          ot += over;
        }
        weekRegular += reg;
      }
      // Only this pay run's share of the day is paid now.
      const share = (paying.get(date) || 0) / hours;
      regular += reg * share;
      overtime += ot * share;
      doubleTime += dt * share;
    });
  }
  return { regular: round2(regular), overtime: round2(overtime), doubleTime: round2(doubleTime) };
}

// Works out one person's pay for a pay run. `rules` comes from overtimeRules();
// `earlier` is the hours already paid earlier in the same weeks (see splitHours).
function calculatePayLine({ entries, earlier = [], hourlyRate, rules, adjustment = 0 }) {
  const { regular, overtime, doubleTime } = splitHours(entries, rules, earlier);
  const regularPay = round2(regular * hourlyRate);
  const overtimePay = round2(overtime * hourlyRate * rules.multiplier);
  const doubleTimePay = round2(doubleTime * hourlyRate * DOUBLE_TIME);
  return {
    regular_hours: regular,
    overtime_hours: overtime,
    double_time_hours: doubleTime,
    hourly_rate: hourlyRate,
    overtime_multiplier: rules.multiplier,
    regular_pay: regularPay,
    overtime_pay: overtimePay,
    double_time_pay: doubleTimePay,
    adjustment: round2(adjustment),
    gross_pay: round2(regularPay + overtimePay + doubleTimePay + adjustment),
  };
}

module.exports = { round2, entryHours, overtimeRules, hoursByWorkday, splitHours, calculatePayLine, DOUBLE_TIME };
