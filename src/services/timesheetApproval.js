// When the office has finished checking an officer's timesheet (no days left
// waiting for approval), make the approved copy of their signed PDF and email
// it to them.
const db = require('../db');
const time = require('../time');
const sheets = require('./officerTimesheet');
const { saveUpload, readUpload } = require('../uploads');
const { queueEmail } = require('./outbox');
const { entryHours, round2 } = require('./payroll');

const SUBMISSION_SELECT = `
  SELECT s.*, e.first_name, e.last_name, u.name AS approver_name
  FROM timesheet_submissions s JOIN employees e ON e.id = s.employee_id
  LEFT JOIN users u ON u.id = s.approved_by`;

// The officer's sign-in email, or the email on their staff record.
async function officerEmail(employeeId) {
  const account = await db.get('SELECT email FROM users WHERE employee_id = ? AND active = 1', employeeId);
  return account?.email || (await db.get('SELECT email FROM employees WHERE id = ?', employeeId))?.email || null;
}

// Fills in "APPROVED BY" on the officer's signed PDF and saves it.
async function makeApprovedCopy(submission) {
  const original = await readUpload(submission.file_name);
  if (!original) throw new Error('The signed timesheet PDF is missing.');
  const date = (submission.approved_at || time.nowStr()).slice(0, 10);
  const pdf = await sheets.stampApproval(original, { approver: submission.approver_name || 'Office', date });
  const stored = await saveUpload({ originalname: 'timesheet-approved.pdf', buffer: pdf, size: pdf.length });
  await db.run('UPDATE timesheet_submissions SET approved_file_name = ? WHERE id = ?', stored.file_name, submission.id);
  return stored.file_name;
}

function approvalEmail(submission, entries, { siteUrl, companyName }) {
  const period = sheets.periodLabel(submission.period_start);
  const approved = entries.filter((e) => e.status === 'approved');
  const rejected = entries.filter((e) => e.status === 'rejected');
  const hours = round2(approved.reduce((sum, e) => sum + entryHours(e), 0));
  const lines = [
    `Hi ${submission.first_name},`,
    '',
    `The office approved your timesheet for the pay period ${period}: ${approved.length} day(s), ${sheets.fmtHours(hours)} hours.`,
  ];
  if (rejected.length) {
    lines.push('', `These days were not accepted: ${rejected.map((e) => sheets.short(e.start_at.slice(0, 10))).join(', ')}. Please contact the office about them.`);
  }
  lines.push(
    '',
    'Your signed timesheet is attached as a PDF, with the approval filled in.',
    `Approved by ${submission.approver_name || 'the office'} on ${time.fmtDate(submission.approved_at.slice(0, 10))}.`,
    '',
    `You can see all your timesheets at ${siteUrl}/my/timesheets`,
    '',
    companyName
  );
  return {
    subject: `Your timesheet for ${period} was approved`,
    body: lines.join('\n'),
    attachments: [{ filename: `DMI_Timesheet_${submission.period_start}_to_${submission.period_end}_approved.pdf`, file: submission.approved_file_name }],
    submissionId: submission.id,
  };
}

// Queues the approval email for one submission (making the approved copy if
// it isn't there yet). Returns the email's id, or null if there's no address.
async function queueApprovalEmail(submissionId, site) {
  const submission = await db.get(`${SUBMISSION_SELECT} WHERE s.id = ?`, submissionId);
  if (!submission.approved_file_name) submission.approved_file_name = await makeApprovedCopy(submission);
  const to = await officerEmail(submission.employee_id);
  if (!to) return null;
  const entries = await db.all('SELECT * FROM time_entries WHERE submission_id = ? ORDER BY start_at', submissionId);
  return queueEmail(db, { ...approvalEmail(submission, entries, site), to });
}

// Call after approving or rejecting hours. For each officer timesheet that now
// has no days waiting (and at least one approved), records who approved it,
// makes the approved copy and queues the email.
// Returns { emailIds, noEmail: [names], problems: [messages] }.
async function finishCheckedTimesheets(entryIds, user, site) {
  const result = { emailIds: [], noEmail: [], problems: [] };
  if (!entryIds.length) return result;
  const finished = await db.all(
    `SELECT DISTINCT s.id FROM timesheet_submissions s JOIN time_entries t ON t.submission_id = s.id
     WHERE t.id = ANY(?::int[]) AND s.status = 'submitted' AND s.approved_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM time_entries p WHERE p.submission_id = s.id AND p.status = 'pending')
     AND EXISTS (SELECT 1 FROM time_entries a WHERE a.submission_id = s.id AND a.status = 'approved')`,
    entryIds
  );
  for (const { id } of finished) {
    // Claim it first, so two people approving at the same moment don't both send it.
    const { changes } = await db.run(
      'UPDATE timesheet_submissions SET approved_at = app_now(), approved_by = ? WHERE id = ? AND approved_at IS NULL',
      user.id,
      id
    );
    if (!changes) continue;
    try {
      const emailId = await queueApprovalEmail(id, site);
      if (emailId) result.emailIds.push(emailId);
      else {
        const s = await db.get(`${SUBMISSION_SELECT} WHERE s.id = ?`, id);
        result.noEmail.push(`${s.first_name} ${s.last_name}`);
      }
    } catch (err) {
      console.error(err);
      result.problems.push(err.message);
    }
  }
  return result;
}

module.exports = { finishCheckedTimesheets, queueApprovalEmail, makeApprovedCopy, SUBMISSION_SELECT };
