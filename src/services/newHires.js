// California's new employee report (DE 34): every new W-2 employee must be
// reported to the EDD within 20 days of their first day of work (start date
// on the staff record), through e-Services for Business. DMI lists who's due
// and reminds the admins.
const db = require('../db');
const time = require('../time');

const DAYS_TO_REPORT = 20;
const LOOK_BACK_DAYS = 60; // older start dates are people who were already employees
const REMIND_DAYS_BEFORE = 5;

const dueDate = (startDate) => time.addDays(startDate, DAYS_TO_REPORT);

// W-2 employees with a recent start date who haven't been reported yet.
async function newHiresDue(today = time.todayStr()) {
  const rows = await db.all(
    `SELECT * FROM employees WHERE status = 'active' AND tax_form = 'W-2' AND new_hire_reported_on IS NULL
       AND start_date IS NOT NULL AND start_date >= ? ORDER BY start_date`,
    time.addDays(today, -LOOK_BACK_DAYS)
  );
  return rows.map((e) => ({ employee: e, due: dueDate(e.start_date), overdue: today > dueDate(e.start_date) }));
}

// True if this reminder hasn't gone out yet (and now counts as sent).
async function claim(kind, ref) {
  return (await db.run('INSERT INTO reminders_sent (kind, ref) VALUES (?, ?) ON CONFLICT DO NOTHING', kind, ref)).changes === 1;
}

// Admins hear once when a report is due within 5 days (or already late).
async function remindNewHires() {
  const { notifyAdmins } = require('./notify');
  const today = time.todayStr();
  for (const { employee, due } of await newHiresDue(today)) {
    if (today < time.addDays(due, -REMIND_DAYS_BEFORE)) continue;
    if (!(await claim('new_hire', `${employee.id}:${employee.start_date}`))) continue;
    await notifyAdmins({
      title: 'New hire report due',
      body: `Report ${employee.first_name} ${employee.last_name} to the EDD (DE 34) by ${time.fmtDate(due)}: they started ${time.fmtDate(employee.start_date)}.`,
      url: `/staff/${employee.id}`,
      tag: `new-hire-${employee.id}`,
    });
  }
}

module.exports = { newHiresDue, remindNewHires, dueDate, DAYS_TO_REPORT, LOOK_BACK_DAYS };
