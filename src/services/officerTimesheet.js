// The DMI timesheet: the two-week pay periods and the filled-in DMI timesheet
// PDF. This is the same form and layout as the old stand-alone timesheet page
// (public/timesheet/), but the PDF is made here, from the hours on record.
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const config = require('../config');
const time = require('../time');

// A known pay period start (Sunday 20 July 2025). Every period is 14 days
// counted from here, Sunday to Saturday.
const ANCHOR = '2025-07-20';
const PERIOD_DAYS = 14;

function periodStartFor(date) {
  const periods = Math.floor(time.daysBetween(ANCHOR, date) / PERIOD_DAYS);
  return time.addDays(ANCHOR, periods * PERIOD_DAYS);
}

function periodEnd(start) {
  return time.addDays(start, PERIOD_DAYS - 1);
}

// '2026-10-18' -> '10/18/26', like the paper form.
function short(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${m}/${d}/${String(y).slice(-2)}`;
}

function periodLabel(start) {
  return `${short(start)} - ${short(periodEnd(start))}`;
}

const fmtHours = (h) => (Math.round(h * 10) === h * 10 ? h.toFixed(1) : h.toFixed(2));

// Where text lands on the blank form, in points from the TOP of the page.
const PAGE_H = 792;
const LAYOUT = {
  name: { x: 160, y: 181.5 },
  location: { x: 413, y: 181.5 },
  phone: { x: 223, y: 204.5 },
  period: { x: 413, y: 204.5 },
  firstRowTop: 229.8,
  rowHeight: 13.93,
  rows: 31,
  baseline: 10.2,
  cols: { date: 76, clockIn: 169, clockOut: 233, hours: 301, comment: 377 },
  commentWidth: 160,
  totalY: 672,
  sig: { x: 204, top: 678, w: 96, h: 32 },
  approvedBy: { x: 500, top: 709.5, w: 76 }, // just after the form's "APPROVED BY:"
};

// Shrinks text until it fits a width, then trims it if it still doesn't.
function fitText(font, value, size, maxWidth, minSize = 5.5) {
  let text = String(value || '');
  while (size > minSize && font.widthOfTextAtSize(text, size) > maxWidth) size -= 0.25;
  while (text.length > 1 && font.widthOfTextAtSize(text, size) > maxWidth) text = text.slice(0, -1);
  return { text, size };
}

let template = null;

// The form's font only has Western letters: anything else (an emoji, say)
// becomes "?" instead of stopping the PDF being made.
function printable(font, value) {
  return [...String(value)].map((ch) => {
    try {
      font.encodeText(ch);
      return ch;
    } catch {
      return '?';
    }
  }).join('');
}

function drawText(page, font, value, x, top, size = 8, maxWidth = null) {
  if (!value) return;
  const text = printable(font, value);
  const fitted = maxWidth ? fitText(font, text, size, maxWidth) : { text, size };
  page.drawText(fitted.text, { x, y: PAGE_H - top, size: fitted.size, font, color: rgb(0, 0, 0) });
}

// "APPROVED BY": the approver's name, and the date underneath.
function drawApproval(page, font, { approver, date }) {
  const { x, top, w } = LAYOUT.approvedBy;
  drawText(page, font, approver, x, top, 8, w);
  drawText(page, font, short(date), x, top + 9.5, 6.5);
}

// Fills in the DMI timesheet. `sheet` = { name, location, phone, start, end,
// worked, note, approval }: `worked` is the rows ({ date, start_at, end_at,
// hours, comment }), `note` goes where the signature would be, and `approval`
// ({ approver, date }) fills in "APPROVED BY". More rows than one page holds
// carry on to another copy of the form.
async function buildTimesheetPdf(sheet) {
  template ??= fs.readFileSync(path.join(config.rootDir, 'assets', 'dmi-timesheet-template.pdf'));
  const doc = await PDFDocument.load(template);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pageCount = Math.max(1, Math.ceil(sheet.worked.length / LAYOUT.rows));
  if (pageCount > 1) {
    const copies = await doc.copyPages(await PDFDocument.load(template), Array(pageCount - 1).fill(0));
    for (const copy of copies) doc.addPage(copy);
  }
  const period = sheet.end ? `${short(sheet.start)} - ${short(sheet.end)}` : periodLabel(sheet.start);
  const c = LAYOUT.cols;

  doc.getPages().forEach((page, n) => {
    const put = (...args) => drawText(page, font, ...args);
    put(sheet.name, LAYOUT.name.x, LAYOUT.name.y, 8, 120);
    put(sheet.location, LAYOUT.location.x, LAYOUT.location.y, 8, 118);
    put(sheet.phone, LAYOUT.phone.x, LAYOUT.phone.y, 8, 120);
    put(period, LAYOUT.period.x, LAYOUT.period.y, 8, 118);

    // Only days actually worked go on the sheet, top to bottom, like the paper version.
    sheet.worked.slice(n * LAYOUT.rows, (n + 1) * LAYOUT.rows).forEach((row, i) => {
      const top = LAYOUT.firstRowTop + i * LAYOUT.rowHeight + LAYOUT.baseline;
      put(short(row.date), c.date, top);
      put(time.fmtTime(row.start_at).replace(':', ''), c.clockIn, top, 8, 55);
      put(time.fmtTime(row.end_at).replace(':', ''), c.clockOut, top, 8, 60);
      put(fmtHours(row.hours), c.hours, top);
      put(row.comment || sheet.location, c.comment, top, 8, LAYOUT.commentWidth);
    });
    // The total goes on the last page; earlier pages say it carries on.
    const last = n === pageCount - 1;
    put(last ? fmtHours(sheet.worked.reduce((sum, r) => sum + r.hours, 0)) : 'cont.', c.hours, LAYOUT.totalY);

    if (sheet.note) put(sheet.note, LAYOUT.sig.x, LAYOUT.sig.top + LAYOUT.sig.h - 6, 7, LAYOUT.sig.w);
    if (sheet.approval) drawApproval(page, font, sheet.approval);
  });
  return Buffer.from(await doc.save());
}

// The approved copy of a timesheet an officer signed (before hours came from
// the schedule): their PDF with "APPROVED BY" filled in.
async function stampApproval(pdf, approval) {
  const doc = await PDFDocument.load(pdf);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  drawApproval(doc.getPages()[0], font, approval);
  return Buffer.from(await doc.save());
}

module.exports = { PERIOD_DAYS, periodStartFor, periodEnd, periodLabel, short, fmtHours, buildTimesheetPdf, stampApproval };
