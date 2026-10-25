// The numbers for the payroll tax returns, from finalized pay runs with W-2
// employees (by pay date), laid out by the forms' own line numbers so they can
// be typed straight in:
// - IRS Form 941, each quarter;
// - EDD DE 9 (contributions) and DE 9C (each employee's wages), each quarter;
// - IRS Form 940 (federal unemployment), each year.
// The office (or the accountant) files them; DMI prepares them.
const db = require('../db');
const { round2 } = require('./payroll');
const { tablesFor } = require('./taxTables');
const { obligations } = require('./taxDeposits');

const PAY_DATE = 'COALESCE(p.paid_on, substr(p.finalized_at, 1, 10))';
const pad = (n) => String(n).padStart(2, '0');

function quarterRange(year, quarter) {
  const lastMonth = quarter * 3;
  const nextFirst = lastMonth === 12 ? `${year + 1}-01-01` : `${year}-${pad(lastMonth + 1)}-01`;
  const last = new Date(Date.parse(`${nextFirst}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return { from: `${year}-${pad(lastMonth - 2)}-01`, to: last, months: [lastMonth - 2, lastMonth - 1, lastMonth] };
}

// Finalized W-2 pay lines with a pay date in the range, with who they're for.
function w2Lines(from, to) {
  return db.all(
    `SELECT i.*, ${PAY_DATE} AS pay_date, p.period_start, p.period_end, e.first_name, e.last_name
     FROM pay_run_items i JOIN pay_runs p ON p.id = i.pay_run_id JOIN employees e ON e.id = i.employee_id
     WHERE p.status = 'finalized' AND i.tax_form = 'W-2' AND ${PAY_DATE} BETWEEN ? AND ?
     ORDER BY ${PAY_DATE}, e.last_name, e.first_name`,
    from,
    to
  );
}

// W-2 employees paid for a pay period that includes this date (941 line 1, DE 9C counts).
async function employeesPaidFor(date) {
  const row = await db.get(
    `SELECT COUNT(DISTINCT i.employee_id)::int AS n FROM pay_run_items i JOIN pay_runs p ON p.id = i.pay_run_id
     WHERE p.status = 'finalized' AND i.tax_form = 'W-2' AND p.period_start <= ? AND p.period_end >= ?`,
    date,
    date
  );
  return row.n;
}

const sum = (rows, field) => round2(rows.reduce((s, r) => s + (Number(r[field]) || 0), 0));

// Payments recorded against the deposits for these pay dates.
async function depositsFor(year, kinds, inRange) {
  const settings = await require('../settings').getSettings();
  const list = (await obligations(year, settings)).filter((o) => kinds.includes(o.kind) && o.payDates.some(inRange));
  return round2(list.reduce((s, o) => s + o.paidAmount, 0));
}

async function quarterReport(year, quarter, settings) {
  const { from, to, months } = quarterRange(year, quarter);
  const lines = await w2Lines(from, to);
  const tables = tablesFor(year);
  const inQuarter = (d) => d >= from && d <= to;

  // ---- Form 941 ----------------------------------------------------------------
  const wages = sum(lines, 'gross_pay');
  const ssWages = sum(lines, 'ss_wages');
  const addlRate = tables?.fica.additionalMedicareRate || 0.009;
  const addlWages = round2(sum(lines, 'additional_medicare') / addlRate);
  const line5a = round2(ssWages * 0.124);
  const line5c = round2(wages * 0.029);
  const line5d = round2(addlWages * addlRate);
  const line5e = round2(line5a + line5c + line5d);
  const line3 = sum(lines, 'fed_income_tax');
  const actualFica = round2(['social_security', 'employer_social_security', 'medicare', 'employer_medicare', 'additional_medicare']
    .reduce((s, f) => s + sum(lines, f), 0));
  const line7 = round2(actualFica - line5e); // fractions of cents
  const line10 = round2(line3 + line5e + line7);
  const line13 = await depositsFor(year, ['federal'], inQuarter);
  const liabilityOf = (rows) => round2(rows.reduce((s, r) => s + r.fed_income_tax + r.social_security + r.employer_social_security
    + r.medicare + r.employer_medicare + r.additional_medicare, 0));
  const byMonth = months.map((m) => liabilityOf(lines.filter((l) => Number(l.pay_date.slice(5, 7)) === m)));
  const byPayDate = [...new Set(lines.map((l) => l.pay_date))].map((d) => ({ date: d, amount: liabilityOf(lines.filter((l) => l.pay_date === d)) }));
  const twelfth = (m) => `${year}-${pad(m)}-12`;
  const f941 = {
    line1: await employeesPaidFor(twelfth(months[2])),
    line2: wages,
    line3,
    line5a: { wages: ssWages, tax: line5a },
    line5c: { wages, tax: line5c },
    line5d: { wages: addlWages, tax: line5d },
    line5e,
    line6: round2(line3 + line5e),
    line7,
    line10,
    line12: line10,
    line13,
    line14: round2(Math.max(0, line10 - line13)),
    line15: round2(Math.max(0, line13 - line10)),
    byMonth,
    byPayDate, // Schedule B, for semiweekly depositors
  };

  // ---- DE 9 ---------------------------------------------------------------------
  const ui = sum(lines, 'ca_ui');
  const ett = sum(lines, 'ca_ett');
  const sdi = sum(lines, 'ca_sdi');
  const pit = sum(lines, 'ca_income_tax');
  const subtotal = round2(ui + ett + sdi + pit);
  const caPaid = await depositsFor(year, ['california', 'ca_ui'], inQuarter);
  const de9 = {
    subjectWages: wages,
    uiWages: sum(lines, 'ui_wages'),
    uiRate: settings.ca_ui_rate,
    ui,
    ettRate: settings.ca_ett_rate,
    ett,
    sdiWages: wages,
    sdi,
    pit,
    subtotal,
    paid: caPaid,
    due: round2(Math.max(0, subtotal - caPaid)),
  };

  // ---- DE 9C ----------------------------------------------------------------------
  const people = new Map();
  for (const l of lines) {
    if (!people.has(l.employee_id)) people.set(l.employee_id, { employee_id: l.employee_id, first_name: l.first_name, last_name: l.last_name, wages: 0, pit: 0 });
    const p = people.get(l.employee_id);
    p.wages = round2(p.wages + l.gross_pay);
    p.pit = round2(p.pit + l.ca_income_tax);
  }
  const profiles = new Map((await db.all('SELECT employee_id, ssn_last4 FROM withholding_profiles')).map((r) => [r.employee_id, r.ssn_last4]));
  const de9c = {
    counts: await Promise.all(months.map((m) => employeesPaidFor(twelfth(m)))),
    employees: [...people.values()].map((p) => ({ ...p, ssnLast4: profiles.get(p.employee_id) || null })),
  };

  return { year, quarter, from, to, months, payDates: byPayDate.length, f941, de9, de9c };
}

// Form 940: federal unemployment for the year.
async function yearReport(year) {
  const lines = await w2Lines(`${year}-01-01`, `${year}-12-31`);
  const tables = tablesFor(year);
  const futaRate = tables?.futa.rate || 0.006;
  const total = sum(lines, 'gross_pay');
  const futaWages = sum(lines, 'futa_wages');
  const futa = sum(lines, 'futa');
  const line8 = round2(futaWages * futaRate);
  const quarters = [1, 2, 3, 4].map((q) => {
    const { from, to } = quarterRange(year, q);
    return round2(lines.filter((l) => l.pay_date >= from && l.pay_date <= to).reduce((s, l) => s + l.futa_wages * futaRate, 0));
  });
  const line13 = await depositsFor(year, ['futa'], () => true);
  const line12 = futa;
  return {
    year,
    line3: total,
    line4: 0,
    line5: round2(total - futaWages),
    line6: round2(total - futaWages),
    line7: futaWages,
    line8,
    line11: round2(futa - line8), // the credit reduction (California)
    line12,
    line13,
    line14: round2(Math.max(0, line12 - line13)),
    line15: round2(Math.max(0, line13 - line12)),
    quarters,
  };
}

module.exports = { quarterReport, yearReport, quarterRange, w2Lines };
