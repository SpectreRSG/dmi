// 1099-NEC: who was paid how much in a year, the W-9 details we need from each
// officer, and the company ("payer") details that go on every form.
const db = require('../db');
const { round2 } = require('./payroll');
const { encrypt, decrypt } = require('../secureData');

// The choices on Form W-9, line 3a.
const TAX_CLASSIFICATIONS = {
  individual: 'Individual / sole proprietor',
  c_corp: 'C corporation',
  s_corp: 'S corporation',
  partnership: 'Partnership',
  trust: 'Trust / estate',
  llc: 'Limited liability company (LLC)',
};
const LLC_CLASSIFICATIONS = { C: 'C corporation', S: 'S corporation', P: 'Partnership' };

// Corporations usually don't get a 1099-NEC (with some exceptions, like lawyers).
function isCorporation(profile) {
  return ['c_corp', 's_corp'].includes(profile.tax_classification)
    || (profile.tax_classification === 'llc' && ['C', 'S'].includes(profile.llc_classification));
}

// You must file a 1099-NEC for someone you paid at least this much in the year.
// It was $600 until 2025; from payments made in 2026 it's $2,000, and from 2027
// it goes up with inflation (check the IRS instructions for those years).
function filingThreshold(year) {
  return year >= 2026 ? 2000 : 600;
}

const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA VI WA WV WI WY GU AS MP'.split(' ');

function digitsOnly(text) {
  return String(text || '').replace(/\D/g, '');
}

// Basic checks the IRS also makes: a Social Security number never starts with
// 000, 666 or 9, and never has 00 or 0000 in its middle or last part.
function tinProblem(type, digits) {
  if (digits.length !== 9) return `A${type === 'EIN' ? 'n EIN' : ' Social Security number'} has 9 digits.`;
  if (type === 'SSN' && (/^(000|666|9)/.test(digits) || digits.slice(3, 5) === '00' || digits.slice(5) === '0000')) {
    return "That Social Security number doesn't look right. Please check it.";
  }
  if (type === 'EIN' && /^00/.test(digits)) return "That EIN doesn't look right. Please check it.";
  return null;
}

function formatTin(type, digits) {
  return type === 'EIN' ? `${digits.slice(0, 2)}-${digits.slice(2)}` : `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

// What goes on the recipient's own copy: only the last 4 digits (the IRS allows this).
function maskedTin(type, last4) {
  return type === 'EIN' ? `**-***${last4}` : `***-**-${last4}`;
}

function zipOk(zip) {
  return /^\d{5}(-?\d{4})?$/.test(zip);
}

// Everyone paid as a 1099 contractor in the year, from finalized pay runs, by
// the date the pay went out (pay as a W-2 employee goes on their W-2 instead).
// `withheld`: backup withholding, for box 4.
async function paymentsForYear(year) {
  const rows = await db.all(
    `SELECT i.employee_id, SUM(i.gross_pay) AS total, SUM(i.fed_income_tax) AS withheld, COUNT(DISTINCT p.id)::int AS pay_runs
     FROM pay_run_items i JOIN pay_runs p ON p.id = i.pay_run_id
     WHERE p.status = 'finalized' AND i.tax_form = '1099' AND COALESCE(p.paid_on, substr(p.finalized_at, 1, 10)) BETWEEN ? AND ?
     GROUP BY i.employee_id`,
    `${year}-01-01`,
    `${year}-12-31`
  );
  return new Map(rows.map((r) => [r.employee_id, { total: round2(r.total), withheld: round2(r.withheld), payRuns: r.pay_runs }]));
}

// The company details for the "PAYER" boxes, from Settings.
const PAYER_FIELDS = ['payer_name', 'payer_ein', 'payer_address', 'payer_city', 'payer_state', 'payer_zip', 'payer_phone'];

function payerFromSettings(settings) {
  return {
    name: settings.payer_name,
    tin: settings.payer_ein,
    address: settings.payer_address,
    city: settings.payer_city,
    state: settings.payer_state,
    zip: settings.payer_zip,
    phone: settings.payer_phone,
    state_id: settings.payer_state_id,
  };
}

function payerMissing(settings) {
  return PAYER_FIELDS.filter((f) => !settings[f]).length > 0;
}

// The recipient boxes, copied from their W-9. The tax ID stays encrypted.
function recipientFromProfile(profile, employee) {
  return {
    name: profile.legal_name,
    business_name: profile.business_name,
    address: profile.address,
    city: profile.city,
    state: profile.state,
    zip: profile.zip,
    tin_type: profile.tin_type,
    tin_encrypted: profile.tin_encrypted,
    tin_last4: profile.tin_last4,
    account: `DMI-${employee.id}`,
  };
}

async function fullTin(recipient) {
  return formatTin(recipient.tin_type, await decrypt(recipient.tin_encrypted));
}

module.exports = {
  TAX_CLASSIFICATIONS,
  LLC_CLASSIFICATIONS,
  US_STATES,
  isCorporation,
  filingThreshold,
  digitsOnly,
  tinProblem,
  formatTin,
  maskedTin,
  zipOk,
  paymentsForYear,
  payerFromSettings,
  payerMissing,
  recipientFromProfile,
  fullTin,
  encrypt,
};
