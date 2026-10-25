// Year-end Forms W-2 for W-2 employees (admins only): make them from the
// year's finalized pay, check them, issue them, give or share the employee's
// copies, and file with Social Security online using the summary.
const express = require('express');
const db = require('../db');
const { notFound, numericIdParam, logActivity, employeeName, toId } = require('../helpers');
const time = require('../time');
const w2 = require('../services/w2');
const { buildFormW2Pdf } = require('../services/formW2Pdf');
const { requireRecentCode } = require('../auth');

const router = express.Router();
numericIdParam(router);

// Until April, the year people want is usually last year.
function defaultYear() {
  const today = time.todayStr();
  const year = Number(today.slice(0, 4));
  return Number(today.slice(5, 7)) <= 4 ? year - 1 : year;
}
function readYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : defaultYear();
}

const FORM_SELECT = `
  SELECT f.*, e.first_name, e.last_name, wp.electronic_consent
  FROM w2_forms f JOIN employees e ON e.id = f.employee_id
  LEFT JOIN withholding_profiles wp ON wp.employee_id = f.employee_id`;

function findForm(id) {
  return db.get(`${FORM_SELECT} WHERE f.id = ?`, id);
}

router.get('/', async (req, res) => {
  const year = readYear(req.query.year);
  const [pay, forms, staff, profiles] = await Promise.all([
    w2.w2PayForYear(year),
    db.all(`${FORM_SELECT} WHERE f.tax_year = ?`, year),
    db.all('SELECT * FROM employees ORDER BY last_name, first_name'),
    db.all('SELECT employee_id, ssn_last4, electronic_consent FROM withholding_profiles'),
  ]);
  const formBy = new Map(forms.map((f) => [f.employee_id, f]));
  const profileBy = new Map(profiles.map((p) => [p.employee_id, p]));
  const rows = staff
    .filter((e) => pay.has(e.id) || formBy.has(e.id))
    .map((e) => ({ employee: e, pay: pay.get(e.id), form: formBy.get(e.id), profile: profileBy.get(e.id) }));
  res.render('w2/index', {
    title: `W-2 forms ${year}`,
    year,
    rows,
    totals: w2.w3Totals(forms),
    issued: forms.filter((f) => f.status === 'issued').length,
    employerMissing: w2.employerMissing(res.locals.settings),
  });
});

router.post('/forms', async (req, res) => {
  const year = readYear(req.body.year);
  const employee = await db.get('SELECT * FROM employees WHERE id = ?', toId(req.body.employee_id));
  if (!employee) return notFound(res, 'staff member');
  const back = `/w2?year=${year}`;
  if (await db.get('SELECT 1 FROM w2_forms WHERE employee_id = ? AND tax_year = ?', employee.id, year)) {
    req.flash('warning', 'There is already a W-2 for that person and year.');
    return res.redirect(back);
  }
  const fresh = await w2.freshW2(employee, year, res.locals.settings);
  if (fresh.error) {
    req.flash('error', fresh.error);
    return res.redirect(back);
  }
  const id = await db.insert(
    'INSERT INTO w2_forms (employee_id, tax_year, boxes, employer, employee, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    employee.id, year, JSON.stringify(fresh.boxes), JSON.stringify(fresh.employer), JSON.stringify(fresh.employee), req.user.id
  );
  await logActivity(req, `Started a ${year} W-2 for ${employeeName(employee)}`);
  res.redirect(`/w2/forms/${id}`);
});

router.get('/forms/:id', async (req, res) => {
  const form = await findForm(req.params.id);
  if (!form) return notFound(res, 'W-2');
  const payNow = (await w2.w2PayForYear(form.tax_year)).get(form.employee_id);
  res.render('w2/form', {
    title: `W-2 ${form.tax_year}: ${employeeName(form)}`,
    form,
    maskedSsn: w2.maskedSsn(form.employee.ssn_last4),
    changed: payNow && Math.abs(Number(payNow.wages) - form.boxes.box1) >= 0.005,
  });
});

router.post('/forms/:id/refresh', async (req, res) => {
  const form = await findForm(req.params.id);
  if (!form) return notFound(res, 'W-2');
  const back = `/w2/forms/${form.id}`;
  if (form.status !== 'draft') return res.redirect(back);
  const employee = await db.get('SELECT * FROM employees WHERE id = ?', form.employee_id);
  const fresh = await w2.freshW2(employee, form.tax_year, res.locals.settings);
  if (fresh.error) {
    req.flash('error', fresh.error);
    return res.redirect(back);
  }
  await db.run(
    'UPDATE w2_forms SET boxes = ?, employer = ?, employee = ? WHERE id = ?',
    JSON.stringify(fresh.boxes), JSON.stringify(fresh.employer), JSON.stringify(fresh.employee), form.id
  );
  req.flash('success', 'Updated from the latest pay runs, W-4 details and company settings.');
  res.redirect(back);
});

// Issued = final. A mistake after this needs a Form W-2c.
router.post('/forms/:id/issue', async (req, res) => {
  const form = await findForm(req.params.id);
  if (!form) return notFound(res, 'W-2');
  if (form.status === 'draft') {
    await db.run("UPDATE w2_forms SET status = 'issued', issued_at = app_now() WHERE id = ?", form.id);
    await logActivity(req, `Issued the ${form.tax_year} W-2 for ${employeeName(form)} ($${form.boxes.box1})`);
    req.flash('success', 'Marked as issued. Give the employee their copies by January 31, and file it with Social Security (see the filing summary).');
  }
  res.redirect(`/w2/forms/${form.id}`);
});

// Let the employee download it from their account. Only if they agreed to get
// it online instead of on paper (an IRS rule).
router.post('/forms/:id/release', async (req, res) => {
  const form = await findForm(req.params.id);
  if (!form) return notFound(res, 'W-2');
  const release = req.body.release === '1';
  if (release && (form.status !== 'issued' || !form.electronic_consent)) {
    req.flash('error', 'Only issued W-2s can be shared online, and only with employees who agreed to get it online. Otherwise, print it and give or mail it to them.');
  } else {
    await db.run('UPDATE w2_forms SET released = ? WHERE id = ?', release ? 1 : 0, form.id);
    await logActivity(req, `${release ? 'Shared' : 'Stopped sharing'} the ${form.tax_year} W-2 with ${employeeName(form)} online`);
    req.flash('success', release
      ? `Shared. Now let ${form.first_name} know it's ready (email, text or in person): the IRS requires you to tell them.`
      : 'No longer shown in their account.');
  }
  res.redirect(`/w2/forms/${form.id}`);
});

router.post('/forms/:id/delete', async (req, res) => {
  const form = await findForm(req.params.id);
  if (!form) return notFound(res, 'W-2');
  if (form.status !== 'draft') {
    req.flash('error', 'Only drafts can be deleted.');
    return res.redirect(`/w2/forms/${form.id}`);
  }
  await db.run('DELETE FROM w2_forms WHERE id = ?', form.id);
  await logActivity(req, `Deleted a draft ${form.tax_year} W-2 for ${employeeName(form)}`);
  req.flash('success', 'Draft deleted.');
  res.redirect(`/w2?year=${form.tax_year}`);
});

// The company's copy (D) has the full Social Security number, so it asks for a
// fresh two-step code first. The employee's copies (B, C, 2) show only the last 4.
const fullNumbersNeedCode = (req, res, next) => (req.query.copy === 'employer' ? requireRecentCode(req, res, next) : next());

async function pdfFor(form, forEmployer) {
  return buildFormW2Pdf(
    { ...form, ssn: forEmployer ? await w2.fullSsn(form.employee) : null, maskedSsn: w2.maskedSsn(form.employee.ssn_last4) },
    forEmployer ? ['D'] : ['B', 'C', '2']
  );
}

function pdfName(form, forEmployer) {
  const who = `${form.last_name}_${form.first_name}`.replace(/[^A-Za-z0-9_-]+/g, '');
  return `W-2_${form.tax_year}_${who}${forEmployer ? '_Copy_D' : '_Copy_B_C_2'}${form.status === 'draft' ? '_DRAFT' : ''}.pdf`;
}

router.get('/forms/:id/pdf', fullNumbersNeedCode, async (req, res) => {
  const form = await findForm(req.params.id);
  if (!form) return notFound(res, 'W-2');
  const forEmployer = req.query.copy === 'employer';
  const pdf = await pdfFor(form, forEmployer);
  await logActivity(req, `Downloaded the ${form.tax_year} W-2 (${forEmployer ? 'company copy' : 'employee copies'}) for ${employeeName(form)}`);
  res.attachment(pdfName(form, forEmployer));
  res.type('application/pdf').send(pdf);
});

// Everything to type into Social Security's W-2 Online (it makes the W-3 from them).
router.get('/summary', requireRecentCode, async (req, res) => {
  const year = readYear(req.query.year);
  const forms = await db.all(`${FORM_SELECT} WHERE f.tax_year = ? AND f.status = 'issued' ORDER BY e.last_name, e.first_name`, year);
  for (const form of forms) form.fullSsn = await w2.fullSsn(form.employee);
  await logActivity(req, `Opened the ${year} W-2 filing summary (shows full Social Security numbers)`);
  res.set('Cache-Control', 'no-store');
  res.render('w2/summary', { title: `W-2 filing summary ${year}`, year, forms, totals: w2.w3Totals(forms), employer: forms[0]?.employer || null });
});

module.exports = router;
module.exports.pdfFor = pdfFor;
module.exports.pdfName = pdfName;
