// Everything a pay stub shows, for the office's and the officer's copies.
// For W-2 employees it covers what California requires on every pay stub
// (Labor Code 226): the employer's legal name and address, the last 4 digits
// of the Social Security number, the pay period, hours at each rate, gross
// pay, every deduction, net pay, and the paid sick leave available.
const db = require('../db');
const { round2, entryHours } = require('./payroll');
const { payDateOf } = require('./paycheck');
const { EMPLOYEE_TAXES } = require('./withholding');

const YTD_FIELDS = [
  'regular_hours', 'overtime_hours', 'double_time_hours', 'sick_hours', 'salary_pay', 'regular_pay', 'overtime_pay', 'double_time_pay', 'break_pay', 'sick_pay',
  'adjustment', 'gross_pay', ...EMPLOYEE_TAXES, 'deduction', 'net_pay',
];

const PAY_DATE = 'COALESCE(p.paid_on, substr(p.finalized_at, 1, 10))';

// Totals for the year so far, up to and including this pay line (finalized
// pay runs in the same year, by pay date; a draft counts itself too).
async function yearToDateThrough(run, item) {
  const payDate = payDateOf(run);
  const rows = await db.all(
    `SELECT i.* FROM pay_run_items i JOIN pay_runs p ON p.id = i.pay_run_id
     WHERE i.employee_id = ? AND i.tax_form = ? AND p.status = 'finalized' AND substr(${PAY_DATE}, 1, 4) = ?
       AND (${PAY_DATE} < ? OR (${PAY_DATE} = ? AND p.id <= ?))`,
    item.employee_id, item.tax_form, payDate.slice(0, 4), payDate, payDate, run.id
  );
  if (run.status !== 'finalized') rows.push(item);
  return Object.fromEntries(YTD_FIELDS.map((f) => [f, round2(rows.reduce((sum, r) => sum + (Number(r[f]) || 0), 0))]));
}

// The employer, as registered (Company tax details in Settings).
function employerOf(settings) {
  const cityLine = [settings.payer_city, [settings.payer_state, settings.payer_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return { name: settings.payer_name || settings.company_name, lines: [settings.payer_address, cityLine].filter(Boolean) };
}

async function payslipData(run, item, settings) {
  const [entries, profile, ytd] = await Promise.all([
    db.all(
      `SELECT t.*, si.name AS site_name FROM time_entries t LEFT JOIN sites si ON si.id = t.site_id
       WHERE t.pay_run_id = ? AND t.employee_id = ? ORDER BY t.start_at`,
      run.id,
      item.employee_id
    ),
    db.get('SELECT ssn_last4 FROM withholding_profiles WHERE employee_id = ?', item.employee_id),
    yearToDateThrough(run, item),
  ]);
  for (const entry of entries) entry.hours = round2(entryHours(entry));
  return {
    run,
    item,
    entries,
    ytd,
    payDate: payDateOf(run),
    employer: employerOf(settings),
    // Last 4 of the SSN if we have it; otherwise their employee number (both are allowed).
    employeeId: profile ? `SSN ending ${profile.ssn_last4}` : `Employee no. DMI-${item.employee_id}`,
    w2: item.tax_form === 'W-2',
  };
}

module.exports = { payslipData, yearToDateThrough, employerOf };
