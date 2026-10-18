// Company settings (admins only).
const express = require('express');
const { getSettings, saveSettings } = require('../settings');
const { clean, toNumber, logActivity } = require('../helpers');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('settings', { title: 'Settings', values: getSettings(), error: null });
});

router.post('/', (req, res) => {
  const v = clean(req.body, ['company_name', 'currency_symbol', 'overtime_weekly_hours', 'overtime_multiplier', 'expiry_warning_days']);
  const values = {
    company_name: v.company_name,
    currency_symbol: v.currency_symbol || '',
    overtime_weekly_hours: toNumber(v.overtime_weekly_hours, 0),
    overtime_multiplier: toNumber(v.overtime_multiplier, 1),
    expiry_warning_days: toNumber(v.expiry_warning_days, 30),
  };

  let error = null;
  if (!values.company_name) error = 'Company name is required.';
  else if (values.currency_symbol.length > 5) error = 'Currency symbol should be short, like $ or £.';
  else if (Number.isNaN(values.overtime_weekly_hours) || values.overtime_weekly_hours < 0 || values.overtime_weekly_hours > 168) {
    error = 'Weekly hours before overtime must be between 0 and 168.';
  } else if (Number.isNaN(values.overtime_multiplier) || values.overtime_multiplier < 1 || values.overtime_multiplier > 5) {
    error = 'Overtime multiplier must be between 1 and 5 (e.g. 1.5 for "time and a half").';
  } else if (!Number.isInteger(values.expiry_warning_days) || values.expiry_warning_days < 0 || values.expiry_warning_days > 365) {
    error = 'Warning days must be a whole number between 0 and 365.';
  }
  if (error) return res.status(400).render('settings', { title: 'Settings', values, error });

  saveSettings(values);
  logActivity(req, 'Updated company settings');
  req.flash('success', 'Settings saved.');
  res.redirect('/settings');
});

module.exports = router;
