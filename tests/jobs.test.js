// The background jobs only wake the database when something is due (see
// src/services/jobs.js). These tests use their own empty database and a
// stopped clock, so "now" doesn't move while they check what's due next.
const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startLocalDatabase } = require('../scripts/local-db');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dmi-jobs-test-'));
const time = require('../src/time');

let localDb;
let db;
let jobs;
let ids;
const NOW = Date.parse('2026-11-04T18:15:00Z'); // 10:15 on a Wednesday in Los Angeles

// A stand-in for Netlify Blobs.
function fakeBlobs() {
  const data = new Map();
  return {
    async get(key) {
      return data.has(key) ? structuredClone(data.get(key)) : null;
    },
    async setJSON(key, value) {
      data.set(key, structuredClone(value));
    },
  };
}

// Counts every database query until stop().
function countQueries() {
  let count = 0;
  const originals = {};
  for (const name of ['get', 'all', 'run', 'insert']) {
    originals[name] = db[name];
    db[name] = (...args) => {
      count += 1;
      return originals[name](...args);
    };
  }
  return { count: () => count, stop: () => Object.assign(db, originals) };
}

const at = (minutes) => time.addMinutes(time.nowStr(), minutes);
async function addShift(startAt, endAt, { officer = true, request = null } = {}) {
  return db.insert(
    'INSERT INTO shifts (site_id, employee_id, start_at, end_at, request_id) VALUES (?, ?, ?, ?, ?)',
    ids.site, officer ? ids.employee : null, startAt, endAt, request
  );
}

test.before(async () => {
  localDb = await startLocalDatabase();
  process.env.DATABASE_URL = localDb.url;
  db = require('../src/db');
  jobs = require('../src/services/jobs');
  require('../src/services/notify').setSender(async () => {});
  const client = await db.insert("INSERT INTO clients (name) VALUES ('Harbour Mall')");
  ids = {
    client,
    site: await db.insert("INSERT INTO sites (client_id, name) VALUES (?, 'Main entrance')", client),
    employee: await db.insert("INSERT INTO employees (first_name, last_name) VALUES ('Owen', 'Park')"),
  };
  await db.run("UPDATE settings SET value = '2000-01-01' WHERE key = 'hours_from_schedule_since'");
  mock.timers.enable({ apis: ['Date'], now: NOW });
  time.setTimeZone('America/Los_Angeles');
});

test.after(async () => {
  mock.timers.reset();
  await db.close();
  await localDb.stop();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('the next time something is due is the soonest thing coming up', async () => {
  const { nextShiftEnd } = require('../src/services/hoursFromSchedule');
  const { nextShiftReminder, nextTimeCardReminder } = require('../src/services/reminders');
  const { nextOfferStep } = require('../src/services/openShifts');
  const { nextToOffer } = require('../src/services/shiftRequests');
  const today = time.todayStr();
  assert.equal(time.nowStr(), '2026-11-04T10:15');
  // Always in the running: midnight (the daily reminders), the next time-card
  // reminder, and 3 hours from now at the latest.
  const soonest = (...times) => [...times, '2026-11-05T00:00', nextTimeCardReminder(), at(180)].sort()[0];
  assert.match(nextTimeCardReminder(), /^\d{4}-\d\d-\d\dT09:00$/);
  assert.ok(nextTimeCardReminder() > time.nowStr());
  assert.equal(await jobs.nextDue(), soonest());
  assert.equal(await jobs.nextDue(), at(180), 'nothing on: look again in 3 hours');

  // A shift with an officer: its 2-hour reminder, then its end (hours recorded).
  const shift = await addShift(at(150), at(630));
  assert.equal(await nextShiftReminder(), at(30));
  assert.equal(await nextShiftEnd(), at(630));
  assert.equal(await jobs.nextDue(), at(30));
  // Two days away: the 24-hour reminder comes first.
  await db.run('UPDATE shifts SET start_at = ?, end_at = ? WHERE id = ?', at(48 * 60), at(56 * 60), shift);
  assert.equal(await nextShiftReminder(), at(24 * 60));
  // Nobody on it: no reminder and no hours.
  await db.run('UPDATE shifts SET employee_id = NULL WHERE id = ?', shift);
  assert.equal(await nextShiftReminder(), undefined);
  assert.equal(await nextShiftEnd(), undefined);

  // An open shift: the next group of officers, then telling the office, then its start.
  const offer = await db.insert('INSERT INTO shift_offers (shift_id, next_wave_at, escalate_at) VALUES (?, ?, ?)', shift, at(10), at(40));
  assert.equal(await nextOfferStep(), at(10));
  assert.equal(await jobs.nextDue(), at(10));
  await db.run('UPDATE shift_offers SET next_wave_at = NULL WHERE id = ?', offer);
  assert.equal(await nextOfferStep(), at(40));
  await db.run('UPDATE shift_offers SET escalated_at = ? WHERE id = ?', time.nowStr(), offer);
  assert.equal(await nextOfferStep(), at(48 * 60));
  // A step a failed run left behind is due now.
  await db.run('UPDATE shift_offers SET next_wave_at = ? WHERE id = ?', at(-5), offer);
  assert.equal(await jobs.nextDue(), at(-5));
  await db.run("UPDATE shift_offers SET status = 'withdrawn' WHERE id = ?", offer);
  assert.equal(await nextOfferStep(), undefined);

  // A repeating request's shift is offered the day it comes within two weeks...
  const request = await db.insert(
    "INSERT INTO shift_requests (client_id, site_id, start_at, end_at, last_end_at, status) VALUES (?, ?, ?, ?, ?, 'approved')",
    ids.client, ids.site, `${time.addDays(today, 20)}T18:00`, `${time.addDays(today, 21)}T06:00`, `${time.addDays(today, 21)}T06:00`
  );
  const requested = await addShift(`${time.addDays(today, 20)}T18:00`, `${time.addDays(today, 21)}T06:00`, { officer: false, request });
  assert.equal(await nextToOffer(), `${time.addDays(today, 6)}T00:00`);
  // ...or straight away if it's already within two weeks (more than one run's worth).
  await db.run('UPDATE shifts SET start_at = ?, end_at = ? WHERE id = ?', `${time.addDays(today, 3)}T18:00`, `${time.addDays(today, 4)}T06:00`, requested);
  assert.equal(await nextToOffer(), time.nowStr());
  assert.equal(await jobs.nextDue(), time.nowStr());

  await db.run('DELETE FROM shifts');
  await db.run('DELETE FROM shift_requests');
});

test('the 5-minute timer only wakes the database when something is due', async (t) => {
  const blobs = fakeBlobs();
  jobs.setNoteStore(blobs);
  t.after(() => jobs.setNoteStore(undefined));
  const shift = await addShift(at(-480), at(20)); // ends in 20 minutes

  // Nothing noted yet: it runs, and notes when to look next.
  assert.deepEqual(await jobs.runIfDue({ version: 'deploy-1' }), { ran: true, reason: 'nothing noted yet', due: at(20) });
  const note = await blobs.get('next');
  assert.equal(note.due, at(20), 'when the shift ends');
  assert.equal(note.zone, 'America/Los_Angeles');
  assert.equal(note.version, 'deploy-1');

  // Until then, the timer doesn't touch the database at all.
  const queries = countQueries();
  assert.deepEqual(await jobs.runIfDue({ version: 'deploy-1' }), { ran: false, due: at(20) });
  mock.timers.setTime(NOW + 19 * 60 * 1000);
  assert.equal((await jobs.runIfDue({ version: 'deploy-1' })).ran, false);
  queries.stop();
  assert.equal(queries.count(), 0);
  assert.equal((await db.get('SELECT status FROM shifts WHERE id = ?', shift)).status, 'scheduled');

  // Once the shift has ended, it runs and records the hours.
  mock.timers.setTime(NOW + 20 * 60 * 1000);
  assert.equal((await jobs.runIfDue({ version: 'deploy-1' })).reason, 'due at 2026-11-04T10:35');
  assert.equal((await db.get('SELECT status FROM shifts WHERE id = ?', shift)).status, 'completed');
  assert.ok(await db.get("SELECT 1 FROM time_entries WHERE shift_id = ? AND source = 'schedule'", shift));
  assert.equal((await jobs.runIfDue({ version: 'deploy-1' })).ran, false);

  // A form sent on the site: the next look runs, in case it changed something.
  mock.timers.setTime(NOW + 30 * 60 * 1000);
  const open = await addShift(at(60), at(540), { officer: false });
  await db.insert('INSERT INTO shift_offers (shift_id, next_wave_at, escalate_at) VALUES (?, ?, ?)', open, at(10), at(30));
  await jobs.somethingChanged();
  assert.equal((await jobs.runIfDue({ version: 'deploy-1' })).reason, 'a form was sent');
  assert.equal((await blobs.get('next')).due, at(10), 'now it knows about the open shift');
  // A run soon after the form might have missed it, so it looks once more, then settles.
  mock.timers.setTime(NOW + 36 * 60 * 1000);
  await jobs.runIfDue({ version: 'deploy-1' });
  assert.equal((await jobs.runIfDue({ version: 'deploy-1' })).ran, false);

  // Two runs at once: the sooner time either saw coming is kept.
  await blobs.setJSON('next', { ...(await blobs.get('next')), due: at(2) });
  await jobs.runDueJobs({ version: 'deploy-1' });
  assert.equal((await blobs.get('next')).due, at(2));

  // A new deploy looks straight away.
  assert.equal((await jobs.runIfDue({ version: 'deploy-2' })).reason, 'a new deploy');
  assert.equal((await jobs.runIfDue({ version: 'deploy-2' })).ran, false);

  // Can't read the note: it runs, to be safe.
  t.mock.method(console, 'error', () => {});
  blobs.get = async () => {
    throw new Error('Blobs is down');
  };
  assert.equal((await jobs.runIfDue({ version: 'deploy-2' })).reason, "the note couldn't be read");
});
