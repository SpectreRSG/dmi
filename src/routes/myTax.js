// An officer's tax pages (/my/tax): their W-9 details for the 1099, agreeing to
// get the 1099 online, and downloading it once the office shares it.
const express = require('express');
const db = require('../db');
const { clean, notFound, numericIdParam, logActivity, employeeName } = require('../helpers');
const time = require('../time');
const tax = require('../services/tax1099');
const { buildForm1099Pdf } = require('../services/form1099Pdf');
const withholding = require('../services/withholdingProfile');

const router = express.Router();
numericIdParam(router);

function findProfile(employeeId) {
  return db.get('SELECT * FROM tax_profiles WHERE employee_id = ?', employeeId);
}

router.get('/', async (req, res) => {
  // W-2 employees: their W-4 and DE 4 (for tax withholding).
  if (req.me.tax_form === 'W-2' || (await db.get('SELECT 1 FROM w2_forms WHERE employee_id = ? LIMIT 1', req.me.id))) {
    const [w4, w2s] = await Promise.all([
      withholding.findProfile(req.me.id),
      db.all("SELECT * FROM w2_forms WHERE employee_id = ? AND status = 'issued' AND released = 1 ORDER BY tax_year DESC", req.me.id),
    ]);
    return res.render('my/tax-w2', { title: 'Tax forms', w4, w2s, summary: w4 ? withholding.summary(w4) : '' });
  }
  const [profile, forms] = await Promise.all([
    findProfile(req.me.id),
    db.all("SELECT * FROM tax_forms WHERE employee_id = ? AND status = 'issued' AND released = 1 ORDER BY tax_year DESC", req.me.id),
  ]);
  res.render('my/tax', {
    title: 'Tax forms',
    profile,
    forms,
    maskedTin: profile ? tax.maskedTin(profile.tin_type, profile.tin_last4) : '',
    TAX_CLASSIFICATIONS: tax.TAX_CLASSIFICATIONS,
    LLC_CLASSIFICATIONS: tax.LLC_CLASSIFICATIONS,
  });
});

// ---- W-9 details ---------------------------------------------------------------

function renderW9(res, values, error, status = 200) {
  res.status(status).render('my/w9', {
    title: 'W-9 details',
    values,
    error,
    TAX_CLASSIFICATIONS: tax.TAX_CLASSIFICATIONS,
    LLC_CLASSIFICATIONS: tax.LLC_CLASSIFICATIONS,
    US_STATES: tax.US_STATES,
  });
}

router.get('/w9', async (req, res) => {
  const profile = await findProfile(req.me.id);
  renderW9(res, profile
    ? { ...profile, has_tin: true, masked: tax.maskedTin(profile.tin_type, profile.tin_last4), signed_name: '' }
    : { legal_name: `${req.me.first_name} ${req.me.last_name}`, tax_classification: 'individual', tin_type: 'SSN', address: req.me.address || '' },
  null);
});

router.post('/w9', async (req, res) => {
  const existing = await findProfile(req.me.id);
  const v = clean(req.body, ['legal_name', 'business_name', 'tax_classification', 'llc_classification', 'address', 'city', 'state', 'zip', 'tin_type', 'signed_name']);
  const values = {
    ...v,
    state: (v.state || '').toUpperCase(),
    tin_type: v.tin_type === 'EIN' ? 'EIN' : 'SSN',
    llc_classification: v.tax_classification === 'llc' ? v.llc_classification : null,
    backup_withholding: req.body.backup_withholding ? 1 : 0,
    has_tin: Boolean(existing),
    masked: existing ? tax.maskedTin(existing.tin_type, existing.tin_last4) : '',
  };
  const tin = tax.digitsOnly(req.body.tin);
  const keepTin = !tin && existing && existing.tin_type === values.tin_type;

  let error = null;
  if (!values.legal_name) error = 'Enter your name exactly as it is on your tax return.';
  else if (!tax.TAX_CLASSIFICATIONS[values.tax_classification]) error = 'Choose your federal tax classification.';
  else if (values.tax_classification === 'llc' && !tax.LLC_CLASSIFICATIONS[values.llc_classification]) error = 'Choose how your LLC is taxed (C, S or P).';
  else if (!values.address || !values.city) error = 'Enter your street address and city.';
  else if (!tax.US_STATES.includes(values.state)) error = 'Use the 2-letter state code, like CA.';
  else if (!tax.zipOk(values.zip || '')) error = 'The ZIP code should be 5 digits (or ZIP+4).';
  else if (!keepTin) error = tax.tinProblem(values.tin_type, tin);
  if (!error && !req.body.certify) error = 'Please tick the box to sign the certification.';
  else if (!error && !values.signed_name) error = 'Type your full name to sign.';
  if (error) return renderW9(res, values, error, 400);

  const tinEncrypted = keepTin ? existing.tin_encrypted : await tax.encrypt(tin);
  const tinLast4 = keepTin ? existing.tin_last4 : tin.slice(-4);
  const fields = [
    values.legal_name.slice(0, 100), values.business_name ? values.business_name.slice(0, 100) : null, values.tax_classification,
    values.llc_classification, values.address.slice(0, 120), values.city.slice(0, 60), values.state, values.zip,
    values.tin_type, tinEncrypted, tinLast4, values.backup_withholding, values.signed_name.slice(0, 100), time.nowStr(), req.ip,
  ];
  if (existing) {
    await db.run(
      `UPDATE tax_profiles SET legal_name = ?, business_name = ?, tax_classification = ?, llc_classification = ?, address = ?, city = ?,
       state = ?, zip = ?, tin_type = ?, tin_encrypted = ?, tin_last4 = ?, backup_withholding = ?, signed_name = ?, signed_at = ?,
       signed_ip = ?, updated_at = app_now() WHERE employee_id = ?`,
      ...fields,
      req.me.id
    );
  } else {
    await db.run(
      `INSERT INTO tax_profiles (legal_name, business_name, tax_classification, llc_classification, address, city, state, zip,
       tin_type, tin_encrypted, tin_last4, backup_withholding, signed_name, signed_at, signed_ip, employee_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...fields,
      req.me.id
    );
  }
  await logActivity(req, `${employeeName(req.me)} ${existing ? 'updated' : 'filled in'} their W-9 details`);
  req.flash('success', 'Thanks! Your W-9 details are saved.');
  res.redirect('/my/tax');
});

// ---- W-4 and DE 4 (W-2 employees) ------------------------------------------------

function renderW4(res, values, error, status = 200) {
  res.status(status).render('my/w4', { title: 'W-4 and DE 4', values, error, ...withholding.formLocals() });
}

router.get('/w4', async (req, res) => renderW4(res, await withholding.formValues(req.me), null));

router.post('/w4', async (req, res) => {
  const existing = await withholding.findProfile(req.me.id);
  const { values, error } = await withholding.readForm(req.body, req.me.id);
  if (error) return renderW4(res, values, error, 400);
  await withholding.saveProfile(req.me.id, values, { ip: req.ip });
  await logActivity(req, `${employeeName(req.me)} ${existing ? 'updated' : 'filled in'} their W-4 and DE 4`);
  req.flash('success', 'Thanks! Your W-4 and DE 4 are saved. The next pay run uses them.');
  res.redirect('/my/tax');
});

// Getting the W-2 online instead of on paper (stored with their W-4).
router.post('/w2-consent', async (req, res) => {
  const w4 = await withholding.findProfile(req.me.id);
  if (!w4) {
    req.flash('error', 'Fill in your W-4 and DE 4 first.');
    return res.redirect('/my/tax');
  }
  const agree = req.body.agree === '1';
  if (agree && !req.body.understand) {
    req.flash('error', 'Please tick the box to show you have read how getting your W-2 online works.');
    return res.redirect('/my/tax');
  }
  await db.run('UPDATE withholding_profiles SET electronic_consent = ?, consent_at = app_now() WHERE employee_id = ?', agree ? 1 : 0, req.me.id);
  if (!agree) await db.run('UPDATE w2_forms SET released = 0 WHERE employee_id = ?', req.me.id);
  await logActivity(req, `${employeeName(req.me)} ${agree ? 'agreed to get' : 'stopped getting'} their W-2 online`);
  req.flash('success', agree ? "Done. You'll be able to download your W-2 here when it's ready." : "Done. You'll get your W-2 on paper.");
  res.redirect('/my/tax');
});

router.get('/w2/:id', async (req, res) => {
  const form = await db.get(
    `SELECT f.*, e.first_name, e.last_name FROM w2_forms f JOIN employees e ON e.id = f.employee_id
     JOIN withholding_profiles wp ON wp.employee_id = f.employee_id
     WHERE f.id = ? AND f.employee_id = ? AND f.status = 'issued' AND f.released = 1 AND wp.electronic_consent = 1`,
    req.params.id,
    req.me.id
  );
  if (!form) return notFound(res, 'W-2');
  const { pdfFor, pdfName } = require('./w2');
  const pdf = await pdfFor(form, false);
  await logActivity(req, `${employeeName(req.me)} downloaded their ${form.tax_year} W-2`);
  res.attachment(pdfName(form, false));
  res.type('application/pdf').send(pdf);
});

// ---- Getting the 1099 online ---------------------------------------------------

router.post('/consent', async (req, res) => {
  const profile = await findProfile(req.me.id);
  if (!profile) {
    req.flash('error', 'Fill in your W-9 details first.');
    return res.redirect('/my/tax');
  }
  const agree = req.body.agree === '1';
  if (agree && !req.body.understand) {
    req.flash('error', 'Please tick the box to show you have read how getting your 1099 online works.');
    return res.redirect('/my/tax');
  }
  await db.run(
    'UPDATE tax_profiles SET electronic_consent = ?, consent_at = app_now() WHERE employee_id = ?',
    agree ? 1 : 0,
    req.me.id
  );
  if (!agree) await db.run('UPDATE tax_forms SET released = 0 WHERE employee_id = ?', req.me.id);
  await logActivity(req, `${employeeName(req.me)} ${agree ? 'agreed to get' : 'stopped getting'} their 1099 online`);
  req.flash('success', agree ? "Done. You'll be able to download your 1099 here when it's ready." : "Done. You'll get your 1099 on paper.");
  res.redirect('/my/tax');
});

router.get('/1099/:id', async (req, res) => {
  const form = await db.get(
    `SELECT f.* FROM tax_forms f JOIN tax_profiles tp ON tp.employee_id = f.employee_id
     WHERE f.id = ? AND f.employee_id = ? AND f.status = 'issued' AND f.released = 1 AND tp.electronic_consent = 1`,
    req.params.id,
    req.me.id
  );
  if (!form) return notFound(res, 'tax form');
  const pdf = await buildForm1099Pdf(
    { ...form, maskedRecipientTin: tax.maskedTin(form.recipient.tin_type, form.recipient.tin_last4), recipientTin: '' },
    ['B', '2']
  );
  await logActivity(req, `${employeeName(req.me)} downloaded their ${form.tax_year} 1099-NEC`);
  res.attachment(`1099-NEC_${form.tax_year}.pdf`);
  res.type('application/pdf').send(pdf);
});

module.exports = router;
