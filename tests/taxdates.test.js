// Due dates for payroll tax payments: business days, federal holidays, and
// the monthly, semiweekly and quarterly schedules.
const test = require('node:test');
const assert = require('node:assert/strict');
const { federalHolidays, isBusinessDay, businessDayOnOrAfter } = require('../src/services/businessDays');
const { depositPeriod, quarterPeriod } = require('../src/services/taxDeposits');

test('federal holidays, as observed', () => {
  const h = federalHolidays(2026);
  for (const day of ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
    '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25']) assert.ok(h.has(day), day);
  assert.ok(!h.has('2026-07-04'), 'July 4th 2026 is a Saturday, observed on Friday the 3rd');
  assert.ok(federalHolidays(2021).has('2021-12-31'), 'New Year 2022 fell on a Saturday');
  assert.equal(isBusinessDay('2026-10-24'), false, 'a Saturday');
  assert.equal(businessDayOnOrAfter('2026-02-14'), '2026-02-17', 'past the weekend and Presidents Day');
});

test('deposit due dates', () => {
  // Monthly: the 15th of the next month, moved past weekends and holidays.
  assert.deepEqual(depositPeriod('2026-10-23', 'monthly'), { key: 'M:2026-10', label: 'October 2026', due: '2026-11-16' });
  assert.equal(depositPeriod('2026-01-09', 'monthly').due, '2026-02-17');
  assert.equal(depositPeriod('2026-12-31', 'monthly').due, '2027-01-15');
  // Semiweekly: Wednesday–Friday paydays by the next Wednesday, Saturday–Tuesday by the next Friday.
  assert.deepEqual(depositPeriod('2026-10-23', 'semiweekly'), { key: 'S:2026-10-23', label: 'Paydays 21 Oct 2026 – 23 Oct 2026', due: '2026-10-28' });
  assert.equal(depositPeriod('2026-10-21', 'semiweekly').key, 'S:2026-10-23');
  assert.equal(depositPeriod('2026-10-26', 'semiweekly').due, '2026-10-30');
  assert.equal(depositPeriod('2026-10-24', 'semiweekly').key, 'S:2026-10-27');
  // Quarterly (FUTA, California UI): the end of the next month.
  assert.equal(quarterPeriod(2026, 3).due, '2026-11-02', 'October 31st 2026 is a Saturday');
  assert.equal(quarterPeriod(2026, 4).due, '2027-02-01', 'January 31st 2027 is a Sunday');
  assert.equal(quarterPeriod(2026, 1).due, '2026-04-30');
});
