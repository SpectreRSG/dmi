// Payroll tax rates and withholding tables, one set per calendar year (the
// year of the pay date). Each December the IRS and California's EDD publish
// the next year's: add that year here before the first pay date in it, and
// check every number against the publications named below.
//
// Amounts are annual. Brackets are [up to this amount, rate] in order; the last
// one has no limit.
const TABLES = {
  2026: {
    year: 2026,
    federal: {
      // IRS Publication 15-T (2026): Worksheet 1A and the Percentage Method
      // Tables for Automated Payroll Systems (Forms W-4 from 2020 or later).
      // The tables are the 2026 tax brackets and standard deductions (Rev.
      // Proc. 2025-32) laid out for payroll, so they're built from them here.
      source: 'IRS Publication 15-T (2026), Worksheet 1A and Percentage Method Tables for Automated Payroll Systems; Rev. Proc. 2025-32',
      standardDeduction: { single: 16100, married: 32200, head: 24150 },
      // Worksheet 1A, line 1g (used when the Step 2 box isn't checked).
      worksheetAdjustment: { single: 8600, married: 12900, head: 8600 },
      brackets: {
        single: [[12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [Infinity, 0.37]],
        married: [[24800, 0.10], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [Infinity, 0.37]],
        head: [[17700, 0.10], [67450, 0.12], [105700, 0.22], [201775, 0.24], [256200, 0.32], [640600, 0.35], [Infinity, 0.37]],
      },
      // Form W-4 (2026), Step 3: the credit for each dependent.
      childCredit: 2200, // each qualifying child under 17
      otherDependentCredit: 500,
      backupWithholdingRate: 0.24, // 1099 payments to someone the IRS says needs it
    },
    fica: {
      source: 'IRS Publication 15 (2026); Social Security Administration (wage base for 2026)',
      socialSecurityRate: 0.062, // employee and employer each
      socialSecurityWageBase: 184500,
      medicareRate: 0.0145, // employee and employer each, no limit
      additionalMedicareRate: 0.009, // employee only, on wages over the threshold in the year
      additionalMedicareThreshold: 200000,
    },
    futa: {
      source: 'IRS Form 940 instructions; California EDD (credit reduction)',
      rate: 0.006, // after the normal credit for paying state unemployment
      wageBase: 7000,
    },
    california: {
      // EDD: California Withholding Schedules for 2026 (DE 44), Method B –
      // Exact Calculation Method, annual payroll period. The withholding rates
      // are 110% of the income tax rates, with the extra 1% over $1 million.
      source: 'California EDD, California Withholding Schedules for 2026 (Method B – Exact Calculation Method); EDD 2026 rates (SDI, UI, ETT)',
      sdiRate: 0.013, // employee, all wages (no limit since 2024)
      uiWageBase: 7000, // unemployment insurance and ETT, per employee per year
      // The state minimum wage. A salary exempt from overtime must be at least
      // twice this for 40 hours a week (Labor Code 515(a)): $70,304 in 2026.
      minimumWage: 16.9,
      // Table 1: no withholding if annual wages are this or less.
      lowIncomeExemption: { single: 18896, marriedLow: 18896, marriedHigh: 37791, head: 37791 },
      // Table 3.
      standardDeduction: { single: 5706, marriedLow: 5706, marriedHigh: 11412, head: 11412 },
      estimatedDeductionPerAllowance: 1000, // Table 2
      exemptionCreditPerAllowance: 168.3, // Table 4
      // Table 5.
      brackets: {
        single: [[11079, 0.011], [26264, 0.022], [41452, 0.044], [57542, 0.066], [72724, 0.088], [371479, 0.1023],
          [445771, 0.1133], [742953, 0.1243], [1000000, 0.1353], [Infinity, 0.1463]],
        married: [[22158, 0.011], [52528, 0.022], [82904, 0.044], [115084, 0.066], [145448, 0.088], [742958, 0.1023],
          [891542, 0.1133], [1000000, 0.1243], [1485906, 0.1353], [Infinity, 0.1463]],
        head: [[22173, 0.011], [52530, 0.022], [67716, 0.044], [83805, 0.066], [98990, 0.088], [505208, 0.1023],
          [606251, 0.1133], [1000000, 0.1243], [1010417, 0.1353], [Infinity, 0.1463]],
      },
    },
  },
};

// Pay periods in a year for each pay frequency (Settings).
const PAY_FREQUENCIES = {
  weekly: { label: 'Weekly', periods: 52 },
  biweekly: { label: 'Every two weeks', periods: 26 },
  semimonthly: { label: 'Twice a month', periods: 24 },
  monthly: { label: 'Monthly', periods: 12 },
};

function tablesFor(year) {
  return TABLES[Number(year)] || null;
}

const tableYears = () => Object.keys(TABLES).map(Number);

module.exports = { TABLES, PAY_FREQUENCIES, tablesFor, tableYears };
