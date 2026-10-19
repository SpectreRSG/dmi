// The DMI timesheet for one person's line in a finalized pay run: the hours
// they were paid for, filled into the DMI form and stamped "Approved by" with
// whoever finalized the pay run. Nobody signs it; the hours came from the
// schedule. It's made the first time someone opens it, then kept, so it
// never changes afterwards (even if their phone number does).
const db = require('../db');
const sheets = require('./officerTimesheet');
const { entryHours, round2 } = require('./payroll');
const { saveUpload } = require('../uploads');

function findPayLine(itemId) {
  return db.get(
    `SELECT i.*, p.period_start, p.period_end, p.status AS run_status, p.finalized_at, u.name AS finalized_by_name,
       e.first_name, e.last_name, e.phone
     FROM pay_run_items i
     JOIN pay_runs p ON p.id = i.pay_run_id
     JOIN employees e ON e.id = i.employee_id
     LEFT JOIN users u ON u.id = p.finalized_by
     WHERE i.id = ?`,
    itemId
  );
}

// The site they worked at most, for the form's "Location" box.
function mainSite(entries) {
  const counts = new Map();
  for (const e of entries) if (e.site_name) counts.set(e.site_name, (counts.get(e.site_name) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

// Returns the stored file name of the timesheet PDF, making it if needed
// (null if the pay run isn't finalized yet).
async function payLineTimesheet(line) {
  if (line.run_status !== 'finalized') return null;
  if (line.timesheet_file) return line.timesheet_file;

  const entries = await db.all(
    `SELECT t.*, si.name AS site_name FROM time_entries t LEFT JOIN sites si ON si.id = t.site_id
     WHERE t.pay_run_id = ? AND t.employee_id = ? ORDER BY t.start_at`,
    line.pay_run_id,
    line.employee_id
  );
  const pdf = await sheets.buildTimesheetPdf({
    name: `${line.last_name}, ${line.first_name}`,
    phone: line.phone,
    location: mainSite(entries),
    start: line.period_start,
    end: line.period_end,
    worked: entries.map((e) => ({
      date: e.start_at.slice(0, 10),
      start_at: e.start_at,
      end_at: e.end_at,
      hours: round2(entryHours(e)),
      comment: [e.site_name, e.break_minutes ? `${e.break_minutes} min break` : ''].filter(Boolean).join(', '),
    })),
    note: 'Hours from the DMI schedule',
    approval: { approver: line.finalized_by_name || 'DMI Office', date: line.finalized_at.slice(0, 10) },
  });
  const stored = await saveUpload({ originalname: 'timesheet.pdf', buffer: pdf, size: pdf.length });
  // If two people opened it at the same moment, the first one made is kept.
  await db.run('UPDATE pay_run_items SET timesheet_file = ? WHERE id = ? AND timesheet_file IS NULL', stored.file_name, line.id);
  return (await db.get('SELECT timesheet_file FROM pay_run_items WHERE id = ?', line.id)).timesheet_file;
}

// "DMI_Timesheet_Officer_Olivia_2026-10-04_to_2026-10-17.pdf"
function timesheetFileName(line) {
  const who = `${line.last_name}_${line.first_name}`.replace(/[^A-Za-z0-9_-]+/g, '');
  return `DMI_Timesheet_${who}_${line.period_start}_to_${line.period_end}.pdf`;
}

module.exports = { findPayLine, payLineTimesheet, timesheetFileName };
