// Company settings (admins only).
const express = require('express');
const { getSettings, saveSettings, TIMEZONES } = require('../settings');
const { clean, toNumber, logActivity } = require('../helpers');
const { US_STATES, digitsOnly, zipOk } = require('../services/tax1099');
const { requireRecentCode } = require('../auth');
const { isValidTime } = require('../time');
const { PAY_FREQUENCIES } = require('../services/taxTables');
const { routingOk } = require('../services/nacha');


const router = express.Router();

function render(res, values, error, status = 200) {
  res.status(status).render('settings', { title: 'Settings', values, error, TIMEZONES, PAY_FREQUENCIES });
}

router.get('/', async (req, res) => {
  render(res, await getSettings(), null);
});

router.post('/', requireRecentCode, async (req, res) => {
  const v = clean(req.body, [
    'company_name', 'timezone', 'currency_symbol', 'overtime_weekly_hours', 'overtime_multiplier', 'daily_overtime', 'workday_start',
    'expiry_warning_days', 'min_rest_hours', 'two_step_required_for',
    'payer_name', 'payer_ein', 'payer_address', 'payer_city', 'payer_state', 'payer_zip', 'payer_phone', 'payer_state_id', 'ppo_license',
    'pay_frequency', 'ca_ui_rate', 'ca_ett_rate', 'futa_credit_reduction', 'fed_deposit_schedule',
    'bank_name', 'bank_routing', 'ach_company_id', 'ach_immediate_origin', 'ach_company_name',
  ]);
  const was = res.locals.settings;
  // A field left out of the form (or empty) keeps its current value.
  const rate = (field) => (v[field] == null ? was[field] : toNumber(v[field], NaN));
  const kept = (field, max) => (req.body[field] === undefined ? was[field] || '' : String(v[field] || '').slice(0, max));
  const ein = digitsOnly(v.payer_ein);
  const values = {
    company_name: v.company_name,
    timezone: v.timezone,
    currency_symbol: v.currency_symbol || '',
    overtime_weekly_hours: toNumber(v.overtime_weekly_hours, 0),
    overtime_multiplier: toNumber(v.overtime_multiplier, 1),
    // (Left out of the form: kept as they are.)
    daily_overtime: ['california', 'off'].includes(v.daily_overtime) ? v.daily_overtime : res.locals.settings.daily_overtime,
    workday_start: v.workday_start ?? res.locals.settings.workday_start,
    expiry_warning_days: toNumber(v.expiry_warning_days, 30),
    min_rest_hours: toNumber(v.min_rest_hours, 8),
    two_step_required_for: v.two_step_required_for === 'office' ? 'office' : 'everyone',
    payer_name: (v.payer_name || '').slice(0, 120),
    payer_ein: ein.length === 9 ? `${ein.slice(0, 2)}-${ein.slice(2)}` : v.payer_ein || '',
    payer_address: (v.payer_address || '').slice(0, 120),
    payer_city: (v.payer_city || '').slice(0, 60),
    payer_state: (v.payer_state || '').toUpperCase(),
    payer_zip: v.payer_zip || '',
    payer_phone: (v.payer_phone || '').slice(0, 30),
    payer_state_id: (v.payer_state_id || '').slice(0, 30),
    ppo_license: (v.ppo_license || '').slice(0, 30),
    pay_frequency: v.pay_frequency ?? was.pay_frequency,
    ca_ui_rate: rate('ca_ui_rate'),
    ca_ett_rate: rate('ca_ett_rate'),
    futa_credit_reduction: rate('futa_credit_reduction'),
    fed_deposit_schedule: v.fed_deposit_schedule ?? was.fed_deposit_schedule,
    // Direct deposit details: a field left out of the form keeps its value; an empty one clears it.
    bank_name: kept('bank_name', 23),
    bank_routing: kept('bank_routing', 20).replace(/\D/g, '').slice(0, 9),
    ach_company_id: kept('ach_company_id', 10),
    ach_immediate_origin: kept('ach_immediate_origin', 10),
    ach_company_name: kept('ach_company_name', 16),
  };

  let error = null;
  if (!values.company_name) error = 'Company name is required.';
  else if (!TIMEZONES.some(([zone]) => zone === values.timezone)) error = 'Please choose a time zone from the list.';
  else if (values.currency_symbol.length > 5) error = 'Currency symbol should be short, like $ or £.';
  else if (Number.isNaN(values.overtime_weekly_hours) || values.overtime_weekly_hours < 0 || values.overtime_weekly_hours > 168) {
    error = 'Weekly hours before overtime must be between 0 and 168.';
  } else if (Number.isNaN(values.overtime_multiplier) || values.overtime_multiplier < 1 || values.overtime_multiplier > 5) {
    error = 'Overtime multiplier must be between 1 and 5 (e.g. 1.5 for "time and a half").';
  } else if (!isValidTime(values.workday_start)) {
    error = 'Enter the time each workday starts, like 06:00.';
  } else if (!Number.isInteger(values.expiry_warning_days) || values.expiry_warning_days < 0 || values.expiry_warning_days > 365) {
    error = 'Warning days must be a whole number between 0 and 365.';
  } else if (Number.isNaN(values.min_rest_hours) || values.min_rest_hours < 0 || values.min_rest_hours > 24) {
    error = 'Minimum rest between shifts must be between 0 and 24 hours.';
  } else if (values.payer_ein && ein.length !== 9) {
    error = 'The EIN (employer identification number) has 9 digits, like 12-3456789.';
  } else if (values.payer_state && !US_STATES.includes(values.payer_state)) {
    error = 'Use the 2-letter state code, like CA.';
  } else if (values.payer_zip && !zipOk(values.payer_zip)) {
    error = 'The ZIP code should be 5 digits (or ZIP+4).';
  } else if (values.bank_routing && !routingOk(values.bank_routing)) {
    error = "The bank's routing number doesn't look right: it's 9 digits.";
  } else if (values.ach_company_id && !/^[A-Za-z0-9 ]{1,10}$/.test(values.ach_company_id)) {
    error = 'The ACH company ID is up to 10 letters or digits, as your bank gave it.';
  } else if (values.ach_immediate_origin && !/^[0-9 ]{1,10}$/.test(values.ach_immediate_origin)) {
    error = 'The immediate origin is up to 10 digits, as your bank gave it.';
  } else if (!['monthly', 'semiweekly'].includes(values.fed_deposit_schedule)) {
    error = 'Choose when payroll taxes are paid: monthly or semiweekly.';
  } else if (!PAY_FREQUENCIES[values.pay_frequency]) {
    error = 'Choose how often people are paid.';
  } else if (Number.isNaN(values.ca_ui_rate) || values.ca_ui_rate < 0 || values.ca_ui_rate > 10) {
    error = 'The unemployment insurance (UI) rate is a percentage between 0 and 10, like 3.4.';
  } else if (Number.isNaN(values.ca_ett_rate) || values.ca_ett_rate < 0 || values.ca_ett_rate > 1) {
    error = 'The employment training tax (ETT) rate is a percentage between 0 and 1, like 0.1.';
  } else if (Number.isNaN(values.futa_credit_reduction) || values.futa_credit_reduction < 0 || values.futa_credit_reduction > 6) {
    error = 'The FUTA credit reduction is a percentage between 0 and 6, like 1.5.';
  }
  if (error) return render(res, values, error, 400);

  await saveSettings(values);
  const notes = [];
  if (was.two_step_required_for !== values.two_step_required_for) {
    notes.push(`two-step sign-in now required for ${values.two_step_required_for === 'office' ? 'office staff only' : 'everyone'}`);
  }
  if (was.daily_overtime !== values.daily_overtime || was.workday_start !== values.workday_start) {
    notes.push(values.daily_overtime === 'california' ? `California daily overtime on, workdays from ${values.workday_start}` : 'daily overtime off');
  }
  if (['bank_name', 'bank_routing', 'ach_company_id', 'ach_immediate_origin', 'ach_company_name'].some((f) => (was[f] || '') !== values[f])) {
    notes.push('direct deposit bank details changed');
  }
  if (was.fed_deposit_schedule !== values.fed_deposit_schedule) notes.push(`payroll taxes now paid ${values.fed_deposit_schedule}`);
  if (was.pay_frequency !== values.pay_frequency) notes.push(`pay frequency now ${PAY_FREQUENCIES[values.pay_frequency].label.toLowerCase()}`);
  if (was.ca_ui_rate !== values.ca_ui_rate || was.ca_ett_rate !== values.ca_ett_rate || was.futa_credit_reduction !== values.futa_credit_reduction) {
    notes.push(`unemployment rates now UI ${values.ca_ui_rate}%, ETT ${values.ca_ett_rate}%, FUTA credit reduction ${values.futa_credit_reduction}%`);
  }
  await logActivity(req, `Updated company settings${notes.length ? ` (${notes.join('; ')})` : ''}`);
  req.flash('success', 'Settings saved.');
  res.redirect('/settings');
});

module.exports = router;
