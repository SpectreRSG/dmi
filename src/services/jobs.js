// The jobs that keep things moving without anyone pressing a button:
// recording the hours of shifts that have ended, offering a repeating shift
// request's shifts as they come within two weeks, and moving open-shift offers
// along (next wave of officers, telling the office when nobody has claimed one),
// reminders (shifts coming up, time cards due, tax payments, new hire reports),
// and removing messages once they're 2 years old.
//
// They run in two ways, and either is enough on its own:
// - from the 5-minute timer on the live site (netlify/functions/autopilot.mjs), and
// - on ordinary page loads, at most once a minute.
// Every step is safe to run twice at the same moment.
//
// On Netlify they only run when something is due. Netlify bills the database
// for every hour it's awake, and it only falls asleep after 5 minutes with
// nothing to do, so running every 5 minutes would keep it awake (and billed)
// all day. Instead, each run leaves a note in Netlify Blobs (outside the
// database) saying when the next thing is due: a shift ending, a reminder, the
// next group to tell about an open shift, midnight for the daily ones. Until
// then the timer reads the note and stops, and the database sleeps. Any form
// sent on the site marks that things may have changed, so the next look runs
// them. (On your computer, and wherever Blobs isn't set up, they always run.)
const config = require('../config');
const time = require('../time');
const { getSettings } = require('../settings');
const { recordFinishedShifts, nextShiftEnd } = require('./hoursFromSchedule');
const { advanceOffers, nextOfferStep } = require('./openShifts');
const { offerUpcoming, nextToOffer } = require('./shiftRequests');
const { sendReminders, nextShiftReminder, nextTimeCardReminder } = require('./reminders');
const { remindTaxDeposits } = require('./taxDeposits');
const { remindNewHires } = require('./newHires');
const chat = require('./chat');

const MAX_SLEEP_MINUTES = 3 * 60; // look at least this often anyway, in case something was missed
const CHANGE_MARGIN_MS = 5 * 60 * 1000; // a form sent this soon before a run started may not have been seen by it

async function runDueJobs({ version } = {}) {
  const startedAt = Date.now();
  const settings = await getSettings();
  time.setTimeZone(settings.timezone); // what "now" means for the company
  await recordFinishedShifts();
  await offerUpcoming(settings);
  await advanceOffers();
  await sendReminders();
  const money = (n) => `${settings.currency_symbol}${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  await remindTaxDeposits(settings, money);
  await remindNewHires();
  await chat.purgeOld(); // messages are kept for 2 years
  return saveNote({ startedAt, zone: settings.timezone, version });
}

// When something next needs doing, in company time (like '2026-10-31T14:00').
async function nextDue() {
  const now = time.nowStr();
  const times = await Promise.all([nextShiftEnd(), nextToOffer(), nextOfferStep(), nextShiftReminder()]);
  times.push(nextTimeCardReminder());
  times.push(`${time.addDays(time.todayStr(), 1)}T00:00`); // tax payments, new hire reports and old messages go by the day
  times.push(time.addMinutes(now, MAX_SLEEP_MINUTES));
  return times.filter(Boolean).sort()[0];
}

// The note lives in Netlify Blobs. Elsewhere (your computer, the tests) there's none.
// A fresh handle each time: Netlify gives each run its own key for Blobs, and a
// key kept from an earlier run stops working after a while.
let noteStore; // set by the tests
function notes() {
  if (noteStore !== undefined) return noteStore;
  if (!config.onNetlify) return null;
  try {
    return require('@netlify/blobs').getStore({ name: 'jobs', consistency: 'strong' });
  } catch {
    return null; // Blobs isn't set up here
  }
}

// For the tests: a stand-in for Blobs (undefined goes back to the real one).
function setNoteStore(store) {
  noteStore = store;
}

// Notes when the jobs are next due, and returns that time.
async function saveNote({ startedAt, zone, version }) {
  const store = notes();
  if (!store) return undefined;
  try {
    let due = await nextDue();
    const old = await store.get('next', { type: 'json' });
    // Two runs at once: keep the sooner time either of them saw coming.
    if (old && old.zone === zone && old.due > time.nowStr() && old.due < due) due = old.due;
    await store.setJSON('next', { due, zone, startedAt, version: version || old?.version });
    return due;
  } catch (err) {
    console.error('Could not note when the background jobs are next due:', err);
    return undefined;
  }
}

// Why the jobs need running now (nothing noted yet, a new deploy, a form sent
// since the last run, or something due), or null if they don't.
async function whyRun(store, version) {
  try {
    const [note, changed] = await Promise.all([store.get('next', { type: 'json' }), store.get('changed', { type: 'json' })]);
    if (!note) return { reason: 'nothing noted yet' };
    if (version && note.version !== version) return { reason: 'a new deploy' };
    if (changed && changed.at >= note.startedAt - CHANGE_MARGIN_MS) return { reason: 'a form was sent' };
    time.setTimeZone(note.zone);
    return time.nowStr() >= note.due ? { reason: `due at ${note.due}` } : { reason: null, due: note.due };
  } catch (err) {
    console.error('Could not read when the background jobs are due:', err);
    return { reason: "the note couldn't be read" }; // when in doubt, run them
  }
}

// The 5-minute timer and page loads: runs the jobs if they need running
// (without touching the database if not). Says whether they ran, why, and
// when they're next due.
async function runIfDue({ version } = {}) {
  const store = notes();
  const { reason, due } = store ? await whyRun(store, version) : { reason: 'no Blobs here, so always' };
  if (!reason) return { ran: false, due };
  return { ran: true, reason, due: await runDueJobs({ version }) };
}

// A form was sent: whatever it changed, the next look runs the jobs.
async function somethingChanged() {
  const store = notes();
  if (!store) return;
  try {
    await store.setJSON('changed', { at: Date.now() });
  } catch (err) {
    console.error('Could not note a change for the background jobs:', err);
  }
}

let lastCatchUp = 0;
// A problem here never stops the page someone is loading.
async function catchUp() {
  if (Date.now() - lastCatchUp < 60 * 1000) return;
  lastCatchUp = Date.now();
  try {
    await runIfDue();
  } catch (err) {
    console.error('Background jobs failed:', err);
  }
}

module.exports = { runDueJobs, runIfDue, nextDue, somethingChanged, catchUp, setNoteStore };
