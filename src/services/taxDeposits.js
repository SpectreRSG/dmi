// Paying the payroll taxes: what's owed to the IRS and the EDD from finalized
// pay runs with W-2 employees, when each payment is due, which have been
// paid (the office records them), and reminders before they're due.
//
// Due dates (IRS Publication 15; California follows the federal schedule):
// - Federal income tax, Social Security and Medicare (both shares), and
//   California income tax and SDI:
//   - monthly depositors (most new employers): by the 15th of the next month;
//   - semiweekly depositors: paydays Wednesday–Friday by the next Wednesday,
//     Saturday–Tuesday by the next Friday.
// - FUTA: each quarter, by the end of the next month, once more than $500 has
//   built up (otherwise it carries over); the rest by January 31.
// - California UI and ETT: each quarter, by the end of the next month (with the DE 9).
// A due date on a weekend or holiday moves to the next business day. Dates are
// on the safe side: the IRS's extra day after a holiday isn't counted.
const db = require('../db');
const time = require('../time');
const { round2 } = require('./payroll');
const { businessDayOnOrAfter } = require('./businessDays');

const KINDS = {
  federal: {
    label: 'Federal income tax, Social Security and Medicare',
    agency: 'IRS',
    how: 'EFTPS (eftps.gov)',
    fields: ['fed_income_tax', 'social_security', 'employer_social_security', 'medicare', 'employer_medicare', 'additional_medicare'],
  },
  california: { label: 'California income tax and SDI', agency: 'EDD', how: 'EDD e-Services for Business', fields: ['ca_income_tax', 'ca_sdi'] },
  futa: { label: 'Federal unemployment (FUTA)', agency: 'IRS', how: 'EFTPS (eftps.gov)', fields: ['futa'] },
  ca_ui: { label: 'California UI and ETT', agency: 'EDD', how: 'EDD e-Services for Business', fields: ['ca_ui', 'ca_ett'] },
};
const FUTA_DEPOSIT_THRESHOLD = 500;
const REMIND_DAYS_BEFORE = 3;

const PAY_DATE = 'COALESCE(p.paid_on, substr(p.finalized_at, 1, 10))';
const pad = (n) => String(n).padStart(2, '0');
const lastDayOfMonth = (year, month) => time.addDays(month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`, -1);
const quarterOf = (date) => Math.ceil(Number(date.slice(5, 7)) / 3);

// Every tax amount from finalized W-2 pay lines, by pay date, for pay dates in a year.
async function liabilitiesByPayDate(year) {
  const fields = [...new Set(Object.values(KINDS).flatMap((k) => k.fields))];
  const rows = await db.all(
    `SELECT ${PAY_DATE} AS pay_date, ${fields.map((f) => `COALESCE(SUM(i.${f}), 0) AS ${f}`).join(', ')}
     FROM pay_run_items i JOIN pay_runs p ON p.id = i.pay_run_id
     WHERE p.status = 'finalized' AND i.tax_form = 'W-2' AND substr(${PAY_DATE}, 1, 4) = ?
     GROUP BY ${PAY_DATE} ORDER BY ${PAY_DATE}`,
    String(year)
  );
  return rows.map((r) => ({
    payDate: r.pay_date,
    ...Object.fromEntries(Object.entries(KINDS).map(([kind, k]) => [kind, round2(k.fields.reduce((s, f) => s + Number(r[f]), 0))])),
  }));
}

// Which federal/California deposit a pay date belongs to, and when it's due.
function depositPeriod(payDate, schedule) {
  if (schedule === 'semiweekly') {
    const dow = time.dayOfWeek(payDate); // 0 = Monday
    const wedToFri = dow >= 2 && dow <= 4;
    const periodEnd = time.addDays(payDate, wedToFri ? 4 - dow : (1 - dow + 7) % 7); // Friday, or Tuesday
    const due = businessDayOnOrAfter(time.addDays(periodEnd, wedToFri ? 5 : 3)); // next Wednesday, or Friday
    const periodStart = time.addDays(periodEnd, wedToFri ? -2 : -3);
    return { key: `S:${periodEnd}`, label: `Paydays ${time.fmtDate(periodStart)} – ${time.fmtDate(periodEnd)}`, due };
  }
  const [y, m] = payDate.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-15` : `${y}-${pad(m + 1)}-15`;
  return { key: `M:${payDate.slice(0, 7)}`, label: time.fmtMonth(payDate.slice(0, 7)), due: businessDayOnOrAfter(next) };
}

function quarterPeriod(year, quarter) {
  const dueMonth = quarter * 3 + 1;
  const due = dueMonth > 12 ? lastDayOfMonth(year + 1, 1) : lastDayOfMonth(year, dueMonth);
  return { key: `Q:${year}-${quarter}`, label: `${year} quarter ${quarter}`, due: businessDayOnOrAfter(due) };
}

// All the payments for a year's pay dates, with what's been recorded against each.
async function obligations(year, settings, today = time.todayStr()) {
  const byDate = await liabilitiesByPayDate(year);
  const list = new Map();
  const add = (kind, period, amount, extra = {}) => {
    const id = `${kind}|${period.key}`;
    if (!list.has(id)) list.set(id, { kind, ...KINDS[kind], key: period.key, period: period.label, due: period.due, amount: 0, payDates: [], ...extra });
    const o = list.get(id);
    o.amount = round2(o.amount + amount);
    return o;
  };
  for (const row of byDate) {
    const period = depositPeriod(row.payDate, settings.fed_deposit_schedule);
    for (const kind of ['federal', 'california']) {
      if (row[kind]) add(kind, period, row[kind]).payDates.push(row.payDate);
    }
    if (row.ca_ui) add('ca_ui', quarterPeriod(year, quarterOf(row.payDate)), row.ca_ui).payDates.push(row.payDate);
  }
  // FUTA: carried over until more than $500 has built up, or the year ends.
  let carried = 0;
  for (let q = 1; q <= 4; q += 1) {
    const amount = round2(byDate.filter((r) => quarterOf(r.payDate) === q).reduce((s, r) => s + r.futa, 0));
    if (!amount && !carried) continue;
    const total = round2(carried + amount);
    const period = quarterPeriod(year, q);
    if (total > FUTA_DEPOSIT_THRESHOLD || q === 4) {
      add('futa', period, total, { carriedIn: carried }); // (the 4th quarter's is due January 31)
      carried = 0;
    } else {
      add('futa', period, total, { carriesOver: true });
      carried = total;
    }
  }

  const paid = await db.all(
    'SELECT kind, period_key, COALESCE(SUM(amount), 0) AS amount, MAX(paid_on) AS paid_on, COUNT(*)::int AS n FROM tax_deposits GROUP BY kind, period_key'
  );
  const paidBy = new Map(paid.map((p) => [`${p.kind}|${p.period_key}`, p]));
  return [...list.values()]
    .map((o) => {
      const p = paidBy.get(`${o.kind}|${o.key}`);
      const paidAmount = p ? round2(p.amount) : 0;
      let status;
      if (o.carriesOver) status = 'carries';
      else if (paidAmount >= o.amount - 0.005) status = 'paid';
      else if (today > o.due) status = 'overdue';
      else status = paidAmount > 0 ? 'part' : 'due';
      return { ...o, paidAmount, paidOn: p?.paid_on || null, left: round2(Math.max(0, o.amount - paidAmount)), status };
    })
    .sort((a, b) => a.due.localeCompare(b.due) || a.kind.localeCompare(b.kind));
}

// Recorded payments, newest first.
function recordedPayments(limit = 50) {
  return db.all(
    `SELECT d.*, u.name AS recorded_by_name FROM tax_deposits d LEFT JOIN users u ON u.id = d.recorded_by
     ORDER BY d.paid_on DESC, d.id DESC LIMIT ?`,
    limit
  );
}

// True if this reminder hasn't gone out yet (and now counts as sent).
async function claim(kind, ref) {
  return (await db.run('INSERT INTO reminders_sent (kind, ref) VALUES (?, ?) ON CONFLICT DO NOTHING', kind, ref)).changes === 1;
}

// Tells the admins a few days before a payment is due, and once if it's late.
// (Managers don't see pay or taxes.)
async function remindTaxDeposits(settings, formatMoney) {
  const { notifyAdmins } = require('./notify');
  const today = time.todayStr();
  const year = Number(today.slice(0, 4));
  for (const y of [year - 1, year]) {
    for (const o of await obligations(y, settings, today)) {
      if (!['due', 'part', 'overdue'].includes(o.status)) continue;
      const ref = `${o.kind}:${o.key}`;
      const amount = formatMoney(o.left);
      if (o.status === 'overdue') {
        if (await claim('tax_late', ref)) {
          await notifyAdmins({
            title: 'Tax payment overdue',
            body: `${o.label} for ${o.period}: ${amount} was due ${time.fmtDate(o.due)}. Pay it through ${o.how} as soon as you can, then record it in DMI.`,
            url: '/pay/deposits',
            tag: `tax-${ref}`,
          });
        }
      } else if (today >= time.addDays(o.due, -REMIND_DAYS_BEFORE) && (await claim('tax_due', ref))) {
        await notifyAdmins({
          title: `Tax payment due ${time.fmtDate(o.due)}`,
          body: `${o.label} for ${o.period}: ${amount}. Pay it through ${o.how}, then record it in DMI.`,
          url: '/pay/deposits',
          tag: `tax-${ref}`,
        });
      }
    }
  }
}

module.exports = { KINDS, obligations, depositPeriod, quarterPeriod, liabilitiesByPayDate, recordedPayments, remindTaxDeposits, FUTA_DEPOSIT_THRESHOLD };
