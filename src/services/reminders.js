// Reminders by app notification, sent by the timed jobs (jobs.js):
// - each officer, 24 hours and again 2 hours before each of their shifts;
// - "time cards due", 2 days before a pay period ends (from 9 am): officers
//   who worked in it check their hours in My pay, and the office fixes any
//   hours before the pay run.
// reminders_sent remembers what went out, so nothing is sent twice, even when
// two jobs run at the same moment.
const db = require('../db');
const time = require('../time');
const { notifyEmployees, notifyOffice } = require('./notify');
const { periodStartFor, periodEnd } = require('./officerTimesheet');

const SHIFT_REMINDERS = [
  { kind: 'shift_soon', hours: 2 },
  { kind: 'shift_day', hours: 24 },
];
const PERIOD_DAYS_BEFORE = 2;
const PERIOD_FROM = '09:00'; // not in the middle of the night

// True if this reminder hasn't gone out yet (and now counts as sent).
async function claim(kind, ref) {
  const result = await db.run('INSERT INTO reminders_sent (kind, ref) VALUES (?, ?) ON CONFLICT DO NOTHING', kind, ref);
  return result.changes === 1;
}

// "today", "tomorrow" or "Thu 22 Oct".
function dayWord(date) {
  const today = time.todayStr();
  if (date === today) return 'today';
  if (date === time.addDays(today, 1)) return 'tomorrow';
  return time.fmtDay(date);
}
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

async function remindShifts() {
  const now = time.nowStr();
  const shifts = await db.all(
    `SELECT s.*, si.name AS site_name FROM shifts s JOIN sites si ON si.id = s.site_id
     WHERE s.status = 'scheduled' AND s.employee_id IS NOT NULL AND s.start_at > ? AND s.start_at <= ?
     ORDER BY s.start_at`,
    now, time.addMinutes(now, 24 * 60)
  );
  for (const shift of shifts) {
    // Only the nearest one that's due: a shift 1 hour away gets the 2-hour reminder, not both.
    const reminder = SHIFT_REMINDERS.find((r) => shift.start_at <= time.addMinutes(now, r.hours * 60));
    // Given the shift (or its new time) after the reminder was due? They were told then.
    if (shift.assigned_at && shift.assigned_at > time.addMinutes(shift.start_at, -reminder.hours * 60)) continue;
    if (!(await claim(reminder.kind, `${shift.id}:${shift.employee_id}:${shift.start_at}`))) continue;
    const day = dayWord(shift.start_at.slice(0, 10));
    const where = `${capital(day)} ${time.fmtRange(shift.start_at, shift.end_at)} at ${shift.site_name}.`;
    await notifyEmployees([shift.employee_id], {
      title: reminder.kind === 'shift_soon' ? `Your shift starts at ${time.fmtTime(shift.start_at)}` : `Shift ${day} at ${time.fmtTime(shift.start_at)}`,
      body: reminder.kind === 'shift_soon' ? where : `${where} Can't make it? Tap to tell the office.`,
      url: `/my/schedule?month=${shift.start_at.slice(0, 7)}`,
      tag: `shift-reminder-${shift.id}`, // the 2-hour reminder replaces the 24-hour one
    });
  }
}

// The pay period whose time cards are due now (from 2 days before it ends), or null.
function timeCardsDue() {
  const start = periodStartFor(time.todayStr());
  const end = periodEnd(start);
  const from = time.addDays(end, -PERIOD_DAYS_BEFORE);
  return time.nowStr() < `${from}T${PERIOD_FROM}` ? null : { start, end };
}

async function remindTimeCards() {
  const due = timeCardsDue();
  if (!due) return;
  const { start, end } = due;
  const period = `${time.fmtDate(start)} to ${time.fmtDate(end)}`;
  const dueOn = dayWord(end);
  const tag = `time-cards-${start}`;
  const after = `${time.addDays(end, 1)}T00:00`; // to the end of the period's last day

  if (await claim('period_officers', start)) {
    // Everyone with a shift or hours in the period.
    const officers = await db.all(
      `SELECT employee_id FROM shifts WHERE employee_id IS NOT NULL AND status != 'cancelled' AND start_at >= ? AND start_at < ?
       UNION SELECT employee_id FROM time_entries WHERE status != 'rejected' AND start_at >= ? AND start_at < ?`,
      start, after, start, after
    );
    await notifyEmployees(officers.map((o) => o.employee_id), {
      title: `Time cards are due ${dueOn}`,
      body: `The pay period ${period} ends ${dueOn}. Check your hours in My pay, and tell the office if anything is missing or wrong.`,
      url: '/my/pay',
      tag,
    });
  }
  if (await claim('period_office', start)) {
    const waiting = (await db.get(
      "SELECT COUNT(*)::int AS n FROM time_entries WHERE status = 'pending' AND start_at >= ? AND start_at < ?", start, after
    )).n;
    await notifyOffice({
      title: `Time cards are due ${dueOn}`,
      body: `The pay period ${period} ends ${dueOn}. Fix any hours (left early, stayed late, someone covered)${waiting ? ` and approve the ${waiting} waiting` : ''} before the pay run.`,
      url: '/timesheets',
      tag,
    });
  }
}

async function sendReminders() {
  await remindShifts();
  await remindTimeCards();
}

module.exports = { sendReminders, remindShifts, remindTimeCards, timeCardsDue, dayWord, SHIFT_REMINDERS };
