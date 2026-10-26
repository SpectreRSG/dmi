// The side menu's alerts: a count next to each menu item where something
// needs this person's attention soon, such as an incident report to review, a
// new message or an unfilled shift tonight. Red means "act now"; amber means
// "coming up". views/partials/top.ejs shows them, and the phone's menu button
// gets a dot when there are any.
//
// The office-wide counts are kept for 30 seconds (and forgotten whenever a
// form is sent), so moving between pages stays quick.
const db = require('../db');
const time = require('../time');
const { complianceFor } = require('./compliance');
const { obligations } = require('./taxDeposits');
const { newHiresDue } = require('./newHires');
const { openShiftsFor } = require('./openShifts');
const { timeCardsDue, dayWord } = require('./reminders');
const { pendingCount } = require('./shiftRequests');

const KEEP_MS = 30 * 1000;
const TAX_DUE_SOON_DAYS = 7;
let officeCache = null; // { at, admin, data }

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// One alert: a count, what it means, and "warn" (amber) if nothing is urgent.
function alert(parts, { warn = false } = {}) {
  const shown = parts.filter((p) => p.n > 0);
  const count = shown.reduce((sum, p) => sum + p.n, 0);
  return count ? { count, text: shown.map((p) => p.text).join('; '), warn } : null;
}

async function officeAlerts(isAdmin, settings) {
  const today = time.todayStr();
  const now = time.nowStr();
  const in24h = time.addMinutes(now, 24 * 60);
  const counts = await db.get(
    `SELECT
       (SELECT COUNT(*)::int FROM shifts WHERE status = 'scheduled' AND employee_id IS NULL AND start_at > ? AND start_at < ?) AS unfilled_week,
       (SELECT COUNT(*)::int FROM shifts WHERE status = 'scheduled' AND employee_id IS NULL AND start_at > ? AND start_at < ?) AS unfilled_day,
       (SELECT COUNT(*)::int FROM shift_offers o JOIN shifts s ON s.id = o.shift_id WHERE o.status = 'open' AND o.escalated_at IS NOT NULL AND s.start_at > ?) AS unclaimed,
       (SELECT COUNT(*)::int FROM time_entries WHERE status = 'pending') AS hours,
       (SELECT COUNT(*)::int FROM contracts WHERE status = 'active' AND end_date IS NOT NULL AND end_date < ?) AS contracts_ended,
       (SELECT COUNT(*)::int FROM contracts WHERE status = 'active' AND end_date IS NOT NULL AND end_date >= ? AND end_date <= ?) AS contracts_ending,
       (SELECT COUNT(*)::int FROM incident_reports WHERE status = 'submitted') AS incidents,
       (SELECT COUNT(*)::int FROM users WHERE role = 'pending' AND active = 1) AS signups,
       (SELECT COUNT(*)::int FROM bank_accounts b JOIN employees e ON e.id = b.employee_id WHERE b.status = 'pending' AND e.status = 'active') AS banks`,
    now, `${time.addDays(today, 7)}T00:00`,
    now, in24h,
    now,
    today,
    today, time.addDays(today, settings.expiry_warning_days)
  );
  counts.requests = await pendingCount(now); // with a date still to come
  const employees = await db.all("SELECT * FROM employees WHERE status = 'active'");
  const { byEmployee } = await complianceFor(employees, settings.expiry_warning_days);
  const levels = [...byEmployee.values()].map((c) => c.level);
  const bad = levels.filter((l) => l === 'bad').length;
  const warnings = levels.filter((l) => l === 'warn').length;
  const laterShifts = counts.unfilled_week - counts.unfilled_day;

  const data = {
    schedule: alert([
      { n: counts.unfilled_day, text: `${plural(counts.unfilled_day, 'unfilled shift')} in the next 24 hours` },
      { n: laterShifts, text: `${plural(laterShifts, 'unfilled shift')} later this week` },
      { n: counts.requests, text: `${plural(counts.requests, 'shift request')} from sites to approve` },
    ], { warn: !counts.unfilled_day && !counts.requests && !counts.unclaimed }),
    timesheets: alert([{ n: counts.hours, text: `${plural(counts.hours, 'entry', 'entries')} of hours to approve` }]),
    training: alert([
      { n: bad, text: `${plural(bad, 'person', 'people')} with an expired or missing license or required training` },
      { n: warnings, text: `${plural(warnings, 'person', 'people')} with a license or training expiring soon` },
    ], { warn: !bad }),
    contracts: alert([
      { n: counts.contracts_ended, text: `${plural(counts.contracts_ended, 'contract')} past the end date` },
      { n: counts.contracts_ending, text: `${plural(counts.contracts_ending, 'contract')} ending soon` },
    ], { warn: !counts.contracts_ended }),
  };
  if (isAdmin) {
    const newHires = await newHiresDue(today);
    const lateHires = newHires.filter((h) => h.overdue).length;
    data.incidents = alert([{ n: counts.incidents, text: `${plural(counts.incidents, 'incident report')} to review` }]);
    data.signups = alert([{ n: counts.signups, text: `${plural(counts.signups, 'new account')} waiting for a role` }]);
    data.staff = alert([
      { n: newHires.length, text: `${plural(newHires.length, 'new hire report')} (DE 34) to send${lateHires ? `, ${lateHires} late` : ''}` },
      { n: counts.banks, text: `${plural(counts.banks, 'bank account')} for direct deposit to approve` },
    ]);
    data.pay = await taxAlert(settings, today);
  }
  return data;
}

// Payroll tax payments due within a week, or late (this year's, and last year's in January).
async function taxAlert(settings, today) {
  const year = Number(today.slice(0, 4));
  const years = today.slice(5, 7) === '01' ? [year - 1, year] : [year];
  const soon = time.addDays(today, TAX_DUE_SOON_DAYS);
  const owed = (await Promise.all(years.map((y) => obligations(y, settings, today)))).flat()
    .filter((o) => ['due', 'part', 'overdue'].includes(o.status) && o.due <= soon);
  const late = owed.filter((o) => o.status === 'overdue').length;
  return alert([
    { n: late, text: `${plural(late, 'payroll tax payment')} late` },
    { n: owed.length - late, text: `${plural(owed.length - late, 'payroll tax payment')} due within a week` },
  ]);
}

// Incident reports someone started but hasn't sent, or that the office has asked about.
async function myIncidentAlert(user) {
  const row = await db.get(
    `SELECT COUNT(*) FILTER (WHERE status = 'info_requested')::int AS asked, COUNT(*) FILTER (WHERE status = 'draft')::int AS drafts
     FROM incident_reports WHERE created_by = ?`,
    user.id
  );
  return alert([
    { n: row.asked, text: `the office asked for more about ${plural(row.asked, 'report')}` },
    { n: row.drafts, text: `${plural(row.drafts, 'report')} started but not sent` },
  ]);
}

async function officerAlerts(user) {
  const data = { myIncidents: await myIncidentAlert(user) };
  if (!user.employee_id) return data;
  const [offers, me] = await Promise.all([
    openShiftsFor(user.employee_id),
    db.get(
      `SELECT e.tax_form,
         EXISTS (SELECT 1 FROM tax_profiles t WHERE t.employee_id = e.id) AS has_w9,
         EXISTS (SELECT 1 FROM withholding_profiles w WHERE w.employee_id = e.id) AS has_w4
       FROM employees e WHERE e.id = ?`,
      user.employee_id
    ),
  ]);
  data.openShifts = alert([{ n: offers.length, text: `${plural(offers.length, 'open shift')} you can claim` }]);
  const missingForm = me && ((me.tax_form === '1099' && !me.has_w9) || (me.tax_form === 'W-2' && !me.has_w4));
  const cards = timeCardsDue();
  data.myPay = alert([
    { n: missingForm ? 1 : 0, text: `fill in your ${me?.tax_form === 'W-2' ? 'W-4 and DE 4' : 'W-9'}` },
    { n: cards ? 1 : 0, text: cards ? `time cards are due ${dayWord(cards.end)}: check your hours` : '' },
  ], { warn: !missingForm });
  return data;
}

// No phone or computer with app notifications on: nothing reaches them.
// (Officers can't use their pages until they turn them on.)
const HEAR_ABOUT = {
  admin: 'new incident reports, messages and call-outs',
  manager: 'call-outs and open shifts nobody has claimed',
  client: 'replies from the office and covered shift requests',
};
async function notificationsAlert(user) {
  const on = await db.get('SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1', user.id);
  return alert([{ n: on ? 0 : 1, text: `notifications are off: turn them on to hear about ${HEAR_ABOUT[user.role]}` }]);
}

// Everything for this person's menu: { [badge]: { count, text, warn } }.
async function menuAlerts(user, settings) {
  if (user.role === 'admin' || user.role === 'manager') {
    const isAdmin = user.role === 'admin';
    if (!officeCache || officeCache.admin !== isAdmin || Date.now() - officeCache.at > KEEP_MS) {
      officeCache = { at: Date.now(), admin: isAdmin, data: await officeAlerts(isAdmin, settings) };
    }
    const [account, myIncidents] = await Promise.all([notificationsAlert(user), isAdmin ? null : myIncidentAlert(user)]);
    return { ...officeCache.data, account, ...(isAdmin ? {} : { myIncidents }) };
  }
  if (user.role === 'officer') return officerAlerts(user);
  if (user.role === 'client') {
    const [account, myIncidents] = await Promise.all([notificationsAlert(user), myIncidentAlert(user)]);
    return { account, myIncidents };
  }
  return {};
}

// After a form is sent, the counts may have changed.
function forget() {
  officeCache = null;
}

module.exports = { menuAlerts, forget };
