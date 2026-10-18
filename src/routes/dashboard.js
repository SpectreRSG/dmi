// Dashboard: the home page with everything that needs attention.
const express = require('express');
const db = require('../db');
const time = require('../time');
const { entryHours, round2 } = require('../services/payroll');
const { complianceFor, expiryStatus } = require('../services/compliance');

const router = express.Router();

router.get('/', (req, res) => {
  const warningDays = res.locals.settings.expiry_warning_days;
  const today = time.todayStr();
  const now = time.nowStr();
  const in7Days = `${time.addDays(today, 7)}T00:00`;

  const employees = db.prepare("SELECT * FROM employees WHERE status = 'active' ORDER BY last_name, first_name").all();
  const { byEmployee } = complianceFor(employees, warningDays);
  const complianceIssues = employees
    .map((employee) => ({ employee, ...byEmployee.get(employee.id) }))
    .filter((c) => c.level !== 'ok');

  const upcomingShifts = db
    .prepare(
      `SELECT s.*, si.name AS site_name, c.name AS client_name, e.first_name, e.last_name
       FROM shifts s JOIN sites si ON si.id = s.site_id JOIN clients c ON c.id = si.client_id
       LEFT JOIN employees e ON e.id = s.employee_id
       WHERE s.status = 'scheduled' AND s.end_at > ? AND s.start_at < ?
       ORDER BY s.start_at`
    )
    .all(now, in7Days);

  // Shifts that should have finished but haven't been marked as worked yet.
  const overdueShifts = db
    .prepare(
      "SELECT COUNT(*) AS n FROM shifts WHERE status = 'scheduled' AND employee_id IS NOT NULL AND end_at <= ?"
    )
    .get(now).n;

  const pendingEntries = db.prepare("SELECT * FROM time_entries WHERE status = 'pending'").all();

  const endingContracts = db
    .prepare(
      `SELECT k.*, c.name AS client_name, e.first_name, e.last_name FROM contracts k
       LEFT JOIN clients c ON c.id = k.client_id LEFT JOIN employees e ON e.id = k.employee_id
       WHERE k.status = 'active' AND k.end_date IS NOT NULL AND k.end_date <= ?
       ORDER BY k.end_date`
    )
    .all(time.addDays(today, warningDays));

  const trainingSessions = db
    .prepare(
      `SELECT ts.*, c.name AS course_name,
         (SELECT COUNT(*) FROM training_attendees a WHERE a.session_id = ts.id) AS attendee_count
       FROM training_sessions ts JOIN training_courses c ON c.id = ts.course_id
       WHERE ts.status = 'scheduled' AND ts.starts_at >= ? ORDER BY ts.starts_at LIMIT 5`
    )
    .all(`${today}T00:00`);

  const recentActivity = db
    .prepare(
      `SELECT a.*, u.name AS user_name FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.id DESC LIMIT 8`
    )
    .all();

  res.render('dashboard', {
    title: 'Dashboard',
    today,
    stats: {
      activeStaff: employees.length,
      shiftsNext7: upcomingShifts.length,
      unfilled: upcomingShifts.filter((s) => !s.employee_id).length,
      pendingCount: pendingEntries.length,
      pendingHours: round2(pendingEntries.reduce((sum, e) => sum + entryHours(e), 0)),
      complianceProblems: complianceIssues.filter((c) => c.level === 'bad').length,
      complianceWarnings: complianceIssues.filter((c) => c.level === 'warn').length,
      endingContracts: endingContracts.length,
      overdueShifts,
    },
    upcomingShifts: upcomingShifts.slice(0, 10),
    complianceIssues: complianceIssues.slice(0, 8),
    endingContracts: endingContracts.map((k) => ({ ...k, state: expiryStatus(k.end_date, warningDays) })),
    trainingSessions,
    recentActivity,
  });
});

module.exports = router;
