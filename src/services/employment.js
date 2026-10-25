// Employment types: how each kind of person is paid and taxed. The type decides
// the rest, so changing it (Staff → Edit) switches everything at once: W-2 or
// 1099, salary or hourly, overtime, paid sick leave, meal and rest breaks, and
// which tax form they fill in. Pay runs follow these rules (paycheck.js).
const { round2 } = require('./payroll');
const { tablesFor, tableYears, PAY_FREQUENCIES } = require('./taxTables');
const time = require('../time');

const TYPES = {
  'Full Time': { taxForm: 'W-2', pay: ['hourly', 'salary'], hint: 'W-2 employee, 40 hours a week, paid by the hour or a salary.' },
  'Part Time Regular': { taxForm: 'W-2', pay: ['salary'], hint: 'W-2 employee with a regular part-time schedule, paid the same amount each pay day.' },
  'Part Time Hourly': { taxForm: 'W-2', pay: ['hourly'], hint: 'W-2 employee paid for the hours they work.' },
  Contractor: { taxForm: '1099', pay: ['hourly'], hint: '1099 independent contractor, paid the agreed rate for every hour.' },
};
const TYPE_NAMES = Object.keys(TYPES);
const FULL_TIME_HOURS = 40;
const WEEKS_PER_YEAR = 52;

// What applies to this person.
function rulesFor(e) {
  const employee = e.tax_form === 'W-2';
  const salaried = employee && e.pay_basis === 'salary';
  const exempt = salaried && Boolean(e.overtime_exempt);
  return { employee, salaried, exempt, overtime: employee && !exempt, sickLeave: employee, breaks: employee && !exempt, taxPaper: employee ? 'W-4 and DE 4' : 'W-9' };
}

// The hours a week a salary is for.
const hoursPerWeek = (e) => (e.employment_type === 'Part Time Regular' ? Number(e.weekly_hours) || FULL_TIME_HOURS : FULL_TIME_HOURS);

// A salaried person's regular hourly rate (for overtime, extra hours and break
// premiums): the weekly salary over the hours it's for. Full time, that's
// 1/40 of the weekly salary (Labor Code 515(d)).
const regularRate = (e) => round2((Number(e.annual_salary) || 0) / WEEKS_PER_YEAR / hoursPerWeek(e));
const rateOf = (e) => (rulesFor(e).salaried ? regularRate(e) : Number(e.hourly_rate) || 0);

// California's minimum wage for a year (the latest year DMI knows, if it's newer).
function minimumWage(year) {
  const known = tableYears().filter((y) => y <= Number(year));
  const tables = tablesFor(known.length ? Math.max(...known) : Math.min(...tableYears()));
  return tables.california.minimumWage;
}

// The lowest salary that can be exempt from overtime: twice the minimum wage, full time.
const exemptMinimum = (year) => round2(2 * minimumWage(year) * FULL_TIME_HOURS * WEEKS_PER_YEAR);

function weekdays(from, to) {
  let n = 0;
  for (let d = from; d <= to; d = time.addDays(d, 1)) if (time.dayOfWeek(d) < 5) n += 1;
  return n;
}

// How much of a pay period someone was employed, by weekdays (for a first or last paycheck).
function employedShare({ periodStart, periodEnd, startDate, endDate }) {
  const from = startDate && startDate > periodStart ? startDate : periodStart;
  const to = endDate && endDate < periodEnd ? endDate : periodEnd;
  if (from > to) return 0;
  const all = weekdays(periodStart, periodEnd);
  return all ? weekdays(from, to) / all : 1;
}

const shareOf = (employee, run) => employedShare({ periodStart: run.period_start, periodEnd: run.period_end, startDate: employee.start_date, endDate: employee.end_date });

// The hours a salary is for in a pay run's period.
function scheduledHours(employee, run) {
  const weeks = (time.daysBetween(run.period_start, run.period_end) + 1) / 7;
  return round2(hoursPerWeek(employee) * weeks * shareOf(employee, run));
}

// The salary part of a pay line. `hours` comes from calculatePayLine at the
// regular rate; the salary takes the place of pay for the regular hours. Part
// Time Regular staff also get hours past their schedule (not overtime) on top.
function salaryLine(hours, { employee, run, periods }) {
  const salary = round2(((Number(employee.annual_salary) || 0) / periods) * shareOf(employee, run));
  const scheduled = scheduledHours(employee, run);
  const extra = employee.employment_type === 'Part Time Regular' ? round2(Math.max(0, hours.regular_hours - scheduled)) : 0;
  return { ...hours, salary_pay: salary, extra_hours: extra, regular_pay: round2(extra * hours.hourly_rate), scheduled_hours: scheduled };
}

// ---- The staff form ------------------------------------------------------------------

const PAY_KEYS = ['employment_type', 'tax_form', 'pay_basis', 'hourly_rate', 'annual_salary', 'weekly_hours', 'overtime_exempt'];
const MEAL_KEYS = ['meal_agreement_on', 'meal_waiver_on'];

const number = (value) => (value === undefined || value === null || String(value).trim() === '' ? 0 : Number(String(value).replace(/[$,\s]/g, '')));
const dollars = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Reads the pay part of the staff form (admins only). Fields for the other pay
// basis are kept as they were, so switching back finds them again.
function readPayFields(body, existing = {}, year = time.todayStr().slice(0, 4)) {
  const type = TYPES[body.employment_type] ? body.employment_type : null;
  const v = {
    employment_type: type,
    tax_form: type ? TYPES[type].taxForm : null,
    pay_basis: type ? (TYPES[type].pay.includes(body.pay_basis) ? body.pay_basis : TYPES[type].pay[0]) : null,
    hourly_rate: body.hourly_rate === undefined ? Number(existing.hourly_rate) || 0 : number(body.hourly_rate),
    annual_salary: body.annual_salary === undefined ? Number(existing.annual_salary) || 0 : number(body.annual_salary),
    weekly_hours: type === 'Part Time Regular' ? number(body.weekly_hours ?? existing.weekly_hours) : FULL_TIME_HOURS,
    overtime_exempt: 0,
    meal_agreement_on: String(body.meal_agreement_on || '').trim() || null,
    meal_waiver_on: String(body.meal_waiver_on || '').trim() || null,
  };
  v.overtime_exempt = type === 'Full Time' && v.pay_basis === 'salary' && body.overtime_exempt ? 1 : 0;
  const min = minimumWage(year);
  let error = null;
  if (!type) error = 'Choose an employment type.';
  else if (Number.isNaN(v.hourly_rate) || v.hourly_rate < 0) error = 'The hourly rate must be a number (0 or more).';
  else if (Number.isNaN(v.annual_salary) || v.annual_salary < 0) error = 'The salary must be a number (0 or more).';
  else if (type === 'Part Time Regular' && !(v.weekly_hours >= 1 && v.weekly_hours < FULL_TIME_HOURS)) {
    error = 'Enter the hours a week their salary is for (less than 40: 40 is Full Time).';
  } else if (v.pay_basis === 'salary' && !(v.annual_salary > 0)) error = 'Enter their yearly salary.';
  else if (v.overtime_exempt && v.annual_salary < exemptMinimum(year)) {
    error = `To be exempt from overtime in California, a salary must be at least ${dollars(exemptMinimum(year))} a year in ${year} (twice the state minimum wage, full time). Raise the salary or untick "exempt".`;
  } else if (v.tax_form === 'W-2' && v.pay_basis === 'hourly' && v.hourly_rate > 0 && v.hourly_rate < min) {
    error = `California's minimum wage is ${dollars(min)} an hour in ${year} (some cities are higher).`;
  } else if (v.pay_basis === 'salary' && regularRate(v) < min) {
    error = `That salary works out to ${dollars(regularRate(v))} an hour, under California's minimum wage of ${dollars(min)} (some cities are higher).`;
  } else if (MEAL_KEYS.some((k) => v[k] && !time.isValidDate(v[k]))) error = 'Please use the date pickers for the meal break dates.';
  return { values: v, error };
}

// What changed in how someone is paid, or null.
function payChange(before, after) {
  const pick = (e) => Object.fromEntries(PAY_KEYS.map((k) => [k, k === 'employment_type' || k === 'tax_form' || k === 'pay_basis' ? e[k] ?? null : Number(e[k]) || 0]));
  const was = pick(before);
  const now = pick(after);
  return PAY_KEYS.some((k) => was[k] !== now[k]) ? { before: was, after: now } : null;
}

// ---- In plain words ----------------------------------------------------------------

// How this person is paid and taxed, one sentence each (the staff page and the change notice).
function describe(e, settings, year = time.todayStr().slice(0, 4)) {
  const rules = rulesFor(e);
  const rate = dollars(rateOf(e));
  if (!rules.employee) {
    return [
      `1099 independent contractor, paid ${rate} an hour for every hour: no overtime.`,
      'No taxes are taken out. They get a 1099-NEC each January.',
      'No paid sick leave or meal and rest break rules: those are for employees.',
      'Needs a W-9 on file.',
    ];
  }
  const frequency = PAY_FREQUENCIES[settings.pay_frequency] || PAY_FREQUENCIES.biweekly;
  const overtimeWhen = settings.daily_overtime === 'california'
    ? 'for hours over 8 a day and 40 a week'
    : `for hours over ${settings.overtime_weekly_hours} a week`;
  const lines = [];
  if (rules.salaried) {
    lines.push(`W-2 employee paid a salary of ${dollars(e.annual_salary)} a year: ${dollars(round2(e.annual_salary / frequency.periods))} each pay day (${frequency.label.toLowerCase()}), for ${hoursPerWeek(e)} hours a week.`);
  } else {
    lines.push(`W-2 employee paid ${rate} an hour.`);
  }
  lines.push('Federal and California income tax, Social Security, Medicare and SDI come out of each paycheck.');
  if (rules.exempt) {
    lines.push(`Exempt from overtime: the salary is at least ${dollars(exemptMinimum(year))}, and their job duties must qualify too (check with your accountant or lawyer).`);
  } else if (rules.salaried) {
    lines.push(`Overtime ${overtimeWhen}, at ${rate} an hour (their salary's hourly rate) × ${settings.overtime_multiplier}.`);
    if (e.employment_type === 'Part Time Regular') lines.push(`Hours past their regular ${hoursPerWeek(e)} a week (but not overtime) are paid on top at ${rate}.`);
  } else {
    lines.push(`Overtime ${overtimeWhen}, at × ${settings.overtime_multiplier}.`);
  }
  lines.push(rules.exempt ? 'Earns paid sick leave as if working 40 hours a week.' : 'Earns paid sick leave: 1 hour for every 30 worked.');
  if (!rules.breaks) lines.push("Meal and rest break rules don't apply (exempt from overtime).");
  else if (e.meal_agreement_on) lines.push(`Meal and rest breaks: California rules. Eats at their post under an on-duty meal agreement signed ${time.fmtDate(e.meal_agreement_on)}.`);
  else lines.push('Meal and rest breaks: California rules (an unpaid 30-minute meal break before the 5th hour, paid 10-minute rest breaks).');
  lines.push('Needs a W-4 and DE 4 on file.');
  return lines;
}

// One line for the pay history: "Contractor → Part Time Hourly; $30.00 → $32.00 an hour".
function changeSummary(before, after) {
  const payOf = (e) => (e.pay_basis === 'salary' ? `${dollars(e.annual_salary)} a year` : `${dollars(e.hourly_rate)} an hour`);
  if (!before.employment_type) return `Started as ${after.employment_type}, ${payOf(after)}${after.overtime_exempt ? ', exempt from overtime' : ''}`;
  const parts = [];
  if (before.employment_type !== after.employment_type) parts.push(`${before.employment_type} → ${after.employment_type}`);
  if (payOf(before) !== payOf(after)) parts.push(`${payOf(before)} → ${payOf(after)}`);
  if (after.employment_type === 'Part Time Regular' && before.weekly_hours !== after.weekly_hours) parts.push(`${after.weekly_hours} hours a week`);
  if (before.overtime_exempt !== after.overtime_exempt) parts.push(after.overtime_exempt ? 'now exempt from overtime' : 'no longer exempt from overtime');
  return parts.join('; ') || 'No change';
}

module.exports = {
  TYPES,
  TYPE_NAMES,
  FULL_TIME_HOURS,
  PAY_KEYS,
  rulesFor,
  hoursPerWeek,
  regularRate,
  rateOf,
  minimumWage,
  exemptMinimum,
  employedShare,
  scheduledHours,
  salaryLine,
  readPayFields,
  payChange,
  describe,
  changeSummary,
  dollars,
};
