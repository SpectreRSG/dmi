// Payroll tax maths for W-2 paychecks (2026 tables). Expected amounts are
// worked out by hand from IRS Pub 15-T Worksheet 1A and EDD Method B.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tablesFor } = require('../src/services/taxTables');
const w = require('../src/services/withholding');

const tables = tablesFor(2026);
const fed = (wages, periods, profile) => w.federalIncomeTax({ wages, periods, profile, tables });
const ca = (wages, periods, profile) => w.californiaIncomeTax({ wages, periods, profile, tables });

test('federal: the 2026 tables line up with Pub 15-T', () => {
  const single = w.federalTableRows(tables, 'single', false);
  assert.deepEqual(single.slice(0, 3), [
    { from: 0, to: 7500, base: 0, rate: 0 },
    { from: 7500, to: 19900, base: 0, rate: 0.10 },
    { from: 19900, to: 57900, base: 1240, rate: 0.12 },
  ]);
  assert.equal(w.federalTableRows(tables, 'married', false)[0].to, 19300);
  assert.equal(w.federalTableRows(tables, 'single', true)[0].to, 8050, 'Step 2 box: half the standard deduction');
  assert.equal(single.at(-1).to, null);
});

test('federal: Worksheet 1A for each kind of W-4', () => {
  // Single, every two weeks, $2,000: (52,000 − 8,600 − 7,500) taxed = 4,060 a year.
  assert.equal(fed(2000, 26, { fed_filing_status: 'single' }), 156.15);
  assert.equal(fed(2000, 26, null), 156.15, 'no W-4: single with no other entries');
  // Married filing jointly, two children ($4,400), $10 extra.
  assert.equal(fed(3000, 26, { fed_filing_status: 'married', fed_dependents: 4400, fed_extra: 10 }), 33.08);
  // Step 2 box checked (two jobs), weekly $1,000.
  assert.equal(fed(1000, 52, { fed_filing_status: 'single', fed_multiple_jobs: 1 }), 135.1);
  // Head of household, twice a month, with other income and deductions.
  assert.equal(fed(2500, 24, { fed_filing_status: 'head', fed_other_income: 1200, fed_deductions: 6000 }), 140.5);
  // Exempt, and credits bigger than the tax.
  assert.equal(fed(2000, 26, { fed_filing_status: 'single', fed_exempt: 1 }), 0);
  assert.equal(fed(800, 26, { fed_filing_status: 'single', fed_dependents: 4400 }), 0);
});

test('California: Method B (exact calculation)', () => {
  assert.deepEqual(w.californiaTableRows(tables, 'single').slice(0, 2), [
    { from: 0, to: 11079, base: 0, rate: 0.011 },
    { from: 11079, to: 26264, base: 121.87, rate: 0.022 },
  ]);
  // Single, 1 allowance, every two weeks, $2,000.
  assert.equal(ca(2000, 26, { ca_filing_status: 'single', ca_allowances: 1 }), 49.06);
  // No DE 4: single with no allowances.
  assert.equal(ca(1000, 26, null), 12.48);
  // Married (one income), 2 allowances: under the low-income amount, so nothing.
  assert.equal(ca(1400, 26, { ca_filing_status: 'married', ca_allowances: 2 }), 0);
  // …but with 1 allowance the lower amount applies.
  assert.ok(ca(1400, 26, { ca_filing_status: 'married', ca_allowances: 1 }) > 0);
  // Married, 2 allowances and 1 for estimated deductions, monthly, $5 extra.
  assert.equal(ca(6000, 12, { ca_filing_status: 'married', ca_allowances: 2, ca_estimated_allowances: 1, ca_extra: 5 }), 78.83);
  assert.equal(ca(1400, 26, { ca_filing_status: 'head', ca_allowances: 1 }), 0);
  assert.equal(ca(2000, 26, { ca_filing_status: 'single', ca_exempt: 1 }), 0);
});

test('Social Security, Medicare, SDI and the company’s taxes, with the yearly limits', () => {
  const employer = { uiRate: 0.034, ettRate: 0.001, futaCreditReduction: 0.015 };
  let t = w.payrollTaxes({ wages: 2000, periods: 26, profile: null, tables, employer });
  assert.equal(t.social_security, 124);
  assert.equal(t.medicare, 29);
  assert.equal(t.additional_medicare, 0);
  assert.equal(t.ca_sdi, 26);
  assert.equal(t.employer_social_security, 124);
  assert.equal(t.futa, 42, 'FUTA 0.6% plus the 1.5% credit reduction');
  assert.equal(t.ca_ui, 68);
  assert.equal(t.ca_ett, 2);

  // Near the Social Security wage base ($184,500) and the $200,000 Medicare threshold.
  t = w.payrollTaxes({ wages: 3000, periods: 26, profile: null, tables, employer, ytd: { wages: 199000, socialSecurityWages: 183500 } });
  assert.equal(t.ss_wages, 1000);
  assert.equal(t.social_security, 62);
  assert.equal(t.additional_medicare, 18);
  // The first $7,000 only, for FUTA, UI and ETT.
  t = w.payrollTaxes({ wages: 2000, periods: 26, profile: null, tables, employer, ytd: { wages: 6000, futaWages: 6000, uiWages: 6000 } });
  assert.deepEqual([t.futa_wages, t.futa, t.ui_wages, t.ca_ui, t.ca_ett], [1000, 21, 1000, 34, 1]);
  t = w.payrollTaxes({ wages: 2000, periods: 26, profile: null, tables, employer, ytd: { wages: 9000, futaWages: 7000, uiWages: 7000 } });
  assert.deepEqual([t.futa, t.ca_ui, t.ca_ett], [0, 0, 0]);
  const expected = Math.round((t.fed_income_tax + 124 + 29 + t.ca_income_tax + 26) * 100) / 100;
  assert.equal(w.sumOf(t, w.EMPLOYEE_TAXES), expected);
});
