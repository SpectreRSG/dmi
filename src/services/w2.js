// Year-end Form W-2 for W-2 employees: the numbers from their finalized pay
// for the year (by pay date), the company's and employee's details, and the
// W-3 totals. Copy A goes to the Social Security Administration online
// (Business Services Online, "W-2 Online"), not on paper.
const db = require('../db');
const { round2 } = require('./payroll');
const { decrypt } = require('../secureData');

const PAY_DATE = 'COALESCE(p.paid_on, substr(p.finalized_at, 1, 10))';

// Everyone paid as a W-2 employee in the year, with their totals.
async function w2PayForYear(year) {
  const rows = await db.all(
    `SELECT i.employee_id, SUM(i.gross_pay) AS wages, SUM(i.fed_income_tax) AS fed, SUM(i.ss_wages) AS ss_wages,
       SUM(i.social_security) AS ss, SUM(i.medicare + i.additional_medicare) AS medicare, SUM(i.ca_income_tax) AS ca,
       SUM(i.ca_sdi) AS sdi, COUNT(DISTINCT p.id)::int AS pay_runs
     FROM pay_run_items i JOIN pay_runs p ON p.id = i.pay_run_id
     WHERE p.status = 'finalized' AND i.tax_form = 'W-2' AND ${PAY_DATE} BETWEEN ? AND ?
     GROUP BY i.employee_id`,
    `${year}-01-01`,
    `${year}-12-31`
  );
  return new Map(rows.map((r) => [r.employee_id, r]));
}

// The boxes, from one employee's totals. No pre-tax deductions yet, so wages
// are the same in boxes 1, 5 and 16; box 3 stops at the Social Security wage base.
function boxesFrom(pay, settings) {
  return {
    box1: round2(pay.wages),
    box2: round2(pay.fed),
    box3: round2(pay.ss_wages),
    box4: round2(pay.ss),
    box5: round2(pay.wages),
    box6: round2(pay.medicare),
    box14: pay.sdi ? [{ label: 'CASDI', amount: round2(pay.sdi) }] : [],
    box15: 'CA',
    box15_id: settings.payer_state_id || '',
    box16: round2(pay.wages),
    box17: round2(pay.ca),
  };
}

function employerFrom(settings) {
  return {
    name: settings.payer_name,
    ein: settings.payer_ein,
    address: settings.payer_address,
    city: settings.payer_city,
    state: settings.payer_state,
    zip: settings.payer_zip,
  };
}

const EMPLOYER_FIELDS = ['payer_name', 'payer_ein', 'payer_address', 'payer_city', 'payer_state', 'payer_zip', 'payer_state_id'];
const employerMissing = (settings) => EMPLOYER_FIELDS.some((f) => !settings[f]);

// Fresh numbers and details for a draft, or { error } if something's missing.
async function freshW2(employee, year, settings) {
  const profile = await db.get('SELECT * FROM withholding_profiles WHERE employee_id = ?', employee.id);
  if (!profile) return { error: `${employee.first_name} ${employee.last_name} has no W-4 on file, so there's no Social Security number for the W-2. Enter their W-4 and DE 4 first (staff page).` };
  if (employerMissing(settings)) return { error: 'Fill in the company tax details in Settings first (legal name, EIN, address and California employer account number).' };
  const pay = (await w2PayForYear(year)).get(employee.id);
  if (!pay) return { error: `${employee.first_name} ${employee.last_name} wasn't paid as a W-2 employee in ${year}.` };
  return {
    boxes: boxesFrom(pay, settings),
    employer: employerFrom(settings),
    employee: {
      name: profile.legal_name,
      address: profile.address,
      city: profile.city,
      state: profile.state,
      zip: profile.zip,
      ssn_encrypted: profile.ssn_encrypted,
      ssn_last4: profile.ssn_last4,
      number: `DMI-${employee.id}`, // box d, the control number
    },
  };
}

const formatSsn = (digits) => `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
const maskedSsn = (last4) => `XXX-XX-${last4}`;

async function fullSsn(employee) {
  return formatSsn(await decrypt(employee.ssn_encrypted));
}

// The W-3: totals of the W-2s.
function w3Totals(forms) {
  const total = (box) => round2(forms.reduce((s, f) => s + (Number(f.boxes[box]) || 0), 0));
  return {
    count: forms.length,
    box1: total('box1'),
    box2: total('box2'),
    box3: total('box3'),
    box4: total('box4'),
    box5: total('box5'),
    box6: total('box6'),
    box16: total('box16'),
    box17: total('box17'),
  };
}

module.exports = { w2PayForYear, freshW2, boxesFrom, employerMissing, fullSsn, maskedSsn, w3Totals };
