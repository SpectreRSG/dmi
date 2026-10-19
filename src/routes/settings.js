// Company settings (admins only).
const express = require('express');
const { getSettings, saveSettings, TIMEZONES } = require('../settings');
const { clean, toNumber, logActivity } = require('../helpers');
const { US_STATES, digitsOnly, zipOk } = require('../services/tax1099');
const { requireRecentCode } = require('../auth');


const router = express.Router();

function render(res, values, error, status = 200) {
  res.status(status).render('settings', { title: 'Settings', values, error, TIMEZONES });
}

router.get('/', async (req, res) => {
  render(res, await getSettings(), null);
});

router.post('/', requireRecentCode, async (req, res) => {
  const v = clean(req.body, [
    'company_name', 'timezone', 'currency_symbol', 'overtime_weekly_hours', 'overtime_multiplier', 'expiry_warning_days', 'min_rest_hours', 'two_step_required_for',
    'payer_name', 'payer_ein', 'payer_address', 'payer_city', 'payer_state', 'payer_zip', 'payer_phone', 'payer_state_id',
  ]);
  const ein = digitsOnly(v.payer_ein);
  const values = {
    company_name: v.company_name,
    timezone: v.timezone,
    currency_symbol: v.currency_symbol || '',
    overtime_weekly_hours: toNumber(v.overtime_weekly_hours, 0),
    overtime_multiplier: toNumber(v.overtime_multiplier, 1),
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
  };

  let error = null;
  if (!values.company_name) error = 'Company name is required.';
  else if (!TIMEZONES.some(([zone]) => zone === values.timezone)) error = 'Please choose a time zone from the list.';
  else if (values.currency_symbol.length > 5) error = 'Currency symbol should be short, like $ or £.';
  else if (Number.isNaN(values.overtime_weekly_hours) || values.overtime_weekly_hours < 0 || values.overtime_weekly_hours > 168) {
    error = 'Weekly hours before overtime must be between 0 and 168.';
  } else if (Number.isNaN(values.overtime_multiplier) || values.overtime_multiplier < 1 || values.overtime_multiplier > 5) {
    error = 'Overtime multiplier must be between 1 and 5 (e.g. 1.5 for "time and a half").';
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
  }
  if (error) return render(res, values, error, 400);

  await saveSettings(values);
  const before = res.locals.settings.two_step_required_for;
  await logActivity(req, `Updated company settings${before !== values.two_step_required_for ? ` (two-step sign-in now required for ${values.two_step_required_for === 'office' ? 'office staff only' : 'everyone'})` : ''}`);
  req.flash('success', 'Settings saved.');
  res.redirect('/settings');
});

module.exports = router;
