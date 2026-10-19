// Hours from the schedule: once a shift has ended, its hours are recorded and
// approved by themselves, so nobody fills in a timesheet. The office only fixes
// the exceptions (someone left early, stayed late or didn't come) by editing
// the shift, or the hours in Timesheets, before the pay run is finalized.
const db = require('../db');
const time = require('../time');

// Records every shift that has ended. Safe to run as often as you like, even
// twice at the same moment: each shift is claimed (scheduled -> completed) by
// exactly one run, so its hours are never recorded twice. Returns how many
// hours entries it made.
async function recordFinishedShifts() {
  const rows = await db.all(
    `WITH done AS (
       UPDATE shifts s SET status = 'completed'
       WHERE s.status = 'scheduled' AND s.employee_id IS NOT NULL AND s.end_at <= ?
         AND s.start_at >= COALESCE((SELECT value FROM settings WHERE key = 'hours_from_schedule_since'), '9999')
         AND NOT EXISTS (SELECT 1 FROM time_entries t WHERE t.shift_id = s.id)
       RETURNING s.id, s.employee_id, s.site_id, s.start_at, s.end_at, s.break_minutes
     )
     INSERT INTO time_entries (employee_id, site_id, shift_id, start_at, end_at, break_minutes, status, approved_at, source)
     SELECT d.employee_id, d.site_id, d.id, d.start_at, d.end_at, d.break_minutes, 'approved', app_now(), 'schedule'
     FROM done d
     -- Not if the office (or the officer) already entered hours for that time.
     WHERE NOT EXISTS (
       SELECT 1 FROM time_entries t WHERE t.employee_id = d.employee_id AND t.status != 'rejected'
       AND t.start_at < d.end_at AND t.end_at > d.start_at)
     -- Two shifts booked for the same person at the same time only count once.
     AND NOT EXISTS (
       SELECT 1 FROM done d2 WHERE d2.employee_id = d.employee_id AND d2.id < d.id
       AND d2.start_at < d.end_at AND d2.end_at > d.start_at)
     RETURNING id`,
    time.nowStr()
  );
  return rows.length;
}

// Ordinary page loads also record finished shifts, at most once a minute, so
// the hours are there whoever looks next. A problem here never stops the page.
let lastCatchUp = 0;
async function catchUp() {
  if (Date.now() - lastCatchUp < 60 * 1000) return;
  lastCatchUp = Date.now();
  try {
    await recordFinishedShifts();
  } catch (err) {
    console.error('Recording finished shifts failed:', err);
  }
}

// The hours recorded from a shift, and whether they've been paid already.
function hoursFromShift(dbOrTx, shiftId) {
  return dbOrTx.get(
    `SELECT t.*, p.status AS pay_run_status FROM time_entries t LEFT JOIN pay_runs p ON p.id = t.pay_run_id
     WHERE t.shift_id = ? AND t.source = 'schedule'`,
    shiftId
  );
}

// After the office edits a shift, its recorded hours follow: new times, site
// or officer. If it's cancelled, unassigned, set back to scheduled or moved
// into the future, the hours go (and come back once it has ended, unless it
// was cancelled or unassigned).
// Call it inside the same transaction as the change, and only when the hours
// haven't been paid (see hoursFromShift).
async function syncHoursWithShift(tx, shiftId) {
  const entry = await hoursFromShift(tx, shiftId);
  if (!entry || entry.pay_run_status === 'finalized') return;
  const shift = await tx.get('SELECT * FROM shifts WHERE id = ?', shiftId);
  if (shift.status !== 'completed' || !shift.employee_id || shift.end_at > time.nowStr()) {
    await tx.run('DELETE FROM time_entries WHERE id = ?', entry.id);
    // Moved to a time that hasn't finished yet: it's recorded again once it has.
    if (shift.status === 'completed') await tx.run("UPDATE shifts SET status = 'scheduled' WHERE id = ?", shift.id);
    return;
  }
  await tx.run(
    'UPDATE time_entries SET employee_id = ?, site_id = ?, start_at = ?, end_at = ?, break_minutes = ? WHERE id = ?',
    shift.employee_id, shift.site_id, shift.start_at, shift.end_at, shift.break_minutes, entry.id
  );
}

module.exports = { recordFinishedShifts, catchUp, hoursFromShift, syncHoursWithShift };
