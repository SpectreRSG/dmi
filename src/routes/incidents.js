// Use of force and incident reports: the officer's pages (/my/incidents) and
// the admins' (/incidents). See services/incidentReports.js for how they work.
const express = require('express');
const db = require('../db');
const time = require('../time');
const ir = require('../services/incidentReports');
const { notifyAdmins, notifyEmployees } = require('../services/notify');
const { saveUpload, sendUpload, deleteUpload, UploadError } = require('../uploads');
const { logActivity, notFound, numericIdParam } = require('../helpers');

const SHIFTS_BACK_DAYS = 3; // a report can start from any of the officer's shifts in the last 3 days

const shortName = (r) => `${r.first_name} ${r.last_name.charAt(0)}.`;
const typesText = (r) => ir.typeLabels(r.data || {}).join(', ') || 'Incident';
const ATTEST = 'I have reviewed this account. It distinguishes my observations from information supplied by others and identifies estimates or information I do not know. If I later identify an error or additional information, I will submit a dated supplement that preserves this original account.';

// Adds a photo or document to a report. Returns an error message, or null.
async function addFile(req, report) {
  let saved;
  try {
    saved = await saveUpload(req.file);
  } catch (err) {
    if (err instanceof UploadError) return err.message;
    throw err;
  }
  if (!saved) return 'Choose a photo or file first.';
  const note = String(req.body.note || '').trim().slice(0, 200) || null;
  await db.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO incident_report_files (report_id, file_name, file_original, note, uploaded_by) VALUES (?, ?, ?, ?, ?)',
      report.id, saved.file_name, saved.file_original, note, req.user.id
    );
    if (report.status !== 'draft') await ir.addEvent(tx, report.id, req.user, 'file', saved.file_original);
  });
  return null;
}

async function sendFile(req, res, report) {
  const file = await db.get('SELECT * FROM incident_report_files WHERE id = ? AND report_id = ?', Number(req.params.fileId) || 0, report.id);
  if (!file) return notFound(res, 'file');
  return sendUpload(res, file.file_name, file.file_original, { inline: true });
}

async function sendPdf(req, res, report) {
  const [events, files] = await Promise.all([ir.eventsFor(report.id), ir.filesFor(report.id)]);
  const pdf = await ir.pdfFor(report, { events, files, settings: res.locals.settings });
  await logActivity(req, `Downloaded incident report ${report.number} (PDF)`);
  res.type('pdf');
  res.set('Content-Disposition', `inline; filename="Incident_Report_${report.number}.pdf"`);
  res.removeHeader('Content-Security-Policy'); // lets the browser's own PDF viewer show it
  res.send(pdf);
}

// ---- The officer's pages -----------------------------------------------------------------

const officer = express.Router();
numericIdParam(officer);

officer.use(async (req, res, next) => {
  const me = req.user.role === 'officer' && req.user.employee_id
    ? await db.get('SELECT * FROM employees WHERE id = ?', req.user.employee_id)
    : null;
  if (!me) {
    return res.status(403).render('error', {
      title: 'Not set up yet',
      message: req.user.role === 'officer'
        ? "Your account isn't linked to your staff record yet. Please ask the office to finish setting it up."
        : 'Incident reports are written by officers.',
    });
  }
  req.me = me;
  next();
});

async function ownReport(req, res) {
  const report = await ir.find(Number(req.params.id));
  if (!report || report.employee_id !== req.me.id) {
    notFound(res, 'report');
    return null;
  }
  return report;
}

officer.get('/', async (req, res) => {
  const reports = await db.all(
    `SELECT r.*, si.name AS site_name FROM incident_reports r LEFT JOIN sites si ON si.id = r.site_id
     WHERE r.employee_id = ? ORDER BY (r.status = 'draft') DESC, r.created_at DESC, r.id DESC`,
    req.me.id
  );
  res.render('incidents/officer-list', { title: 'Incident reports', reports, typesText, STATUS_LABELS: ir.STATUS_LABELS });
});

// Starting a report: which shift was it on?
officer.get('/new', async (req, res) => {
  const now = time.nowStr();
  const [shifts, sites] = await Promise.all([
    db.all(
      `SELECT s.*, si.name AS site_name, c.name AS client_name FROM shifts s
       JOIN sites si ON si.id = s.site_id JOIN clients c ON c.id = si.client_id
       WHERE s.employee_id = ? AND s.status != 'cancelled' AND s.start_at <= ? AND s.end_at >= ?
       ORDER BY s.start_at DESC`,
      req.me.id, now, `${time.addDays(time.todayStr(), -SHIFTS_BACK_DAYS)}T00:00`
    ),
    db.all('SELECT si.id, si.name, c.name AS client_name FROM sites si JOIN clients c ON c.id = si.client_id WHERE si.active = 1 ORDER BY c.name, si.name'),
  ]);
  res.render('incidents/officer-new', { title: 'New incident report', shifts, sites });
});

officer.post('/', async (req, res) => {
  const shift = req.body.shift_id
    ? await db.get(
      `SELECT s.*, si.name AS site_name FROM shifts s JOIN sites si ON si.id = s.site_id
       WHERE s.id = ? AND s.employee_id = ? AND s.status != 'cancelled'`,
      Number(req.body.shift_id) || 0, req.me.id
    )
    : null;
  const siteId = shift?.site_id || Number(req.body.site_id) || null;
  const site = siteId
    ? await db.get('SELECT si.*, c.name AS client_name FROM sites si JOIN clients c ON c.id = si.client_id WHERE si.id = ?', siteId)
    : null;
  const id = await ir.create({ employee: req.me, user: req.user, shift, site, settings: res.locals.settings });
  res.redirect(`/my/incidents/${id}`);
});

// A draft: the form. Sent: the report as sent, with supplements and files.
officer.get('/:id', async (req, res) => {
  const report = await ownReport(req, res);
  if (!report) return;
  const [events, files] = await Promise.all([ir.eventsFor(report.id), ir.filesFor(report.id)]);
  if (report.status === 'draft') {
    return res.render('incidents/form', { title: `Incident report ${report.number}`, report, data: report.data, files, error: null, ATTEST, SECTIONS: ir.SECTIONS });
  }
  const asked = [...events].reverse().find((e) => e.kind === 'info_requested');
  res.render('incidents/officer-show', {
    title: `Incident report ${report.number}`,
    report,
    events,
    files,
    sections: ir.present(ir.SECTIONS, report.data),
    asked: report.status === 'info_requested' ? asked : null,
    STATUS_LABELS: ir.STATUS_LABELS,
    EVENT_LABELS: ir.EVENT_LABELS,
  });
});

// Saves the draft, or signs and sends it.
officer.post('/:id', async (req, res) => {
  const report = await ownReport(req, res);
  if (!report) return;
  if (report.status !== 'draft') {
    req.flash('error', 'This report has already been sent, so it can\'t be changed. Add a supplement instead.');
    return res.redirect(`/my/incidents/${report.id}`);
  }
  const data = ir.readAnswers(req.body, ir.OFFICER_BOXES);
  await ir.saveDraft(report, data);
  if (req.body.action !== 'submit') {
    req.flash('success', 'Draft saved. Only you can see it until you sign and send it.');
    return res.redirect(`/my/incidents/${report.id}`);
  }
  const signature = String(req.body.signature || '');
  const problem = ir.submitProblem(data, { attest: req.body.attest === '1', signature });
  if (problem) {
    const files = await ir.filesFor(report.id);
    return res.status(400).render('incidents/form', {
      title: `Incident report ${report.number}`, report: { ...report, updated_ms: Date.now() }, data, files, error: problem, ATTEST, SECTIONS: ir.SECTIONS, signature,
    });
  }
  await ir.submit(report, data, { signature, user: req.user, ip: req.ip });
  const sent = await ir.find(report.id);
  await logActivity(req, `Sent incident report ${sent.number} (${typesText(sent)})`);
  const discharge = ir.firearmDischarge(sent.data);
  await notifyAdmins({
    title: `${discharge ? 'Firearm discharge: ' : ''}Incident report ${sent.number} from ${shortName(sent)}`,
    body: `${typesText(sent)}${sent.data.site_client ? ` at ${sent.data.site_client}` : ''}, ${time.fmtDay(sent.incident_date)}. Tap to review.`,
    url: `/incidents/${sent.id}`,
    tag: `incident-${sent.id}`,
  });
  req.flash('success', `Report ${sent.number} was sent to the office. You'll get a notification when it's reviewed.`);
  res.redirect(`/my/incidents/${sent.id}`);
});

officer.post('/:id/delete', async (req, res) => {
  const report = await ownReport(req, res);
  if (!report) return;
  if (report.status !== 'draft') {
    req.flash('error', 'Sent reports are kept for 5 years and can\'t be deleted.');
    return res.redirect(`/my/incidents/${report.id}`);
  }
  const files = await ir.filesFor(report.id);
  await db.run("DELETE FROM incident_reports WHERE id = ? AND status = 'draft'", report.id);
  for (const f of files) await deleteUpload(f.file_name);
  req.flash('success', 'Draft deleted.');
  res.redirect('/my/incidents');
});

// Something to add after sending: a dated supplement (the original stays as it was).
officer.post('/:id/supplement', async (req, res) => {
  const report = await ownReport(req, res);
  if (!report) return;
  const note = String(req.body.note || '').replace(/\r\n/g, '\n').trim().slice(0, 10000);
  if (report.status === 'draft' || !note) {
    req.flash('error', report.status === 'draft' ? 'Add it to the draft instead.' : 'Write the supplement first.');
    return res.redirect(`/my/incidents/${report.id}`);
  }
  await db.transaction(async (tx) => {
    await ir.addEvent(tx, report.id, req.user, 'supplement', note);
    if (report.status !== 'submitted') {
      // More information was asked for, or it was approved: back to the admins to review.
      await tx.run("UPDATE incident_reports SET status = 'submitted' WHERE id = ?", report.id);
      if (report.status === 'approved') await ir.addEvent(tx, report.id, null, 'reopened');
    }
  });
  await logActivity(req, `Added a supplement to incident report ${report.number}`);
  await notifyAdmins({
    title: `Supplement: incident report ${report.number}`,
    body: `${shortName(report)} added to their report. Tap to review.`,
    url: `/incidents/${report.id}`,
    tag: `incident-${report.id}`,
  });
  req.flash('success', 'Supplement added and sent to the office. Your original report is unchanged.');
  res.redirect(`/my/incidents/${report.id}`);
});

officer.post('/:id/files', async (req, res) => {
  const report = await ownReport(req, res);
  if (!report) return;
  const problem = await addFile(req, report);
  req.flash(problem ? 'error' : 'success', problem || 'File added.');
  res.redirect(`/my/incidents/${report.id}#files`);
});

officer.get('/:id/files/:fileId', async (req, res) => {
  const report = await ownReport(req, res);
  if (report) await sendFile(req, res, report);
});

officer.post('/:id/files/:fileId/delete', async (req, res) => {
  const report = await ownReport(req, res);
  if (!report) return;
  const file = await db.get('SELECT * FROM incident_report_files WHERE id = ? AND report_id = ?', Number(req.params.fileId) || 0, report.id);
  if (report.status !== 'draft' || !file) {
    req.flash('error', 'Files on a sent report are kept with it.');
  } else {
    await db.run('DELETE FROM incident_report_files WHERE id = ?', file.id);
    await deleteUpload(file.file_name);
    req.flash('success', 'File removed.');
  }
  res.redirect(`/my/incidents/${report.id}#files`);
});

officer.get('/:id/pdf', async (req, res) => {
  const report = await ownReport(req, res);
  if (!report) return;
  if (report.status === 'draft') return res.redirect(`/my/incidents/${report.id}`);
  await sendPdf(req, res, report);
});

// ---- The admins' pages ---------------------------------------------------------------

const admin = express.Router();
numericIdParam(admin);

const VIEWS = {
  review: { label: 'Waiting for review', where: "r.status = 'submitted'" },
  info: { label: 'More information asked for', where: "r.status = 'info_requested'" },
  approved: { label: 'Approved', where: "r.status = 'approved'" },
  expired: { label: 'Past 5 years', where: "r.status <> 'draft' AND r.retain_until <= ? AND r.legal_hold = 0" },
  all: { label: 'All', where: "r.status <> 'draft'" },
};

admin.get('/', async (req, res) => {
  const view = VIEWS[req.query.view] ? req.query.view : 'review';
  const q = String(req.query.q || '').trim().slice(0, 80);
  const params = view === 'expired' ? [time.todayStr()] : [];
  let where = VIEWS[view].where;
  if (q) {
    where += " AND (r.number ILIKE ? OR e.first_name || ' ' || e.last_name ILIKE ? OR COALESCE(r.data->>'site_client', '') ILIKE ?)";
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const [reports, counts] = await Promise.all([
    db.all(
      `SELECT r.*, e.first_name, e.last_name FROM incident_reports r JOIN employees e ON e.id = r.employee_id
       WHERE ${where} ORDER BY r.incident_date DESC NULLS LAST, r.id DESC LIMIT 200`,
      ...params
    ),
    db.all("SELECT status, COUNT(*)::int AS n FROM incident_reports WHERE status <> 'draft' GROUP BY status"),
  ]);
  for (const r of reports) r.deadlines = ir.deadlines(r);
  res.render('incidents/admin-list', {
    title: 'Incident reports',
    reports,
    view,
    q,
    VIEWS,
    count: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    typesText,
    STATUS_LABELS: ir.STATUS_LABELS,
  });
});

async function adminReport(req, res) {
  const report = await ir.find(Number(req.params.id));
  if (!report || report.status === 'draft') {
    notFound(res, 'report');
    return null;
  }
  return report;
}

admin.get('/:id', async (req, res) => {
  const report = await adminReport(req, res);
  if (!report) return;
  const [events, files] = await Promise.all([ir.eventsFor(report.id), ir.filesFor(report.id)]);
  res.render('incidents/admin-show', {
    title: `Incident report ${report.number}`,
    report,
    events,
    files,
    sections: ir.present(ir.SECTIONS, report.data, { forAdmin: true }),
    deadlines: ir.deadlines(report),
    deleteProblem: ir.deleteProblem(report),
    REVIEW_SECTIONS: ir.REVIEW_SECTIONS,
    DUTIES: ir.DUTIES,
    STATUS_LABELS: ir.STATUS_LABELS,
    EVENT_LABELS: ir.EVENT_LABELS,
    typesText,
  });
});

// The review (page 7): what was reported where, what's still open.
admin.post('/:id/review', async (req, res) => {
  const report = await adminReport(req, res);
  if (!report) return;
  const review = {
    ...ir.readAnswers(req.body, ir.REVIEW_BOXES),
    reviewer_name: `${req.user.name}, ${req.user.role === 'admin' ? 'Administrator' : 'Manager'}`,
    review_datetime: ir.fmtStamp(time.nowStr()),
  };
  await db.transaction(async (tx) => {
    await tx.run('UPDATE incident_reports SET review = ? WHERE id = ?', JSON.stringify(review), report.id);
    await ir.addEvent(tx, report.id, req.user, 'review_saved');
  });
  req.flash('success', 'Review saved.');
  res.redirect(`/incidents/${report.id}#review`);
});

admin.post('/:id/request-info', async (req, res) => {
  const report = await adminReport(req, res);
  if (!report) return;
  const note = String(req.body.note || '').replace(/\r\n/g, '\n').trim().slice(0, 2000);
  if (!note) {
    req.flash('error', 'Say what information you need.');
    return res.redirect(`/incidents/${report.id}#actions`);
  }
  await db.transaction(async (tx) => {
    await tx.run("UPDATE incident_reports SET status = 'info_requested' WHERE id = ?", report.id);
    await ir.addEvent(tx, report.id, req.user, 'info_requested', note);
  });
  await logActivity(req, `Asked for more information on incident report ${report.number}`);
  await notifyEmployees([report.employee_id], {
    title: `More information needed: report ${report.number}`,
    body: `${note.slice(0, 140)}${note.length > 140 ? '…' : ''} Tap to add a supplement.`,
    url: `/my/incidents/${report.id}`,
    tag: `incident-${report.id}`,
  });
  req.flash('success', 'Sent to the officer. They add their answer as a supplement, and it comes back here for review.');
  res.redirect(`/incidents/${report.id}`);
});

admin.post('/:id/approve', async (req, res) => {
  const report = await adminReport(req, res);
  if (!report) return;
  const note = String(req.body.note || '').trim().slice(0, 2000) || null;
  await db.transaction(async (tx) => {
    await tx.run("UPDATE incident_reports SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?", req.user.id, time.nowStr(), report.id);
    await ir.addEvent(tx, report.id, req.user, 'approved', note);
  });
  await logActivity(req, `Approved incident report ${report.number}`);
  await notifyEmployees([report.employee_id], {
    title: `Report ${report.number} approved`,
    body: 'The office has reviewed and approved your incident report. Nothing more to do.',
    url: `/my/incidents/${report.id}`,
    tag: `incident-${report.id}`,
  });
  req.flash('success', `Report ${report.number} approved. The officer has been told. It's kept until ${time.fmtDate(report.retain_until)}.`);
  res.redirect(`/incidents/${report.id}`);
});

// Legal hold: keep it beyond 5 years (e.g. a claim or lawsuit).
admin.post('/:id/hold', async (req, res) => {
  const report = await adminReport(req, res);
  if (!report) return;
  const on = req.body.hold === '1';
  await db.transaction(async (tx) => {
    await tx.run('UPDATE incident_reports SET legal_hold = ? WHERE id = ?', on ? 1 : 0, report.id);
    await ir.addEvent(tx, report.id, req.user, on ? 'hold_on' : 'hold_off');
  });
  await logActivity(req, `${on ? 'Put' : 'Took'} incident report ${report.number} ${on ? 'on' : 'off'} legal hold`);
  req.flash('success', on ? 'On legal hold: it will be kept until you take it off.' : `Legal hold taken off. It can be deleted after ${time.fmtDate(report.retain_until)}.`);
  res.redirect(`/incidents/${report.id}`);
});

// Only once its 5 years are up (and not on hold). The database checks too.
admin.post('/:id/delete', async (req, res) => {
  const report = await adminReport(req, res);
  if (!report) return;
  const problem = ir.deleteProblem(report);
  if (problem) {
    req.flash('error', `This report can't be deleted yet. ${problem}`);
    return res.redirect(`/incidents/${report.id}`);
  }
  const files = await ir.filesFor(report.id);
  await db.run('DELETE FROM incident_reports WHERE id = ?', report.id);
  for (const f of files) await deleteUpload(f.file_name);
  await logActivity(req, `Deleted incident report ${report.number} (its ${ir.RETAIN_YEARS} years were up)`);
  req.flash('success', `Report ${report.number} and its files were deleted.`);
  res.redirect('/incidents?view=expired');
});

admin.post('/:id/files', async (req, res) => {
  const report = await adminReport(req, res);
  if (!report) return;
  const problem = await addFile(req, report);
  req.flash(problem ? 'error' : 'success', problem || 'File added.');
  res.redirect(`/incidents/${report.id}#files`);
});

admin.get('/:id/files/:fileId', async (req, res) => {
  const report = await adminReport(req, res);
  if (report) await sendFile(req, res, report);
});

admin.get('/:id/pdf', async (req, res) => {
  const report = await adminReport(req, res);
  if (report) await sendPdf(req, res, report);
});

module.exports = { officerRouter: officer, adminRouter: admin };
