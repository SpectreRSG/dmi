// From gross pay to net pay for one pay line: paid sick leave, taxes for W-2
// employees, backup withholding for 1099 contractors who need it, and other
// deductions. Used by pay runs (routes/pay.js).
const time = require('../time');
const { round2 } = require('./payroll');
const { tablesFor, PAY_FREQUENCIES } = require('./taxTables');
const { payrollTaxes, EMPLOYEE_TAXES, EMPLOYER_TAXES, sumOf } = require('./withholding');
const sick = require('./sickLeave');

// Independent contractors aren't covered by overtime law: they get their agreed
// rate for every hour.
const STRAIGHT_TIME = { weeklyLimit: 0, multiplier: 1, daily: false, workdayStart: '00:00' };

// The pay date decides which year's tax tables and limits apply. A draft uses
// the date chosen for it, or today.
const payDateOf = (run) => run.paid_on || time.todayStr();

const periodsPerYear = (settings) => (PAY_FREQUENCIES[settings.pay_frequency] || PAY_FREQUENCIES.biweekly).periods;

function employerRates(settings) {
  return {
    uiRate: (Number(settings.ca_ui_rate) || 0) / 100,
    ettRate: (Number(settings.ca_ett_rate) || 0) / 100,
    futaCreditReduction: (Number(settings.futa_credit_reduction) || 0) / 100,
  };
}

const NO_TAXES = Object.fromEntries([...EMPLOYEE_TAXES, ...EMPLOYER_TAXES, 'ss_wages', 'futa_wages', 'ui_wages'].map((k) => [k, 0]));

const FINALIZED_SAME_EMPLOYEE = `FROM pay_run_items i JOIN pay_runs p ON p.id = i.pay_run_id
  WHERE i.employee_id = ? AND p.status = 'finalized' AND p.id <> ?`;
const PAY_YEAR = "substr(COALESCE(p.paid_on, p.finalized_at), 1, 4)";

// Earlier W-2 paychecks this year (finalized pay runs other than this one).
async function yearToDate(tx, employeeId, year, runId) {
  const row = await tx.get(
    `SELECT COALESCE(SUM(i.gross_pay), 0) AS wages, COALESCE(SUM(i.ss_wages), 0) AS ss, COALESCE(SUM(i.futa_wages), 0) AS futa,
       COALESCE(SUM(i.ui_wages), 0) AS ui, COALESCE(SUM(i.sick_hours), 0) AS sick_used
     ${FINALIZED_SAME_EMPLOYEE} AND i.tax_form = 'W-2' AND ${PAY_YEAR} = ?`,
    employeeId, runId, String(year)
  );
  return { wages: row.wages, socialSecurityWages: row.ss, futaWages: row.futa, uiWages: row.ui, sickUsed: row.sick_used };
}

// Paid sick leave banked before this pay run.
async function sickAvailable(tx, employeeId, runId) {
  const row = await tx.get(`SELECT COALESCE(SUM(i.sick_accrued - i.sick_hours), 0) AS hours ${FINALIZED_SAME_EMPLOYEE}`, employeeId, runId);
  return round2(row.hours);
}

// Paid sick leave for a W-2 pay line: what's earned, what can be used, and the
// balance after. `wanted`: the hours the office entered.
async function sickLeaveFor(tx, { employee, run, hoursWorked, wanted, ytd }) {
  const available = await sickAvailable(tx, employee.id, run.id);
  const earnedNow = sick.earned(hoursWorked, available);
  const limit = sick.usable({ available, earnedNow, usedThisYear: ytd.sickUsed, startDate: employee.start_date, payDate: payDateOf(run) });
  const used = round2(Math.min(Math.max(0, Number(wanted) || 0), limit.hours));
  return { available, earnedNow, limit, used, balance: round2(available + earnedNow - used) };
}

// The whole pay line, ready to save. `hours`: the hours and pay from
// calculatePayLine; `inputs`: what the office typed in (adjustment, sick
// hours, deduction and their notes).
async function completeLine(tx, { run, employee, hours, inputs = {}, settings }) {
  const w2 = employee.tax_form === 'W-2';
  const payDate = payDateOf(run);
  const year = Number(payDate.slice(0, 4));
  const tables = tablesFor(year);
  const ytd = await yearToDate(tx, employee.id, year, run.id);
  const hoursWorked = (hours.regular_hours || 0) + (hours.overtime_hours || 0) + (hours.double_time_hours || 0);

  const leave = w2
    ? await sickLeaveFor(tx, { employee, run, hoursWorked, wanted: inputs.sick_hours, ytd })
    : { used: 0, earnedNow: 0, balance: 0, limit: null };
  const sickPay = round2(leave.used * hours.hourly_rate);
  const adjustment = round2(Number(inputs.adjustment) || 0);
  const gross = round2(hours.regular_pay + hours.overtime_pay + hours.double_time_pay + sickPay + adjustment);

  let taxes = { ...NO_TAXES };
  if (w2 && tables) {
    const profile = await tx.get('SELECT * FROM withholding_profiles WHERE employee_id = ?', employee.id);
    taxes = payrollTaxes({ wages: gross, periods: periodsPerYear(settings), profile, ytd, tables, employer: employerRates(settings) });
  } else if (!w2 && tables && gross > 0) {
    const w9 = await tx.get('SELECT backup_withholding FROM tax_profiles WHERE employee_id = ?', employee.id);
    if (w9?.backup_withholding) taxes.fed_income_tax = round2(gross * tables.federal.backupWithholdingRate);
  }
  const deduction = round2(Math.max(0, Number(inputs.deduction) || 0));
  return {
    ...hours,
    tax_form: employee.tax_form,
    adjustment,
    adjustment_note: inputs.adjustment_note ?? null,
    sick_hours: leave.used,
    sick_pay: sickPay,
    sick_accrued: leave.earnedNow,
    sick_balance: leave.balance,
    sick_limit: leave.limit, // (not saved) the most sick leave that could be used, and why
    gross_pay: gross,
    ...taxes,
    deduction,
    deduction_note: inputs.deduction_note ?? null,
    net_pay: round2(gross - sumOf(taxes, EMPLOYEE_TAXES) - deduction),
  };
}

const ITEM_COLUMNS = [
  'pay_run_id', 'employee_id', 'tax_form', 'regular_hours', 'overtime_hours', 'double_time_hours', 'hourly_rate', 'overtime_multiplier',
  'regular_pay', 'overtime_pay', 'double_time_pay', 'sick_hours', 'sick_pay', 'sick_accrued', 'sick_balance', 'adjustment', 'adjustment_note',
  'gross_pay', ...EMPLOYEE_TAXES, 'deduction', 'deduction_note', 'net_pay', ...EMPLOYER_TAXES, 'ss_wages', 'futa_wages', 'ui_wages',
];

function insertLine(tx, line) {
  return tx.insert(
    `INSERT INTO pay_run_items (${ITEM_COLUMNS.join(', ')}) VALUES (${ITEM_COLUMNS.map((c) => `@${c}`).join(', ')})`,
    Object.fromEntries(ITEM_COLUMNS.map((c) => [c, line[c] ?? null]))
  );
}

function updateLine(tx, id, line) {
  const columns = ITEM_COLUMNS.filter((c) => !['pay_run_id', 'employee_id'].includes(c));
  return tx.run(
    `UPDATE pay_run_items SET ${columns.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`,
    { id, ...Object.fromEntries(columns.map((c) => [c, line[c] ?? null])) }
  );
}

// What stops a pay run being finalized (an empty list when it's ready).
function finalizeProblems({ run, items, settings }) {
  const problems = [];
  const year = payDateOf(run).slice(0, 4);
  if (items.some((i) => i.tax_form === 'W-2')) {
    if (!tablesFor(year)) problems.push(`DMI doesn't have the ${year} tax tables yet, so W-2 taxes can't be worked out for this pay date.`);
    else if (settings.tax_tables_confirmed !== year) problems.push(`Check the ${year} tax rates once, then confirm them (Pay → Tax rates).`);
    if (['payer_name', 'payer_ein', 'payer_address', 'payer_city', 'payer_state', 'payer_zip'].some((f) => !settings[f])) {
      problems.push('Fill in the company tax details in Settings (legal name, EIN and address): they go on every pay stub.');
    }
  }
  const negative = items.filter((i) => i.net_pay < 0);
  if (negative.length) problems.push(`Net pay can't be below zero (${negative.map((i) => `${i.first_name} ${i.last_name}`).join(', ')}): lower the deduction.`);
  return problems;
}

module.exports = {
  STRAIGHT_TIME,
  payDateOf,
  periodsPerYear,
  employerRates,
  yearToDate,
  sickAvailable,
  sickLeaveFor,
  completeLine,
  insertLine,
  updateLine,
  finalizeProblems,
  ITEM_COLUMNS,
};
