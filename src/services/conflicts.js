// The schedule conflict checker ("deconfliction"): finds problems in the roster
// before they happen, and ranks who could cover a shift.
const db = require('../db');
const time = require('../time');
const { entryHours, round2 } = require('./payroll');
const { complianceFor } = require('./compliance');
const { employeeName } = require('../helpers');

const SHIFT_SELECT = `
  SELECT s.*, si.name AS site_name, si.active AS site_active, c.name AS client_name,
         e.first_name, e.last_name, e.status AS employee_status
  FROM shifts s
  JOIN sites si ON si.id = s.site_id
  JOIN clients c ON c.id = si.client_id
  LEFT JOIN employees e ON e.id = s.employee_id`;

// The kinds of problem, most serious first. "high" ones mean the shift can't
// go ahead as planned; "medium" ones cost money or need a second look.
const TYPES = {
  double_booked: { label: 'Double-booked', severity: 'high' },
  training_clash: { label: 'Clashes with training', severity: 'high' },
  compliance: { label: 'License or training problem', severity: 'high' },
  inactive_staff: { label: 'Staff member not active', severity: 'high' },
  unfilled: { label: 'Unfilled shift', severity: 'high' },
  short_rest: { label: 'Not enough rest', severity: 'medium' },
  overtime: { label: 'Overtime', severity: 'medium' },
  inactive_site: { label: 'Site not active', severity: 'medium' },
};

const overlaps = (a, b) => a.start_at < b.end_at && b.start_at < a.end_at;

function minutesBetween(fromAt, toAt) {
  return time.hoursBetween(fromAt, toAt) * 60;
}

const shiftLabel = (s) => `${time.fmtDay(s.start_at)} ${time.fmtRange(s.start_at, s.end_at)} at ${s.site_name}`;

// Training sessions people are booked on, with their end times worked out.
async function trainingBookings(fromAt, toAt) {
  const rows = await db.all(
    `SELECT ta.employee_id, ts.id AS session_id, ts.starts_at, ts.duration_minutes, c.name AS course_name
     FROM training_attendees ta
     JOIN training_sessions ts ON ts.id = ta.session_id
     JOIN training_courses c ON c.id = ts.course_id
     WHERE ts.status = 'scheduled' AND ts.starts_at < ? AND ts.starts_at >= ?`,
    toAt,
    time.addDays(fromAt.slice(0, 10), -1) // a session that started the day before could still be running
  );
  return rows.map((r) => {
    const end = new Date(Date.parse(`${r.starts_at}:00Z`) + r.duration_minutes * 60000).toISOString().slice(0, 16);
    return { ...r, start_at: r.starts_at, end_at: end };
  });
}

// Everything the checks need for a date range, loaded in a few queries.
async function loadRoster(from, to) {
  // Whole weeks (for overtime) plus a day either side (for rest gaps).
  const weekStart = time.startOfWeek(from);
  const weekEnd = time.addDays(time.startOfWeek(to), 7);
  const loadFrom = `${time.addDays(weekStart, -1)}T00:00`;
  const loadTo = `${time.addDays(weekEnd, 1)}T00:00`;
  const [shifts, training] = await Promise.all([
    db.all(`${SHIFT_SELECT} WHERE s.status != 'cancelled' AND s.start_at < ? AND s.end_at > ? ORDER BY s.start_at, s.id`, loadTo, loadFrom),
    trainingBookings(loadFrom, loadTo),
  ]);
  return { shifts, training };
}

function inRange(shift, from, to) {
  const date = shift.start_at.slice(0, 10);
  return date >= from && date <= to;
}

// Finds every problem with shifts starting between `from` and `to` (dates, inclusive).
async function findConflicts(from, to, settings) {
  const { shifts, training } = await loadRoster(from, to);
  const issues = [];
  const add = (type, issue) => issues.push({ type, ...TYPES[type], ...issue });

  const byEmployee = new Map();
  for (const s of shifts) {
    if (!s.employee_id) continue;
    if (!byEmployee.has(s.employee_id)) byEmployee.set(s.employee_id, []);
    byEmployee.get(s.employee_id).push(s);
  }

  // Shifts with nobody assigned, or at a site that has been switched off.
  for (const s of shifts) {
    if (!inRange(s, from, to) || s.status !== 'scheduled') continue;
    if (!s.employee_id) {
      add('unfilled', { date: s.start_at, shift: s, text: `Nobody is assigned to ${shiftLabel(s)}.` });
    } else if (s.employee_status !== 'active') {
      add('inactive_staff', { date: s.start_at, shift: s, employeeId: s.employee_id, text: `${employeeName(s)} is marked ${s.employee_status} but is booked for ${shiftLabel(s)}.` });
    }
    if (!s.site_active) {
      add('inactive_site', { date: s.start_at, shift: s, text: `${s.site_name} is marked inactive but still has a shift on ${time.fmtDay(s.start_at)}.` });
    }
  }

  for (const [employeeId, list] of byEmployee) {
    const name = employeeName(list[0]);

    // Two shifts at once, or too little rest between one shift and the next.
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length && list[j].start_at < list[i].end_at; j += 1) {
        if (!inRange(list[i], from, to) && !inRange(list[j], from, to)) continue;
        add('double_booked', {
          date: list[j].start_at,
          shift: list[j],
          other: list[i],
          employeeId,
          text: `${name} is booked twice: ${shiftLabel(list[i])} and ${shiftLabel(list[j])}.`,
        });
      }
    }
    if (settings.min_rest_hours > 0) {
      // Each shift against the latest-finishing shift before it.
      let previous = null;
      for (const s of list) {
        if (previous && previous.end_at <= s.start_at && inRange(s, from, to)) {
          const restHours = round2(minutesBetween(previous.end_at, s.start_at) / 60);
          if (restHours < settings.min_rest_hours) {
            add('short_rest', {
              date: s.start_at,
              shift: s,
              other: previous,
              employeeId,
              text: `${name} only gets ${restHours} h rest between ${shiftLabel(previous)} and ${shiftLabel(s)} (minimum is ${settings.min_rest_hours} h).`,
            });
          }
        }
        if (!previous || s.end_at > previous.end_at) previous = s;
      }
    }

    // Booked on a shift while they should be at a training session.
    for (const t of training.filter((b) => b.employee_id === employeeId)) {
      for (const s of list.filter((x) => overlaps(x, t) && inRange(x, from, to))) {
        add('training_clash', {
          date: s.start_at,
          shift: s,
          employeeId,
          sessionId: t.session_id,
          text: `${name} is booked for ${shiftLabel(s)} but is also on ${t.course_name} training ${time.fmtDay(t.start_at)} ${time.fmtRange(t.start_at, t.end_at)}.`,
        });
      }
    }

    // More scheduled hours in a Monday–Sunday week than the overtime limit.
    if (settings.overtime_weekly_hours > 0) {
      const weeks = new Map();
      for (const s of list) {
        const week = time.startOfWeek(s.start_at.slice(0, 10));
        weeks.set(week, round2((weeks.get(week) || 0) + entryHours(s)));
      }
      for (const [week, hours] of weeks) {
        const weekEnd = time.addDays(week, 6);
        if (hours <= settings.overtime_weekly_hours || weekEnd < from || week > to) continue;
        add('overtime', {
          date: `${week}T00:00`,
          week,
          employeeId,
          hours,
          text: `${name} is scheduled for ${hours} h in the week of ${time.fmtDate(week)} — ${round2(hours - settings.overtime_weekly_hours)} h of overtime.`,
        });
      }
    }
  }

  // License or required training missing, or expired by the day of the shift.
  const employeeIds = [...byEmployee.keys()];
  if (employeeIds.length) {
    const employees = await db.all('SELECT * FROM employees WHERE id = ANY(?::int[])', employeeIds);
    const { byEmployee: compliance } = await complianceFor(employees, settings.expiry_warning_days);
    for (const employee of employees) {
      const { items } = compliance.get(employee.id);
      const affected = new Map(); // problem label -> shifts
      for (const s of byEmployee.get(employee.id)) {
        if (!inRange(s, from, to) || s.status !== 'scheduled') continue;
        const date = s.start_at.slice(0, 10);
        for (const item of items) {
          const problem = item.status === 'missing' ? 'missing' : item.expires_on && item.expires_on < date ? `expired ${time.fmtDate(item.expires_on)}` : null;
          if (!problem) continue;
          const key = `${item.label} (${problem})`;
          if (!affected.has(key)) affected.set(key, []);
          affected.get(key).push(s);
        }
      }
      for (const [problem, list] of affected) {
        add('compliance', {
          date: list[0].start_at,
          shift: list[0],
          employeeId: employee.id,
          count: list.length,
          text: `${employeeName(employee)}: ${problem}. Affects ${list.length === 1 ? shiftLabel(list[0]) : `${list.length} shifts, starting ${shiftLabel(list[0])}`}.`,
        });
      }
    }
  }

  const order = Object.keys(TYPES);
  issues.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.date.localeCompare(b.date));
  return issues;
}

// For one shift: every active staff member, whether they're free, and any
// reasons to think twice. Best choices first.
async function coverOptions(shift, settings) {
  const staff = await db.all("SELECT * FROM employees WHERE status = 'active' AND id != ? ORDER BY last_name, first_name", shift.employee_id || 0);
  if (!staff.length) return [];
  const date = shift.start_at.slice(0, 10);
  const week = time.startOfWeek(date);
  const loadFrom = `${time.addDays(week < date ? week : date, -1)}T00:00`;
  const loadTo = `${time.addDays(week, 8)}T00:00`;
  const [shifts, training, siteHistory, { byEmployee: compliance }] = await Promise.all([
    db.all(`${SHIFT_SELECT} WHERE s.status != 'cancelled' AND s.employee_id IS NOT NULL AND s.id != ? AND s.start_at < ? AND s.end_at > ?`, shift.id, loadTo, loadFrom),
    trainingBookings(loadFrom, loadTo),
    db.all(
      `SELECT employee_id, COUNT(*)::int AS count FROM shifts
       WHERE site_id = ? AND employee_id IS NOT NULL AND status != 'cancelled' AND start_at >= ? AND start_at < ?
       GROUP BY employee_id`,
      shift.site_id,
      `${time.addDays(date, -90)}T00:00`,
      shift.start_at
    ),
    complianceFor(staff, settings.expiry_warning_days),
  ]);
  const knowsSite = new Map(siteHistory.map((r) => [r.employee_id, r.count]));
  const thisShiftHours = entryHours(shift);

  const options = staff.map((employee) => {
    const theirs = shifts.filter((s) => s.employee_id === employee.id);
    const blockers = [];
    const warnings = [];

    const clash = theirs.find((s) => overlaps(s, shift));
    if (clash) blockers.push(`Already booked ${time.fmtRange(clash.start_at, clash.end_at)} at ${clash.site_name}`);
    const course = training.find((t) => t.employee_id === employee.id && overlaps(t, shift));
    if (course) blockers.push(`On ${course.course_name} training`);

    if (settings.min_rest_hours > 0) {
      for (const s of theirs) {
        const gap = s.end_at <= shift.start_at ? minutesBetween(s.end_at, shift.start_at) : s.start_at >= shift.end_at ? minutesBetween(shift.end_at, s.start_at) : null;
        if (gap !== null && gap < settings.min_rest_hours * 60) {
          const when = s.end_at <= shift.start_at ? 'after' : 'before';
          warnings.push(gap === 0 ? `No rest: straight ${when} their shift at ${s.site_name}` : `Only ${round2(gap / 60)} h rest ${when} their shift at ${s.site_name}`);
          break;
        }
      }
    }

    const weekHours = round2(theirs.filter((s) => time.startOfWeek(s.start_at.slice(0, 10)) === week).reduce((sum, s) => sum + entryHours(s), 0));
    if (settings.overtime_weekly_hours > 0 && weekHours + thisShiftHours > settings.overtime_weekly_hours) {
      warnings.push(`Would go into overtime (${round2(weekHours + thisShiftHours)} h that week)`);
    }

    for (const item of compliance.get(employee.id).items) {
      if (item.status === 'missing') warnings.push(`${item.label} missing`);
      else if (item.expires_on && item.expires_on < date) warnings.push(`${item.label} expired ${time.fmtDate(item.expires_on)}`);
    }

    return { employee, blockers, warnings, weekHours, siteShifts: knowsSite.get(employee.id) || 0 };
  });

  // Free with no warnings first, then free with warnings, then busy. Within
  // each group: people who know the site, then whoever has the fewest hours.
  const rank = (o) => (o.blockers.length ? 2 : o.warnings.length ? 1 : 0);
  options.sort((a, b) => rank(a) - rank(b) || b.siteShifts - a.siteShifts || a.weekHours - b.weekHours);
  return options;
}

module.exports = { TYPES, findConflicts, coverOptions, SHIFT_SELECT };
