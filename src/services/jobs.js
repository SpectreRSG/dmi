// The jobs that keep things moving without anyone pressing a button:
// recording the hours of shifts that have ended, offering a repeating shift
// request's shifts as they come within two weeks, and moving open-shift offers
// along (next wave of officers, telling the office when nobody has claimed one),
// and reminders (shifts coming up, time cards due).
//
// They run in two ways, and either is enough on its own:
// - every 5 minutes on the live site (netlify/functions/autopilot.mjs), and
// - on ordinary page loads, at most once a minute (handy on your computer and
//   on preview sites, where Netlify doesn't run timed jobs).
// Every step is safe to run twice at the same moment.
const time = require('../time');
const { getSettings } = require('../settings');
const { recordFinishedShifts } = require('./hoursFromSchedule');
const { advanceOffers } = require('./openShifts');
const { offerUpcoming } = require('./shiftRequests');
const { sendReminders } = require('./reminders');
const { remindTaxDeposits } = require('./taxDeposits');
const { remindNewHires } = require('./newHires');

async function runDueJobs() {
  const settings = await getSettings();
  time.setTimeZone(settings.timezone); // what "now" means for the company
  await recordFinishedShifts();
  await offerUpcoming(settings);
  await advanceOffers();
  await sendReminders();
  const money = (n) => `${settings.currency_symbol}${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  await remindTaxDeposits(settings, money);
  await remindNewHires();
}

let lastCatchUp = 0;
// A problem here never stops the page someone is loading.
async function catchUp() {
  if (Date.now() - lastCatchUp < 60 * 1000) return;
  lastCatchUp = Date.now();
  try {
    await runDueJobs();
  } catch (err) {
    console.error('Background jobs failed:', err);
  }
}

module.exports = { runDueJobs, catchUp };
