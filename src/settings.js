// Company-wide settings, editable on the Settings page.
const db = require('./db');

const DEFAULTS = {
  company_name: 'DMI',
  timezone: 'America/Los_Angeles', // what "today" and "now" mean for the company
  currency_symbol: '$',
  overtime_weekly_hours: '40', // hours per week before overtime starts (0 = no overtime)
  overtime_multiplier: '1.5', // overtime pays this many times the normal rate
  daily_overtime: 'california', // 'california': also over 8 hours in a workday (and double time over 12); 'off': weekly only
  workday_start: '06:00', // when each 24-hour workday starts, for daily overtime ('06:00' = 6 AM to 6 AM)
  expiry_warning_days: '30', // warn this many days before licenses/training/contracts expire
  min_rest_hours: '8', // the conflict checker warns if someone has less rest than this between shifts
  two_step_required_for: 'everyone', // who must use two-step sign-in: 'everyone' or 'office' (admins and managers)
  // The company as it appears in the PAYER boxes of 1099 forms.
  payer_name: '', // legal name
  payer_ein: '',
  payer_address: '',
  payer_city: '',
  payer_state: '',
  payer_zip: '',
  payer_phone: '',
  payer_state_id: '', // state payer number (box 6), if your state has one
  ppo_license: '', // California private patrol operator (PPO) license number, for incident reports
  // Payroll for W-2 employees.
  pay_frequency: 'biweekly', // how often people are paid (decides the tax withholding): weekly, biweekly, semimonthly, monthly
  ca_ui_rate: '3.4', // the company's California unemployment insurance rate, in % (EDD sends it each December; 3.4 for new employers)
  ca_ett_rate: '0.1', // California employment training tax, in %
  futa_credit_reduction: '1.5', // extra federal unemployment tax for California employers, in % (set each November)
  fed_deposit_schedule: 'monthly', // when payroll taxes are paid: 'monthly' (most new employers) or 'semiweekly' (IRS Pub 15)
  tax_tables_confirmed: '', // the year whose tax rates an admin has checked, e.g. '2026'
  // Direct deposit: from the company's bank, when it sets up payroll (ACH) uploads.
  bank_name: '', // the company's bank
  bank_routing: '', // the bank's routing number (the "originating" bank)
  ach_company_id: '', // the 10-character company ID the bank gives (often 1 + the EIN)
  ach_immediate_origin: '', // the "immediate origin" the bank gives (often the same as the company ID)
  ach_company_name: '', // the company name the bank has (up to 16 characters shows on statements)
};

// The time zones you can pick on the Settings page.
const TIMEZONES = [
  ['America/Los_Angeles', 'Pacific (Los Angeles)'],
  ['America/Denver', 'Mountain (Denver)'],
  ['America/Phoenix', 'Arizona (Phoenix, no daylight saving)'],
  ['America/Chicago', 'Central (Chicago)'],
  ['America/New_York', 'Eastern (New York)'],
  ['America/Anchorage', 'Alaska (Anchorage)'],
  ['Pacific/Honolulu', 'Hawaii (Honolulu)'],
  ['UTC', 'UTC'],
];

async function getSettings() {
  const rows = await db.all('SELECT key, value FROM settings');
  const s = { ...DEFAULTS, ...Object.fromEntries(rows.map((row) => [row.key, row.value])) };
  return {
    company_name: s.company_name,
    timezone: s.timezone,
    currency_symbol: s.currency_symbol,
    overtime_weekly_hours: Number(s.overtime_weekly_hours),
    overtime_multiplier: Number(s.overtime_multiplier),
    daily_overtime: s.daily_overtime === 'off' ? 'off' : 'california',
    workday_start: /^([01]\d|2[0-3]):[0-5]\d$/.test(s.workday_start) ? s.workday_start : '06:00',
    expiry_warning_days: Number(s.expiry_warning_days),
    min_rest_hours: Number(s.min_rest_hours),
    two_step_required_for: s.two_step_required_for === 'office' ? 'office' : 'everyone',
    payer_name: s.payer_name,
    payer_ein: s.payer_ein,
    payer_address: s.payer_address,
    payer_city: s.payer_city,
    payer_state: s.payer_state,
    payer_zip: s.payer_zip,
    payer_phone: s.payer_phone,
    payer_state_id: s.payer_state_id,
    ppo_license: s.ppo_license,
    pay_frequency: ['weekly', 'biweekly', 'semimonthly', 'monthly'].includes(s.pay_frequency) ? s.pay_frequency : 'biweekly',
    ca_ui_rate: Number(s.ca_ui_rate),
    ca_ett_rate: Number(s.ca_ett_rate),
    futa_credit_reduction: Number(s.futa_credit_reduction),
    fed_deposit_schedule: s.fed_deposit_schedule === 'semiweekly' ? 'semiweekly' : 'monthly',
    tax_tables_confirmed: s.tax_tables_confirmed,
    bank_name: s.bank_name,
    bank_routing: s.bank_routing,
    ach_company_id: s.ach_company_id,
    ach_immediate_origin: s.ach_immediate_origin,
    ach_company_name: s.ach_company_name,
  };
}

async function saveSettings(values) {
  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(values)) {
      if (!(key in DEFAULTS)) continue;
      await tx.run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        key,
        String(value)
      );
    }
  });
}

module.exports = { getSettings, saveSettings, TIMEZONES };
