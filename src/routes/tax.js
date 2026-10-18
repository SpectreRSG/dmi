// 1099-NEC forms (admins only): who needs one for a year, making and issuing
// them, the PDFs, and a filing summary for sending Copy A to the IRS.
const express = require('express');
const db = require('../db');
const { toId, toNumber, notFound, numericIdParam, logActivity, employeeName } = require('../helpers');
const time = require('../time');
const tax = require('../services/tax1099');
const { buildForm1099Pdf } = require('../services/form1099Pdf');

const router = express.Router();
numericIdParam(router);

// In January–April people are usually doing last year's forms.
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
  SELECT f.*, e.first_name, e.last_name, tp.electronic_consent
  FROM tax_forms f JOIN employees e ON e.id = f.employee_id
  LEFT JOIN tax_profiles tp ON tp.employee_id = f.employee_id`;

router.get('/', async (req, res) => {
  const year = readYear(req.query.year);
  const [payments, forms, profiles, staff, years] = await Promise.all([
    tax.paymentsForYear(year),
    db.all(`${FORM_SELECT} WHERE f.tax_year = ?`, year),
    db.all('SELECT * FROM tax_profiles'),
    db.all('SELECT * FROM employees ORDER BY last_name, first_name'),
    db.all(
      `SELECT DISTINCT substr(COALESCE(paid_on, finalized_at), 1, 4) AS year FROM pay_runs WHERE status = 'finalized'
       UNION SELECT DISTINCT tax_year::text FROM tax_forms`
    ),
  ]);
  const formBy = new Map(forms.map((f) => [f.employee_id, f]));
  const profileBy = new Map(profiles.map((p) => [p.employee_id, p]));
  const threshold = tax.filingThreshold(year);
  const rows = staff
    .filter((e) => payments.has(e.id) || formBy.has(e.id))
    .map((e) => {
      const paid = payments.get(e.id)?.total || 0;
      const profile = profileBy.get(e.id);
      return {
        employee: e,
        paid,
        overThreshold: paid >= threshold,
        profile,
        corporation: profile ? tax.isCorporation(profile) : false,
        form: formBy.get(e.id),
      };
    })
    .sort((a, b) => b.paid - a.paid);
  const yearOptions = [...new Set([...years.map((y) => Number(y.year)), defaultYear(), Number(time.todayStr().slice(0, 4))])]
    .filter(Boolean)
    .sort((a, b) => b - a);

  res.render('tax/index', {
    title: `1099 forms ${year}`,
    year,
    yearOptions,
    threshold,
    rows,
    payerMissing: tax.payerMissing(res.locals.settings),
  });
});

// Copies the latest pay total, W-9 and company details into a draft form.
async function freshNumbers(employee, year, settings) {
  const profile = await db.get('SELECT * FROM tax_profiles WHERE employee_id = ?', employee.id);
  if (!profile) return { error: `${employeeName(employee)} hasn't filled in their W-9 details yet (they do it under Tax forms in their account).` };
  if (tax.payerMissing(settings)) return { error: 'Fill in the company\'s 1099 details in Settings first.' };
  const paid = (await tax.paymentsForYear(year)).get(employee.id)?.total || 0;
  return {
    box1: paid,
    payer: tax.payerFromSettings(settings),
    recipient: tax.recipientFromProfile(profile, employee),
    box6: [settings.payer_state, settings.payer_state_id].filter(Boolean).join(' '),
  };
}

router.post('/forms', async (req, res) => {
  const year = readYear(req.body.year);
  const employee = await db.get('SELECT * FROM employees WHERE id = ?', toId(req.body.employee_id));
  if (!employee) return notFound(res, 'staff member');
  const back = `/tax?year=${year}`;
  if (await db.get('SELECT 1 FROM tax_forms WHERE employee_id = ? AND tax_year = ?', employee.id, year)) {
    req.flash('warning', 'There is already a 1099 for that person and year.');
    return res.redirect(back);
  }
  const fresh = await freshNumbers(employee, year, res.locals.settings);
  if (fresh.error) {
    req.flash('error', fresh.error);
    return res.redirect(back);
  }
  const id = await db.insert(
    `INSERT INTO tax_forms (employee_id, tax_year, box1, box6, box7, payer, recipient, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    employee.id, year, fresh.box1, fresh.box6 || null, fresh.box6 ? fresh.box1 : 0, JSON.stringify(fresh.payer), JSON.stringify(fresh.recipient), req.user.id
  );
  await logActivity(req, `Started a ${year} 1099-NEC for ${employeeName(employee)}`);
  res.redirect(`/tax/forms/${id}`);
});

async function findForm(id) {
  return db.get(`${FORM_SELECT} WHERE f.id = ?`, id);
}

router.get('/forms/:id', async (req, res) => {
  const form = await findForm(req.params.id);
  if (!form) return notFound(res, '1099');
  const [profile, paid] = await Promise.all([
    db.get('SELECT backup_withholding, tax_classification, llc_classification, updated_at FROM tax_profiles WHERE employee_id = ?', form.employee_id),
    tax.paymentsForYear(form.tax_year).then((m) => m.get(form.employee_id)?.total || 0),
  ]);
  res.render('tax/form', {
    title: `1099-NEC ${form.tax_year}: ${employeeName(form)}`,
    form,
    profile,
    paidNow: paid,
    maskedTin: tax.maskedTin(form.recipient.tin_type, form.recipient.tin_last4),
    threshold: tax.filingThreshold(form.tax_year),
  });
});

router.post('/forms/:id', async (req, res) => {
  const form = await findForm(req.params.id);
  if (!form) return notFound(res, '1099');
  const back = `/tax/forms/${form.id}`;
  if (form.status !== 'draft') {
    req.flash('error', 'This form has been issued. Make a corrected form to change it.');
    return res.redirect(back);
  }
  const amounts = Object.fromEntries(['box1', 'box4', 'box5', 'box7'].map((b) => [b, toNumber(req.body[b], 0)]));
  if (Object.values(amounts).some((n) => Number.isNaN(n) || n < 0 || n > 10000000)) {
    req.flash('error', 'Amounts must be numbers, like 1234.56.');
    return res.redirect(back);
  }
  await db.run(
    'UPDATE tax_forms SET box1 = ?, box4 = ?, box5 = ?, box6 = ?, box7 = ? WHERE id = ?',
    amounts.box1, amounts.box4, amounts.box5, String(req.body.box6 || '').trim().slice(0, 40) || null, amounts.box7, form.id
  );
  await logActivity(req, `Edited the ${form.tax_year} 1099-NEC for ${employeeName(form)}`);
  req.flash('success', 'Saved.');
  res.redirect(back);
});

router.post('/forms/:id/refresh', async (req, res) => {
  const form = await findForm(req.params.id);
  if (!form) return notFound(res, '1099');
  const back = `/tax/forms/${form.id}`;
  if (form.status !== 'draft') return res.redirect(back);
  const employee = await db.get('SELECT * FROM employees WHERE id = ?', form.employee_id);
  const fresh = await freshNumbers(employee, form.tax_year, res.locals.settings);
  if (fresh.error) {
    req.flash('error', fresh.error);
    return res.redirect(back);
  }
  await db.run(
    'UPDATE tax_forms SET box1 = ?, payer = ?, recipient = ? WHERE id = ?',
    fresh.box1, JSON.stringify(fresh.payer), JSON.stringify(fresh.recipient), form.id
  );
  req.flash('success', 'Updated from the latest pay runs, W-9 details and company settings.');
  res.redirect(back);
});

// Issued = final. It can't be changed after this (only replaced by a corrected form).
router.post('/forms/:id/issue', async (req, res) => {
  const form = await findForm(req.params.id);
  if (!form) return notFound(res, '1099');
  if (form.status === 'draft') {
    await db.run("UPDATE tax_forms SET status = 'issued', issued_at = app_now() WHERE id = ?", form.id);
    await logActivity(req, `Issued the ${form.tax_year} 1099-NEC${form.corrected ? ' (corrected)' : ''} for ${employeeName(form)} ($${form.box1})`);
    req.flash('success', 'Marked as issued. Give the officer their copy and file Copy A with the IRS (see the filing summary).');
  }
  res.redirect(`/tax/forms/${form.id}`);
});

router.post('/forms/:id/correct', async (req, res) => {
  const form = await findForm(req.params.id);
  if (!form) return notFound(res, '1099');
  if (form.status === 'issued') {
    await db.run("UPDATE tax_forms SET status = 'draft', corrected = 1, released = 0 WHERE id = ?", form.id);
    await logActivity(req, `Started a corrected ${form.tax_year} 1099-NEC for ${employeeName(form)}`);
    req.flash('warning', 'This is now a CORRECTED draft. Fix it, issue it again, and file the correction with the IRS too.');
  }
  res.redirect(`/tax/forms/${form.id}`);
});

// Let the officer download it from their account. Only allowed if they agreed
// to get it online instead of on paper (an IRS rule).
router.post('/forms/:id/release', async (req, res) => {
  const form = await findForm(req.params.id);
  if (!form) return notFound(res, '1099');
  const release = req.body.release === '1';
  if (release && (form.status !== 'issued' || !form.electronic_consent)) {
    req.flash('error', 'Only issued forms can be shared online, and only with officers who agreed to get it online. Otherwise, print it and give or mail it to them.');
  } else {
    await db.run('UPDATE tax_forms SET released = ? WHERE id = ?', release ? 1 : 0, form.id);
    await logActivity(req, `${release ? 'Shared' : 'Stopped sharing'} the ${form.tax_year} 1099-NEC with ${employeeName(form)} online`);
    req.flash('success', release
      ? `Shared. Now let ${form.first_name} know it's ready (email, text or in person): the IRS requires you to tell them.`
      : 'No longer shown in their account.');
  }
  res.redirect(`/tax/forms/${form.id}`);
});

router.post('/forms/:id/delete', async (req, res) => {
  const form = await findForm(req.params.id);
  if (!form) return notFound(res, '1099');
  if (form.status !== 'draft' || form.corrected) {
    req.flash('error', 'Only drafts that were never issued can be deleted.');
    return res.redirect(`/tax/forms/${form.id}`);
  }
  await db.run('DELETE FROM tax_forms WHERE id = ?', form.id);
  await logActivity(req, `Deleted a draft ${form.tax_year} 1099-NEC for ${employeeName(form)}`);
  req.flash('success', 'Draft deleted.');
  res.redirect(`/tax?year=${form.tax_year}`);
});

// What goes into the PDF, with the tax ID numbers unscrambled as needed.
async function pdfData(form) {
  return {
    ...form,
    recipientTin: await tax.fullTin(form.recipient),
    maskedRecipientTin: tax.maskedTin(form.recipient.tin_type, form.recipient.tin_last4),
  };
}

router.get('/forms/:id/pdf', async (req, res) => {
  const form = await findForm(req.params.id);
  if (!form) return notFound(res, '1099');
  const forPayer = req.query.copy === 'payer';
  const pdf = await buildForm1099Pdf(await pdfData(form), forPayer ? ['C', '1'] : ['B', '2']);
  await logActivity(req, `Downloaded the ${form.tax_year} 1099-NEC (${forPayer ? 'company copies' : 'officer copies'}) for ${employeeName(form)}`);
  const who = `${form.last_name}_${form.first_name}`.replace(/[^A-Za-z0-9_-]+/g, '');
  res.attachment(`1099-NEC_${form.tax_year}_${who}${forPayer ? '_Copy_C_1' : '_Copy_B_2'}${form.status === 'draft' ? '_DRAFT' : ''}.pdf`);
  res.type('application/pdf').send(pdf);
});

// Everything needed to file Copy A online with the IRS (IRIS) or on the red forms.
router.get('/filing', async (req, res) => {
  const year = readYear(req.query.year);
  const forms = await db.all(`${FORM_SELECT} WHERE f.tax_year = ? AND f.status = 'issued' ORDER BY e.last_name, e.first_name`, year);
  for (const form of forms) form.fullTin = await tax.fullTin(form.recipient);
  await logActivity(req, `Opened the ${year} 1099 filing summary (shows full tax ID numbers)`);
  res.set('Cache-Control', 'no-store');
  res.render('tax/filing', {
    title: `1099-NEC filing summary ${year}`,
    year,
    forms,
    payer: tax.payerFromSettings(res.locals.settings),
    totals: {
      box1: forms.reduce((sum, f) => sum + f.box1, 0),
      box4: forms.reduce((sum, f) => sum + f.box4, 0),
    },
  });
});

module.exports = router;
