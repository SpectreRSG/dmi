// A W-2 employee's Form W-4 (federal) and DE 4 (California) answers: reading
// the form, checking it, and saving it. Officers fill it in under Tax forms;
// the office can type in paper forms an employee signed (staff page).
const db = require('../db');
const time = require('../time');
const { toNumber } = require('../helpers');
const { encrypt } = require('../secureData');
const { US_STATES, digitsOnly, tinProblem, zipOk } = require('./tax1099');
const { tablesFor, tableYears } = require('./taxTables');

// W-4 Step 1(c).
const FEDERAL_STATUSES = {
  single: 'Single or Married filing separately',
  married: 'Married filing jointly or Qualifying surviving spouse',
  head: 'Head of household',
};
// DE 4, filing status.
const CALIFORNIA_STATUSES = {
  single: 'Single or Married (with two or more incomes)',
  married: 'Married (one income)',
  head: 'Head of household',
};

const MONEY_FIELDS = ['fed_dependents', 'fed_other_income', 'fed_deductions', 'fed_extra', 'ca_extra'];
const COUNT_FIELDS = ['ca_allowances', 'ca_estimated_allowances'];

function findProfile(employeeId) {
  return db.get('SELECT * FROM withholding_profiles WHERE employee_id = ?', employeeId);
}

// Their Social Security number from an earlier W-9, if they gave one there.
function ssnFromW9(employeeId) {
  return db.get("SELECT tin_encrypted, tin_last4 FROM tax_profiles WHERE employee_id = ? AND tin_type = 'SSN'", employeeId);
}

// Starting values for the form.
async function formValues(employee) {
  const [profile, w9] = await Promise.all([findProfile(employee.id), ssnFromW9(employee.id)]);
  const onFile = profile ? profile.ssn_last4 : w9?.tin_last4;
  if (profile) return { ...profile, ssn_on_file: onFile, signed_name: '' };
  const w9Details = await db.get('SELECT legal_name, address, city, state, zip FROM tax_profiles WHERE employee_id = ?', employee.id);
  return {
    legal_name: w9Details?.legal_name || `${employee.first_name} ${employee.last_name}`,
    address: w9Details?.address || employee.address || '',
    city: w9Details?.city || '',
    state: w9Details?.state || 'CA',
    zip: w9Details?.zip || '',
    fed_filing_status: 'single',
    ca_filing_status: 'single',
    ssn_on_file: onFile,
  };
}

// Reads and checks the form. Gives { values, error }.
async function readForm(body, employeeId) {
  const text = (field, max) => String(body[field] ?? '').trim().slice(0, max);
  const values = {
    legal_name: text('legal_name', 100),
    address: text('address', 120),
    city: text('city', 60),
    state: text('state', 2).toUpperCase(),
    zip: text('zip', 10),
    fed_filing_status: FEDERAL_STATUSES[body.fed_filing_status] ? body.fed_filing_status : null,
    fed_multiple_jobs: body.fed_multiple_jobs ? 1 : 0,
    fed_exempt: body.fed_exempt ? 1 : 0,
    ca_filing_status: CALIFORNIA_STATUSES[body.ca_filing_status] ? body.ca_filing_status : null,
    ca_exempt: body.ca_exempt ? 1 : 0,
    signed_name: text('signed_name', 100),
  };
  for (const f of MONEY_FIELDS) values[f] = toNumber(body[f], 0);
  for (const f of COUNT_FIELDS) values[f] = toNumber(body[f], 0);

  const [profile, w9] = await Promise.all([findProfile(employeeId), ssnFromW9(employeeId)]);
  const kept = profile ? { encrypted: profile.ssn_encrypted, last4: profile.ssn_last4 } : w9 && { encrypted: w9.tin_encrypted, last4: w9.tin_last4 };
  values.ssn_on_file = kept?.last4;
  const ssn = digitsOnly(body.ssn);

  let error = null;
  if (!values.legal_name) error = 'Enter your name as it is on your Social Security card.';
  else if (!values.address || !values.city) error = 'Enter your street address and city.';
  else if (!US_STATES.includes(values.state)) error = 'Use the 2-letter state code, like CA.';
  else if (!zipOk(values.zip)) error = 'The ZIP code should be 5 digits (or ZIP+4).';
  else if (ssn || !kept) error = tinProblem('SSN', ssn);
  if (error) return { values, error };
  if (!values.fed_filing_status) error = 'Choose your federal filing status (W-4 Step 1c).';
  else if (!values.ca_filing_status) error = 'Choose your California filing status (DE 4).';
  else if (MONEY_FIELDS.some((f) => Number.isNaN(values[f]) || values[f] < 0 || values[f] > 1000000)) error = 'Amounts must be numbers of 0 or more, like 2200 or 25.50.';
  else if (COUNT_FIELDS.some((f) => !Number.isInteger(values[f]) || values[f] < 0 || values[f] > 99)) error = 'Allowances are whole numbers, like 0, 1 or 2.';
  else if (!body.certify) error = 'Please tick the box to sign.';
  else if (!values.signed_name) error = 'Type your full name to sign.';
  if (error) return { values, error };

  values.ssn_encrypted = ssn ? await encrypt(ssn) : kept.encrypted;
  values.ssn_last4 = ssn ? ssn.slice(-4) : kept.last4;
  return { values, error: null };
}

const SAVED_FIELDS = [
  'legal_name', 'address', 'city', 'state', 'zip', 'ssn_encrypted', 'ssn_last4', 'fed_filing_status', 'fed_multiple_jobs', 'fed_dependents',
  'fed_other_income', 'fed_deductions', 'fed_extra', 'fed_exempt', 'ca_filing_status', 'ca_allowances', 'ca_estimated_allowances', 'ca_extra',
  'ca_exempt', 'signed_name', 'signed_at', 'signed_ip', 'entered_by',
];

// Saves it (replacing any earlier one). `enteredBy`: the office user who typed
// in a paper form, or null when the employee filled it in themselves.
async function saveProfile(employeeId, values, { ip, enteredBy = null }) {
  const row = { ...values, signed_at: time.nowStr(), signed_ip: ip || null, entered_by: enteredBy };
  const params = { employee_id: employeeId, ...Object.fromEntries(SAVED_FIELDS.map((f) => [f, row[f] ?? null])) };
  await db.run(
    `INSERT INTO withholding_profiles (employee_id, ${SAVED_FIELDS.join(', ')}) VALUES (@employee_id, ${SAVED_FIELDS.map((f) => `@${f}`).join(', ')})
     ON CONFLICT (employee_id) DO UPDATE SET ${SAVED_FIELDS.map((f) => `${f} = excluded.${f}`).join(', ')}, updated_at = app_now()`,
    params
  );
}

// One line to sum it up, e.g. "Federal: single · California: married, 2 allowances".
function summary(profile) {
  const fed = profile.fed_exempt ? 'exempt' : FEDERAL_STATUSES[profile.fed_filing_status].split(' or ')[0].toLowerCase();
  const ca = profile.ca_exempt
    ? 'exempt'
    : `${CALIFORNIA_STATUSES[profile.ca_filing_status].split(' (')[0].split(' or ')[0].toLowerCase()}, ${profile.ca_allowances} allowance${profile.ca_allowances === 1 ? '' : 's'}`;
  return `Federal: ${fed}${profile.fed_multiple_jobs ? ' (two jobs)' : ''} · California: ${ca}`;
}

// What the form page needs besides the answers: the choices and this year's
// W-4 Step 3 amounts.
function formLocals() {
  const federal = (tablesFor(time.todayStr().slice(0, 4)) || tablesFor(Math.max(...tableYears()))).federal;
  return { FEDERAL_STATUSES, CALIFORNIA_STATUSES, credits: { child: federal.childCredit, other: federal.otherDependentCredit } };
}

module.exports = { FEDERAL_STATUSES, CALIFORNIA_STATUSES, findProfile, formValues, readForm, saveProfile, summary, formLocals };
