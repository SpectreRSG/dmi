// Company settings (admins only).
const express = require('express');
const { getSettings, saveSettings, TIMEZONES } = require('../settings');
const { clean, toNumber, logActivity } = require('../helpers');
const { US_STATES, digitsOnly, zipOk } = require('../services/tax1099');
const { encrypt } = require('../secureData');
const { emailIsSetUp, openMailer } = require('../services/mailer');

// "Name <name@example.com>" or just "name@example.com".
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
function emailAddressOk(value) {
  const match = /<([^>]+)>\s*$/.exec(value);
  return EMAIL_PATTERN.test(match ? match[1] : value);
}

const router = express.Router();

function render(res, values, error, status = 200) {
  res.status(status).render('settings', { title: 'Settings', values, error, TIMEZONES });
}

router.get('/', async (req, res) => {
  render(res, await getSettings(), null);
});

router.post('/', async (req, res) => {
  const v = clean(req.body, [
    'company_name', 'timezone', 'currency_symbol', 'overtime_weekly_hours', 'overtime_multiplier', 'expiry_warning_days', 'min_rest_hours',
    'payer_name', 'payer_ein', 'payer_address', 'payer_city', 'payer_state', 'payer_zip', 'payer_phone', 'payer_state_id',
    'smtp_host', 'smtp_port', 'smtp_user', 'mail_from', 'mail_reply_to',
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
    payer_name: (v.payer_name || '').slice(0, 120),
    payer_ein: ein.length === 9 ? `${ein.slice(0, 2)}-${ein.slice(2)}` : v.payer_ein || '',
    payer_address: (v.payer_address || '').slice(0, 120),
    payer_city: (v.payer_city || '').slice(0, 60),
    payer_state: (v.payer_state || '').toUpperCase(),
    payer_zip: v.payer_zip || '',
    payer_phone: (v.payer_phone || '').slice(0, 30),
    payer_state_id: (v.payer_state_id || '').slice(0, 30),
    smtp_host: (v.smtp_host || '').slice(0, 120),
    smtp_port: toNumber(v.smtp_port, 587),
    smtp_user: (v.smtp_user || '').slice(0, 200),
    mail_from: (v.mail_from || '').slice(0, 200),
    mail_reply_to: (v.mail_reply_to || '').slice(0, 200),
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
  } else if (values.smtp_host && !/^[A-Za-z0-9.-]+$/.test(values.smtp_host)) {
    error = 'The mail server should look like smtp.example.com.';
  } else if (!Number.isInteger(values.smtp_port) || values.smtp_port < 1 || values.smtp_port > 65535) {
    error = 'The mail server port is a number, usually 587 or 465.';
  } else if (values.mail_from && !emailAddressOk(values.mail_from)) {
    error = 'The "send from" address should be an email address, like DMI Timesheets <timesheets@yourcompany.com>.';
  } else if (values.mail_reply_to && !emailAddressOk(values.mail_reply_to)) {
    error = 'The reply-to address should be an email address.';
  } else if (values.smtp_host && !values.mail_from) {
    error = 'Fill in the address emails are sent from.';
  }
  if (error) return render(res, { ...values, smtp_password_set: (await getSettings()).smtp_password_set }, error, 400);

  // The mail password is only changed when a new one is typed (it's never shown).
  if (req.body.smtp_password) values.smtp_password = await encrypt(String(req.body.smtp_password));
  else if (req.body.smtp_password_clear) values.smtp_password = '';

  await saveSettings(values);
  await logActivity(req, 'Updated company settings');
  req.flash('success', 'Settings saved.');
  res.redirect('/settings');
});

// Sends a test email to the admin, to check the email settings work.
router.post('/test-email', async (req, res) => {
  const settings = await getSettings();
  if (!emailIsSetUp(settings)) {
    req.flash('error', 'Fill in and save the email settings first.');
    return res.redirect('/settings#email');
  }
  const mailer = await openMailer(settings);
  try {
    await mailer.send({
      to: req.user.email,
      subject: `Test email from ${settings.company_name}`,
      text: `It works! ${settings.company_name} can send email, so officers will get their approved timesheets.`,
    });
    req.flash('success', `Test email sent to ${req.user.email}. Check your inbox (and the spam folder).`);
  } catch (err) {
    req.flash('error', `The test email couldn't be sent: ${err.message}`);
  } finally {
    mailer.close();
  }
  res.redirect('/settings#email');
});

module.exports = router;
