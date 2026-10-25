// The direct deposit file for the company's bank: a standard NACHA (ACH)
// file of PPD credits, one per person, in 94-character records:
//   1 file header · 5 batch header · 6 one entry per person ·
//   8 batch control · 9 file control · lines of 9s to fill the last block of 10.
// The bank gives the company its ACH details when it sets up payroll uploads
// (Settings → Direct deposit). Only maths and text here; see tests/nacha.test.js.

// A US bank routing number is 9 digits with a check digit (the ABA formula).
function routingOk(routing) {
  if (!/^\d{9}$/.test(String(routing || ''))) return false;
  const d = String(routing).split('').map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

// Plain uppercase letters, digits and spaces (what every bank accepts), cut or padded to a width.
const clean = (text) => String(text ?? '').normalize('NFKD').replace(/[^\x20-\x7E]/g, '').toUpperCase();
const left = (text, width) => clean(text).slice(0, width).padEnd(width, ' ');
const right = (text, width) => clean(text).slice(-width).padStart(width, ' ');
const zeros = (n, width) => String(n).padStart(width, '0').slice(-width);
const yymmdd = (date) => date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10);

// `bank`: { routing, name, companyId, immediateOrigin, companyName }.
// `entries`: [{ name, id, routing, account, type ('checking'|'savings'), cents }].
// `effectiveDate`: the day the money should arrive ('2026-10-30'); `now`: '2026-10-28T14:05'.
function buildNachaFile({ bank, entries, effectiveDate, now, description = 'PAYROLL' }) {
  const odfi = bank.routing.slice(0, 8);
  const lines = [];
  lines.push(
    `101${right(bank.routing, 10)}${right(bank.immediateOrigin, 10)}${yymmdd(now.slice(0, 10))}${now.slice(11, 13)}${now.slice(14, 16)}`
    + `A094101${left(bank.name, 23)}${left(bank.companyName, 23)}${' '.repeat(8)}`
  );
  lines.push(
    `5220${left(bank.companyName, 16)}${' '.repeat(20)}${left(bank.companyId, 10)}PPD${left(description, 10)}`
    + `${yymmdd(effectiveDate)}${yymmdd(effectiveDate)}   1${odfi}${zeros(1, 7)}`
  );
  let hash = 0;
  let total = 0;
  entries.forEach((e, i) => {
    hash += Number(e.routing.slice(0, 8));
    total += e.cents;
    lines.push(
      `6${e.type === 'savings' ? '32' : '22'}${e.routing}${left(e.account, 17)}${zeros(e.cents, 10)}${left(e.id, 15)}${left(e.name, 22)}  0`
      + `${odfi}${zeros(i + 1, 7)}`
    );
  });
  const entryHash = zeros(hash, 10);
  lines.push(`8220${zeros(entries.length, 6)}${entryHash}${zeros(0, 12)}${zeros(total, 12)}${left(bank.companyId, 10)}${' '.repeat(25)}${odfi}${zeros(1, 7)}`);
  const records = lines.length + 1;
  const blocks = Math.ceil(records / 10);
  lines.push(`9${zeros(1, 6)}${zeros(blocks, 6)}${zeros(entries.length, 8)}${entryHash}${zeros(0, 12)}${zeros(total, 12)}${' '.repeat(39)}`);
  while (lines.length % 10) lines.push('9'.repeat(94));
  return `${lines.join('\r\n')}\r\n`;
}

module.exports = { routingOk, buildNachaFile };
