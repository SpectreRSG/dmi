// Officer timesheets: the two-week pay periods and the filled-in DMI timesheet
// PDF. This is the same form and layout as the old stand-alone timesheet page
// (public/timesheet/), but the PDF is now made here, from what was saved.
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

// "1000", "10:00", "930" -> '10:00', '09:30'; anything else -> null.
function parseClock(text) {
  const m = String(text || '').trim().replace(':', '').match(/^(\d{1,2})(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

// Reads the 14 rows of the timesheet form. Returns { rows, worked, error }.
// Each worked day becomes { date, start_at, end_at, hours, comment }.
function readRows(body, start) {
  const rows = [];
  const problems = [];
  for (let i = 0; i < PERIOD_DAYS; i += 1) {
    const date = time.addDays(start, i);
    const row = {
      date,
      clock_in: String(body[`in_${i}`] || '').trim().slice(0, 5),
      clock_out: String(body[`out_${i}`] || '').trim().slice(0, 5),
      comment: String(body[`comment_${i}`] || '').trim().slice(0, 120),
    };
    const startTime = parseClock(row.clock_in);
    const endTime = parseClock(row.clock_out);
    if (row.clock_in || row.clock_out) {
      if (!startTime || !endTime) {
        problems.push(short(date));
      } else {
        // If Clock out is earlier than Clock in, the shift finished the next day.
        Object.assign(row, time.buildRange(date, startTime, endTime));
        row.hours = Math.round(time.hoursBetween(row.start_at, row.end_at) * 100) / 100;
      }
    }
    rows.push(row);
  }
  const worked = rows.filter((r) => r.start_at);
  let error = null;
  if (problems.length) {
    error = `Check the clock times on ${problems.join(', ')}: each day needs both a Clock in and a Clock out, like 1000 and 1630.`;
  } else if (!worked.length) {
    error = 'Add a Clock in and Clock out to at least one day first.';
  }
  return { rows, worked, error };
}

// A drawn signature arrives as a PNG picture written as text (a "data URL").
function readSignature(value) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(value || ''));
  if (!match) return null;
  const png = Buffer.from(match[1], 'base64');
  const isPng = png.length > 8 && png.length < 300 * 1024 && png.subarray(1, 4).toString() === 'PNG';
  return isPng ? png : null;
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

// Fills in the DMI timesheet. `sheet` = { name, location, phone, start, worked, signature }.
async function buildTimesheetPdf(sheet) {
  template ??= fs.readFileSync(path.join(config.rootDir, 'assets', 'dmi-timesheet-template.pdf'));
  const doc = await PDFDocument.load(template);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.getPages()[0];

  function put(value, x, top, size = 8, maxWidth = null) {
    if (!value) return;
    const fitted = maxWidth ? fitText(font, value, size, maxWidth) : { text: String(value), size };
    page.drawText(fitted.text, { x, y: PAGE_H - top, size: fitted.size, font, color: rgb(0, 0, 0) });
  }

  put(sheet.name, LAYOUT.name.x, LAYOUT.name.y, 8, 120);
  put(sheet.location, LAYOUT.location.x, LAYOUT.location.y, 8, 118);
  put(sheet.phone, LAYOUT.phone.x, LAYOUT.phone.y, 8, 120);
  put(periodLabel(sheet.start), LAYOUT.period.x, LAYOUT.period.y, 8, 118);

  // Only days actually worked go on the sheet, top to bottom, like the paper version.
  const c = LAYOUT.cols;
  sheet.worked.slice(0, LAYOUT.rows).forEach((row, i) => {
    const top = LAYOUT.firstRowTop + i * LAYOUT.rowHeight + LAYOUT.baseline;
    put(short(row.date), c.date, top);
    put(time.fmtTime(row.start_at).replace(':', ''), c.clockIn, top, 8, 55);
    put(time.fmtTime(row.end_at).replace(':', ''), c.clockOut, top, 8, 60);
    put(fmtHours(row.hours), c.hours, top);
    put(row.comment || sheet.location, c.comment, top, 8, LAYOUT.commentWidth);
  });
  put(fmtHours(sheet.worked.reduce((sum, r) => sum + r.hours, 0)), c.hours, LAYOUT.totalY);

  if (sheet.signature) {
    const png = await doc.embedPng(sheet.signature);
    const s = LAYOUT.sig;
    const scale = Math.min(s.w / png.width, s.h / png.height);
    page.drawImage(png, { x: s.x, y: PAGE_H - (s.top + s.h), width: png.width * scale, height: png.height * scale });
  }
  return Buffer.from(await doc.save());
}

// The approved copy: the officer's signed PDF with "APPROVED BY" filled in
// (the approver's name, and the date underneath).
async function stampApproval(pdf, { approver, date }) {
  const doc = await PDFDocument.load(pdf);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.getPages()[0];
  const { x, top, w } = LAYOUT.approvedBy;
  const name = fitText(font, approver, 8, w);
  page.drawText(name.text, { x, y: PAGE_H - top, size: name.size, font, color: rgb(0, 0, 0) });
  page.drawText(short(date), { x, y: PAGE_H - top - 9.5, size: 6.5, font, color: rgb(0, 0, 0) });
  return Buffer.from(await doc.save());
}

module.exports = {
  PERIOD_DAYS, periodStartFor, periodEnd, periodLabel, short, parseClock, readRows, readSignature, fmtHours, buildTimesheetPdf, stampApproval,
};
