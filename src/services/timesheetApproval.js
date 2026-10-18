// When the office has finished checking an officer's timesheet (no days left
// waiting for approval), make the approved copy of their signed PDF: the same
// PDF with "APPROVED BY" filled in. The officer views or downloads it from
// Timesheets in their account.
const db = require('../db');
const time = require('../time');
const sheets = require('./officerTimesheet');
const { saveUpload, readUpload } = require('../uploads');

// Fills in "APPROVED BY" (who and when) on the officer's signed PDF and saves it.
async function makeApprovedCopy(submissionId) {
  const submission = await db.get(
    `SELECT s.*, u.name AS approver_name FROM timesheet_submissions s LEFT JOIN users u ON u.id = s.approved_by WHERE s.id = ?`,
    submissionId
  );
  const original = await readUpload(submission.file_name);
  if (!original) throw new Error('The signed timesheet PDF is missing.');
  const date = (submission.approved_at || time.nowStr()).slice(0, 10);
  const pdf = await sheets.stampApproval(original, { approver: submission.approver_name || 'Office', date });
  const stored = await saveUpload({ originalname: 'timesheet-approved.pdf', buffer: pdf, size: pdf.length });
  await db.run('UPDATE timesheet_submissions SET approved_file_name = ? WHERE id = ?', stored.file_name, submission.id);
}

// Call after approving or rejecting hours. Each officer timesheet that now has
// no days waiting (and at least one approved) gets its approved copy.
// Returns { approved: how many, problems: [messages] }.
async function finishCheckedTimesheets(entryIds, user) {
  const result = { approved: 0, problems: [] };
  if (!entryIds.length) return result;
  const finished = await db.all(
    `SELECT DISTINCT s.id FROM timesheet_submissions s JOIN time_entries t ON t.submission_id = s.id
     WHERE t.id = ANY(?::int[]) AND s.status = 'submitted' AND s.approved_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM time_entries p WHERE p.submission_id = s.id AND p.status = 'pending')
     AND EXISTS (SELECT 1 FROM time_entries a WHERE a.submission_id = s.id AND a.status = 'approved')`,
    entryIds
  );
  for (const { id } of finished) {
    // Claim it first, so two people approving at the same moment don't both stamp it.
    const { changes } = await db.run(
      'UPDATE timesheet_submissions SET approved_at = app_now(), approved_by = ? WHERE id = ? AND approved_at IS NULL',
      user.id,
      id
    );
    if (!changes) continue;
    try {
      await makeApprovedCopy(id);
      result.approved += 1;
    } catch (err) {
      console.error(err);
      result.problems.push(err.message);
    }
  }
  return result;
}

module.exports = { finishCheckedTimesheets, makeApprovedCopy };
