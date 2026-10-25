// California meal and rest breaks, and pay by employment type (salary maths).
const test = require('node:test');
const assert = require('node:assert/strict');
const { mealsNeeded, restsNeeded, workdayOf, premiums } = require('../src/services/breaks');
const employment = require('../src/services/employment');

const entry = (start, end, extra = {}) => ({ start_at: start, end_at: end, break_minutes: 0, ...extra });

test('how many meal and rest breaks a workday needs', () => {
  assert.deepEqual([4, 5, 5.25, 6, 6.5, 10, 10.5, 12, 12.5].map((h) => mealsNeeded(h)), [0, 0, 1, 1, 1, 1, 2, 2, 2]);
  assert.deepEqual([5.5, 6, 6.5, 10.5, 12, 12.5].map((h) => mealsNeeded(h, { waiver: true })), [0, 0, 1, 1, 1, 2], 'a waiver covers short days only');
  assert.deepEqual([3, 3.5, 6, 6.25, 10, 10.25, 14, 14.5].map(restsNeeded), [0, 1, 1, 2, 2, 3, 3, 4]);
  assert.equal(workdayOf('2026-10-20T03:00', '06:00'), '2026-10-19', 'before the workday starts, it belongs to the day before');
  assert.equal(workdayOf('2026-10-20T06:00', '06:00'), '2026-10-20');
});

test('break premiums: no meal break recorded, marked as missed, or eaten at the post', () => {
  const week = [
    entry('2026-10-19T08:00', '2026-10-19T16:30', { break_minutes: 30 }), // 8 h with a 30-minute meal: fine
    entry('2026-10-20T08:00', '2026-10-20T16:00'), // 8 h, no meal break recorded
    entry('2026-10-21T07:00', '2026-10-21T19:30', { break_minutes: 30 }), // 12 h: needs two meal breaks (60 minutes)
    entry('2026-10-22T08:00', '2026-10-22T12:00', { missed_rest: 1 }), // 4 h, rest break marked missed
    entry('2026-10-23T08:00', '2026-10-23T11:00', { missed_rest: 1, missed_meal: 1 }), // 3 h: no breaks owed
    entry('2026-10-24T08:00', '2026-10-24T16:30', { break_minutes: 30, missed_meal: 1, missed_rest: 1 }), // both marked: one of each
  ];
  let owed = premiums(week);
  assert.deepEqual([owed.meal, owed.rest], [3, 2]);
  assert.deepEqual(owed.days.map((d) => [d.date.slice(8), d.missedMeal, d.missedRest]), [
    ['19', false, false], ['20', true, false], ['21', true, false], ['22', false, true], ['23', false, false], ['24', true, true],
  ]);
  assert.match(owed.days[2].why[0], /needs 60 minutes of meal breaks; 30 recorded/);

  // With a meal waiver, 12 hours needs only one meal break.
  assert.equal(premiums([week[2]], { waiver: true }).meal, 0);
  // On duty: meals are at the post, so only a meal marked as missed counts.
  owed = premiums(week, { onDutyMeals: true });
  assert.deepEqual([owed.meal, owed.rest], [1, 2]);

  // A night shift in two parts is one workday, and the half hour off the clock in between is its meal break.
  owed = premiums([entry('2026-10-20T04:30', '2026-10-20T07:00'), entry('2026-10-19T22:00', '2026-10-20T04:00')], { workdayStart: '06:00' });
  assert.deepEqual(owed.days.map((d) => [d.date, d.hours, d.unpaidMinutes, d.missedMeal]), [['2026-10-19', 8.5, 30, false]]);
});

test('employment types: rules, salary, regular rate and the exempt minimum', () => {
  const fullSalary = { employment_type: 'Full Time', tax_form: 'W-2', pay_basis: 'salary', annual_salary: 78000, weekly_hours: 40, overtime_exempt: 0 };
  const partSalary = { employment_type: 'Part Time Regular', tax_form: 'W-2', pay_basis: 'salary', annual_salary: 31200, weekly_hours: 24 };
  const contractor = { employment_type: 'Contractor', tax_form: '1099', pay_basis: 'hourly', hourly_rate: 35 };
  assert.deepEqual(employment.rulesFor(contractor), { employee: false, salaried: false, exempt: false, overtime: false, sickLeave: false, breaks: false, taxPaper: 'W-9' });
  assert.equal(employment.rulesFor({ ...fullSalary, overtime_exempt: 1 }).breaks, false, 'exempt staff: no break rules');
  assert.equal(employment.rulesFor(partSalary).overtime, true, 'part-time salaried staff still get overtime');

  assert.equal(employment.regularRate(fullSalary), 37.5, '$78,000 / 52 weeks / 40 hours');
  assert.equal(employment.regularRate(partSalary), 25, '$31,200 / 52 weeks / 24 hours');
  assert.equal(employment.minimumWage(2026), 16.9);
  assert.equal(employment.minimumWage(2031), 16.9, 'until newer tables are added');
  assert.equal(employment.exemptMinimum(2026), 70304);

  // Two weeks, Sunday to Saturday: the salary, and 4 hours past a 24-hour-a-week schedule paid on top.
  const run = { period_start: '2026-10-04', period_end: '2026-10-17' };
  const hours = { regular_hours: 52, overtime_hours: 0, hourly_rate: 25 };
  const line = employment.salaryLine(hours, { employee: partSalary, run, periods: 26 });
  assert.deepEqual([line.salary_pay, line.scheduled_hours, line.extra_hours, line.regular_pay], [1200, 48, 4, 100]);
  // A first paycheck: started on the second Wednesday (3 of the 10 weekdays).
  assert.equal(employment.employedShare({ periodStart: run.period_start, periodEnd: run.period_end, startDate: '2026-10-14' }), 0.3);
  assert.equal(employment.salaryLine(hours, { employee: { ...partSalary, start_date: '2026-10-14' }, run, periods: 26 }).salary_pay, 360);
  assert.equal(employment.salaryLine(hours, { employee: fullSalary, run, periods: 26 }).extra_hours, 0, 'full time: past 40 is overtime instead');
});

test('the staff form: the type decides W-2 or 1099 and salary or hourly', () => {
  let r = employment.readPayFields({ employment_type: 'Contractor', hourly_rate: '35', pay_basis: 'salary', overtime_exempt: '1' });
  assert.equal(r.error, null);
  assert.deepEqual([r.values.tax_form, r.values.pay_basis, r.values.overtime_exempt], ['1099', 'hourly', 0]);
  r = employment.readPayFields({ employment_type: 'Part Time Regular', annual_salary: '31,200', weekly_hours: '24' }, {}, '2026');
  assert.deepEqual([r.error, r.values.tax_form, r.values.pay_basis, r.values.annual_salary], [null, 'W-2', 'salary', 31200]);
  assert.match(employment.readPayFields({ employment_type: 'Part Time Regular', annual_salary: '31200', weekly_hours: '40' }).error, /less than 40/);
  assert.match(employment.readPayFields({ employment_type: 'Full Time', pay_basis: 'salary', annual_salary: '60000', overtime_exempt: '1' }, {}, '2026').error, /at least \$70,304\.00/);
  assert.equal(employment.readPayFields({ employment_type: 'Full Time', pay_basis: 'salary', annual_salary: '80000', overtime_exempt: '1' }, {}, '2026').values.overtime_exempt, 1);
  assert.match(employment.readPayFields({ employment_type: 'Part Time Hourly', hourly_rate: '15' }, {}, '2026').error, /minimum wage is \$16\.90/);
  assert.equal(employment.readPayFields({ employment_type: 'Contractor', hourly_rate: '15' }).error, null, 'contractors set their own rate');
  assert.match(employment.readPayFields({}).error, /Choose an employment type/);

  const change = employment.payChange({ ...r.values, employment_type: 'Contractor', tax_form: '1099' }, { employment_type: 'Full Time', tax_form: 'W-2', pay_basis: 'hourly', hourly_rate: 30 });
  assert.match(employment.changeSummary(change.before, change.after), /Contractor → Full Time/);
  assert.equal(employment.payChange(r.values, { ...r.values }), null);
});
