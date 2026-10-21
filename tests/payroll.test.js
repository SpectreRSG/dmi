// Tests for the pay maths and date helpers. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitHours, calculatePayLine, entryHours, overtimeRules } = require('../src/services/payroll');
const time = require('../src/time');

const entry = (date, start, end, breakMinutes = 0) => ({
  ...time.buildRange(date, start, end),
  break_minutes: breakMinutes,
});

test('a night shift finishes the next day', () => {
  assert.deepEqual(time.buildRange('2026-10-19', '22:00', '06:00'), {
    start_at: '2026-10-19T22:00',
    end_at: '2026-10-20T06:00',
  });
  assert.equal(entryHours(entry('2026-10-19', '22:00', '06:00', 30)), 7.5);
});

test('hours are split into regular and overtime per Monday–Sunday week', () => {
  // Week 1 (Mon 19 Oct): five 10-hour days = 50 hours -> 40 regular + 10 overtime.
  const week1 = ['19', '20', '21', '22', '23'].map((d) => entry(`2026-10-${d}`, '08:00', '18:00'));
  // Week 2 (Mon 26 Oct): one 8-hour day, no overtime.
  const week2 = [entry('2026-10-26', '09:00', '17:00')];
  assert.deepEqual(splitHours([...week1, ...week2], { weeklyLimit: 40 }), { regular: 48, overtime: 10, doubleTime: 0 });
});

test('a weekly limit of 0 turns overtime off', () => {
  const entries = ['19', '20', '21', '22', '23'].map((d) => entry(`2026-10-${d}`, '08:00', '18:00'));
  assert.deepEqual(splitHours(entries, { weeklyLimit: 0 }), { regular: 50, overtime: 0, doubleTime: 0 });
});

test('pay line adds regular pay, overtime pay and adjustments', () => {
  const entries = ['19', '20', '21', '22', '23'].map((d) => entry(`2026-10-${d}`, '08:00', '18:00'));
  const line = calculatePayLine({ entries, hourlyRate: 30, rules: { weeklyLimit: 40, multiplier: 1.5 }, adjustment: 25.5 });
  assert.equal(line.regular_pay, 1200);
  assert.equal(line.overtime_pay, 450);
  assert.equal(line.gross_pay, 1675.5);
});

const CALIFORNIA = overtimeRules({ overtime_weekly_hours: 40, overtime_multiplier: 1.5, daily_overtime: 'california', workday_start: '06:00' });
const days = (from, count, start, end) => Array.from({ length: count }, (_, i) => entry(time.addDays(from, i), start, end));

test('California: over 8 hours in a workday is overtime, over 12 is double time', () => {
  assert.deepEqual(splitHours([entry('2026-10-19', '06:00', '18:00')], CALIFORNIA), { regular: 8, overtime: 4, doubleTime: 0 });
  assert.deepEqual(splitHours([entry('2026-10-19', '06:00', '20:00')], CALIFORNIA), { regular: 8, overtime: 4, doubleTime: 2 });
  // Four 12-hour posts: 48 hours, but only 32 regular, so no weekly overtime on top.
  assert.deepEqual(splitHours(days('2026-10-19', 4, '06:00', '18:00'), CALIFORNIA), { regular: 32, overtime: 16, doubleTime: 0 });
  // Six 8-hour days: the 6th day goes over 40 for the week.
  assert.deepEqual(splitHours(days('2026-10-19', 6, '09:00', '17:00'), CALIFORNIA), { regular: 40, overtime: 8, doubleTime: 0 });
  const line = calculatePayLine({ entries: [entry('2026-10-19', '06:00', '20:00', 30)], hourlyRate: 20, rules: CALIFORNIA });
  assert.deepEqual([line.regular_pay, line.overtime_pay, line.double_time_hours, line.double_time_pay, line.gross_pay], [160, 120, 1.5, 60, 340]);
});

test('California: the 7th day in a row in a week is overtime, and double after 8 hours', () => {
  assert.deepEqual(splitHours(days('2026-10-19', 7, '09:00', '17:00'), CALIFORNIA), { regular: 40, overtime: 16, doubleTime: 0 });
  const shortWeek = [...days('2026-10-19', 6, '09:00', '13:00'), entry('2026-10-25', '08:00', '18:00')];
  assert.deepEqual(splitHours(shortWeek, CALIFORNIA), { regular: 24, overtime: 8, doubleTime: 2 });
  // Not every day of the week (Tuesday to the next Monday): no 7th-day rule.
  assert.deepEqual(splitHours(days('2026-10-20', 7, '09:00', '17:00'), CALIFORNIA), { regular: 48, overtime: 8, doubleTime: 0 });
});

test('California: a night shift counts in the workday it falls in', () => {
  const night = [entry('2026-10-19', '18:00', '06:00')];
  // Workdays from 6 AM: the whole 6 PM–6 AM shift is one 12-hour workday.
  assert.deepEqual(splitHours(night, CALIFORNIA), { regular: 8, overtime: 4, doubleTime: 0 });
  // Workdays from midnight: 6 hours on each side, so no daily overtime for one night.
  assert.deepEqual(splitHours(night, { ...CALIFORNIA, workdayStart: '00:00' }), { regular: 12, overtime: 0, doubleTime: 0 });
  // ...but three nights in a row make two 12-hour workdays in the middle.
  assert.deepEqual(splitHours(days('2026-10-19', 3, '18:00', '06:00'), { ...CALIFORNIA, workdayStart: '00:00' }), { regular: 28, overtime: 8, doubleTime: 0 });
  // An unpaid break comes off the hours.
  assert.deepEqual(splitHours([entry('2026-10-19', '18:00', '06:00', 30)], CALIFORNIA), { regular: 8, overtime: 3.5, doubleTime: 0 });
});

test('hours paid earlier in the week count towards its overtime, without being paid twice', () => {
  // Pay periods run Sunday to Saturday; overtime weeks Monday to Sunday. Mon–Sat were in the last pay run.
  const earlier = days('2026-10-19', 6, '09:00', '17:00');
  const sunday = [entry('2026-10-25', '09:00', '17:00')];
  assert.deepEqual(splitHours(sunday, CALIFORNIA, earlier), { regular: 0, overtime: 8, doubleTime: 0 }, 'the 7th day in a row');
  assert.deepEqual(splitHours(sunday, { weeklyLimit: 40 }, earlier), { regular: 0, overtime: 8, doubleTime: 0 }, 'over 40 for the week');
  assert.deepEqual(splitHours(sunday, CALIFORNIA), { regular: 8, overtime: 0, doubleTime: 0 }, 'alone, it would look like a normal day');
});

test('"today" follows the company time zone, not the server clock', () => {
  // Honolulu (UTC-10) and Kiritimati (UTC+14) are always a full day apart.
  time.setTimeZone('Pacific/Honolulu');
  const honolulu = time.todayStr();
  time.setTimeZone('Pacific/Kiritimati');
  const kiritimati = time.todayStr();
  time.setTimeZone(undefined);
  assert.equal(time.daysBetween(honolulu, kiritimati), 1);
});

test('date helpers handle month ends and weeks', () => {
  assert.equal(time.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(time.addMonths('2026-03-15', 36), '2029-03-15');
  assert.equal(time.startOfWeek('2026-10-18'), '2026-10-12'); // a Sunday belongs to the week starting Monday 12th
  assert.equal(time.isValidDate('2026-02-30'), false);
  assert.equal(time.fmtRange('2026-10-19T22:00', '2026-10-20T06:00'), '22:00–06:00 (+1)');
});
