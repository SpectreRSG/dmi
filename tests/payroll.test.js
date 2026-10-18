// Tests for the pay maths and date helpers. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitHours, calculatePayLine, entryHours } = require('../src/services/payroll');
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
  assert.deepEqual(splitHours([...week1, ...week2], 40), { regular: 48, overtime: 10 });
});

test('a weekly limit of 0 turns overtime off', () => {
  const entries = ['19', '20', '21', '22', '23'].map((d) => entry(`2026-10-${d}`, '08:00', '18:00'));
  assert.deepEqual(splitHours(entries, 0), { regular: 50, overtime: 0 });
});

test('pay line adds regular pay, overtime pay and adjustments', () => {
  const entries = ['19', '20', '21', '22', '23'].map((d) => entry(`2026-10-${d}`, '08:00', '18:00'));
  const line = calculatePayLine({ entries, hourlyRate: 30, weeklyLimit: 40, multiplier: 1.5, adjustment: 25.5 });
  assert.equal(line.regular_pay, 1200);
  assert.equal(line.overtime_pay, 450);
  assert.equal(line.gross_pay, 1675.5);
});

test('date helpers handle month ends and weeks', () => {
  assert.equal(time.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(time.addMonths('2026-03-15', 36), '2029-03-15');
  assert.equal(time.startOfWeek('2026-10-18'), '2026-10-12'); // a Sunday belongs to the week starting Monday 12th
  assert.equal(time.isValidDate('2026-02-30'), false);
  assert.equal(time.fmtRange('2026-10-19T22:00', '2026-10-20T06:00'), '22:00–06:00 (+1)');
});
