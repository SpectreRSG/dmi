// Payroll taxes for one paycheck: what's withheld from a W-2 employee's pay
// and what the company owes on top. Only maths (no database), so it's easy to
// test: see tests/withholding.test.js. The rates come from taxTables.js.
//
// `profile` is the employee's W-4 and DE 4 answers (withholding_profiles), or
// null if they haven't filled them in. Then the rules say: federal as single
// with no other entries (Pub 15-T), California as single with no allowances (EDD).
const { round2 } = require('./payroll');

// Tax on an amount, from [up to, rate] brackets.
function taxOnBrackets(amount, brackets) {
  let tax = 0;
  let from = 0;
  for (const [upTo, rate] of brackets) {
    if (amount <= from) break;
    tax += (Math.min(amount, upTo) - from) * rate;
    from = upTo;
  }
  return tax;
}

const halve = (brackets) => brackets.map(([upTo, rate]) => [upTo / 2, rate]);
const filingStatus = (value) => (['married', 'head'].includes(value) ? value : 'single');

// Where the federal tax starts, and its brackets: Pub 15-T's standard tables,
// or the ones for a W-4 with the Step 2 box checked (more than one job).
function federalSchedule(federal, status, stepTwo) {
  if (stepTwo) return { start: federal.standardDeduction[status] / 2, brackets: halve(federal.brackets[status]) };
  return { start: federal.standardDeduction[status] - federal.worksheetAdjustment[status], brackets: federal.brackets[status] };
}

// Federal income tax withholding for one pay period: Pub 15-T Worksheet 1A
// (percentage method for automated payroll systems, W-4 from 2020 or later).
function federalIncomeTax({ wages, periods, profile, tables }) {
  const p = profile || {};
  if (p.fed_exempt || wages <= 0) return 0;
  const federal = tables.federal;
  const status = filingStatus(p.fed_filing_status);
  const stepTwo = Boolean(p.fed_multiple_jobs);
  // Step 1: the adjusted annual wage.
  const annual = wages * periods + (Number(p.fed_other_income) || 0);
  const lineG = stepTwo ? 0 : federal.worksheetAdjustment[status];
  const adjusted = Math.max(0, annual - (Number(p.fed_deductions) || 0) - lineG);
  // Step 2: the tentative withholding from the table.
  const { start, brackets } = federalSchedule(federal, status, stepTwo);
  const tentative = taxOnBrackets(Math.max(0, adjusted - start), brackets) / periods;
  // Steps 3 and 4: credits for dependents, then any extra they asked for.
  const afterCredits = Math.max(0, tentative - (Number(p.fed_dependents) || 0) / periods);
  return round2(afterCredits + (Number(p.fed_extra) || 0));
}

// California column for Tables 1 and 3: married people with 2 or more
// allowances get the bigger amounts.
function californiaColumn(status, allowances) {
  if (status === 'married') return allowances >= 2 ? 'marriedHigh' : 'marriedLow';
  return status;
}

// California income tax withholding for one pay period: EDD Method B (exact
// calculation), worked out on the annual amounts and divided by the periods.
function californiaIncomeTax({ wages, periods, profile, tables }) {
  const p = profile || {};
  if (p.ca_exempt || wages <= 0) return 0;
  const ca = tables.california;
  const status = filingStatus(p.ca_filing_status);
  const allowances = Math.max(0, Number(p.ca_allowances) || 0);
  const column = californiaColumn(status, allowances);
  const extra = Number(p.ca_extra) || 0;
  const annual = wages * periods;
  // Step 1: low income, no withholding.
  if (annual <= ca.lowIncomeExemption[column]) return round2(extra);
  // Steps 2–3: estimated deductions and the standard deduction.
  const estimated = Math.max(0, Number(p.ca_estimated_allowances) || 0) * ca.estimatedDeductionPerAllowance;
  const taxable = Math.max(0, annual - estimated - ca.standardDeduction[column]);
  // Steps 4–5: the tax, less the exemption allowance credit.
  const tax = Math.max(0, taxOnBrackets(taxable, ca.brackets[status]) - allowances * ca.exemptionCreditPerAllowance);
  return round2(tax / periods + extra);
}

// Everything for one W-2 paycheck. `ytd`: this employee's earlier paychecks
// this year (wages, socialSecurityWages, futaWages, uiWages), for the limits.
// `employer`: the company's own rates from Settings (as fractions).
function payrollTaxes({ wages, periods, profile, ytd = {}, tables, employer = {} }) {
  const pay = Math.max(0, Number(wages) || 0);
  const { fica, futa, california } = tables;
  const ytdWages = Number(ytd.wages) || 0;
  const ssWages = Math.max(0, Math.min(pay, fica.socialSecurityWageBase - (Number(ytd.socialSecurityWages) || 0)));
  const over = (total) => Math.max(0, total - fica.additionalMedicareThreshold);
  const futaWages = Math.max(0, Math.min(pay, futa.wageBase - (Number(ytd.futaWages) || 0)));
  const uiWages = Math.max(0, Math.min(pay, california.uiWageBase - (Number(ytd.uiWages) || 0)));
  return {
    // Withheld from the employee's pay.
    fed_income_tax: federalIncomeTax({ wages: pay, periods, profile, tables }),
    social_security: round2(ssWages * fica.socialSecurityRate),
    medicare: round2(pay * fica.medicareRate),
    additional_medicare: round2((over(ytdWages + pay) - over(ytdWages)) * fica.additionalMedicareRate),
    ca_income_tax: californiaIncomeTax({ wages: pay, periods, profile, tables }),
    ca_sdi: round2(pay * california.sdiRate),
    // Paid by the company on top.
    employer_social_security: round2(ssWages * fica.socialSecurityRate),
    employer_medicare: round2(pay * fica.medicareRate),
    futa: round2(futaWages * (futa.rate + (Number(employer.futaCreditReduction) || 0))),
    ca_ui: round2(uiWages * (Number(employer.uiRate) || 0)),
    ca_ett: round2(uiWages * (Number(employer.ettRate) || 0)),
    // The wages each tax was worked out on (for the quarterly and yearly reports).
    ss_wages: round2(ssWages),
    futa_wages: round2(futaWages),
    ui_wages: round2(uiWages),
  };
}

const EMPLOYEE_TAXES = ['fed_income_tax', 'social_security', 'medicare', 'additional_medicare', 'ca_income_tax', 'ca_sdi'];
const EMPLOYER_TAXES = ['employer_social_security', 'employer_medicare', 'futa', 'ca_ui', 'ca_ett'];

const sumOf = (row, keys) => round2(keys.reduce((sum, k) => sum + (Number(row[k]) || 0), 0));

// The federal and California tables as rows ("over A, up to B: C plus D% of
// the amount over A"), to compare with the printed publications.
function scheduleRows(start, brackets) {
  const rows = [{ from: 0, to: start, base: 0, rate: 0 }];
  let from = 0;
  let base = 0;
  for (const [upTo, rate] of brackets) {
    rows.push({ from: start + from, to: upTo === Infinity ? null : start + upTo, base: round2(base), rate });
    base += (upTo - from) * rate;
    from = upTo;
  }
  return start > 0 ? rows : rows.slice(1);
}

function federalTableRows(tables, status, stepTwo) {
  const { start, brackets } = federalSchedule(tables.federal, status, stepTwo);
  return scheduleRows(start, brackets);
}

function californiaTableRows(tables, status) {
  return scheduleRows(0, tables.california.brackets[status]);
}

module.exports = {
  taxOnBrackets,
  federalIncomeTax,
  californiaIncomeTax,
  payrollTaxes,
  federalTableRows,
  californiaTableRows,
  EMPLOYEE_TAXES,
  EMPLOYER_TAXES,
  sumOf,
};
