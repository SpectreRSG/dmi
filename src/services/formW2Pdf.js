// Draws Form W-2 (Wage and Tax Statement) as a PDF with pdf-lib: Copies B, C
// and 2 for the employee, Copy D for the company. Laid out like the IRS form.
// Copy A, the one for the Social Security Administration, is filed online
// (Business Services Online), so it isn't drawn here.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const COPIES = {
  B: { title: 'Copy B', text: "To Be Filed With Employee's FEDERAL Tax Return.", legend: 'This information is being furnished to the Internal Revenue Service.', employee: true },
  C: { title: 'Copy C', text: "For EMPLOYEE'S RECORDS.", legend: 'This information is being furnished to the Internal Revenue Service. If you are required to file a tax return, a negligence penalty or other sanction may be imposed on you if this income is taxable and you fail to report it.', employee: true },
  2: { title: 'Copy 2', text: "To Be Filed With Employee's State, City, or Local Income Tax Return.", legend: '', employee: true },
  D: { title: 'Copy D', text: 'For Employer.', legend: '', employee: false },
};

const money = (n) => (Number(n) ? Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');

function wrap(text, font, size, width) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// `form` = { tax_year, boxes, employer, employee, ssn (full, for Copy D), maskedSsn (employee copies) }.
async function buildFormW2Pdf(form, copies) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Form W-2 ${form.tax_year} – ${form.employee.name}`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const H = 792;
  const b = form.boxes;
  const e = form.employer;
  const p = form.employee;

  for (const copyName of copies) {
    const copy = COPIES[copyName];
    const page = doc.addPage([612, H]);
    // Everything is measured from the TOP of the page, in points (72 per inch).
    const text = (value, x, top, { size = 9, f = font, maxWidth = null } = {}) => {
      let s = String(value ?? '');
      if (!s) return;
      if (maxWidth) while (s.length > 1 && f.widthOfTextAtSize(s, size) > maxWidth) s = s.slice(0, -1);
      page.drawText(s, { x, y: H - top, size, font: f, color: black });
    };
    const box = (x, top, w, h) => page.drawRectangle({ x, y: H - top - h, width: w, height: h, borderColor: black, borderWidth: 0.75 });
    const label = (value, x, top, width, f = font) => {
      wrap(value, f, 6, width - 6).forEach((line, i) => text(line, x + 3, top + 7 + i * 7, { size: 6, f }));
    };
    // A labelled box with an amount in it.
    const amountBox = (name, value, x, top, w, h = 24) => {
      box(x, top, w, h);
      label(name, x, top, w);
      text(money(value), x + 6, top + h - 5, { size: 9.5 });
    };

    // Top row: the employee's SSN.
    box(36, 40, 270, 24);
    label("a  Employee's social security number", 36, 40, 270);
    text(copy.employee ? form.maskedSsn : form.ssn, 42, 60, { size: 10 });
    text('OMB No. 1545-0029', 316, 52, { size: 7 });

    // Left column: employer and employee.
    box(36, 64, 270, 24);
    label('b  Employer identification number (EIN)', 36, 64, 270);
    text(e.ein, 42, 84, { size: 9.5 });
    box(36, 88, 270, 66);
    label("c  Employer's name, address, and ZIP code", 36, 88, 270);
    [e.name, e.address, `${e.city}, ${e.state} ${e.zip}`].forEach((line, i) => text(line, 42, 108 + i * 12, { size: 9.5, maxWidth: 258 }));
    box(36, 154, 270, 24);
    label('d  Control number', 36, 154, 270);
    text(p.number, 42, 174, { size: 9 });
    box(36, 178, 270, 40);
    label("e  Employee's first name and initial      Last name      Suff.", 36, 178, 270);
    text(p.name, 42, 202, { size: 9.5, maxWidth: 258 });
    box(36, 218, 270, 62);
    label("f  Employee's address and ZIP code", 36, 218, 270);
    [p.address, `${p.city}, ${p.state} ${p.zip}`].forEach((line, i) => text(line, 42, 238 + i * 12, { size: 9.5, maxWidth: 258 }));

    // Right side: the money boxes, two columns.
    const L = 306;
    const R = 441;
    const W = 135;
    amountBox('1  Wages, tips, other compensation', b.box1, L, 64, W);
    amountBox('2  Federal income tax withheld', b.box2, R, 64, W);
    amountBox('3  Social security wages', b.box3, L, 88, W);
    amountBox('4  Social security tax withheld', b.box4, R, 88, W);
    amountBox('5  Medicare wages and tips', b.box5, L, 112, W);
    amountBox('6  Medicare tax withheld', b.box6, R, 112, W);
    amountBox('7  Social security tips', 0, L, 136, W);
    amountBox('8  Allocated tips', 0, R, 136, W);
    box(L, 160, W, 24);
    label('9', L, 160, W);
    amountBox('10  Dependent care benefits', 0, R, 160, W);
    amountBox('11  Nonqualified plans', 0, L, 184, W);
    for (const [i, letter] of ['a', 'b', 'c', 'd'].entries()) {
      box(R, 184 + i * 24, W, 24);
      label(letter === 'a' ? '12a  See instructions for box 12' : `12${letter}`, R, 184 + i * 24, W);
    }
    box(L, 208, W, 24);
    label('13  Statutory employee   Retirement plan   Third-party sick pay', L, 208, W);
    box(L, 232, W, 48);
    label('14  Other', L, 232, W);
    (b.box14 || []).forEach((line, i) => text(`${line.label}  ${money(line.amount)}`, L + 6, 252 + i * 11, { size: 9 }));

    // Bottom row: state and local.
    box(36, 280, 180, 34);
    label("15  State   Employer's state ID number", 36, 280, 180);
    text(`${b.box15}   ${b.box15_id}`, 42, 307, { size: 9.5, maxWidth: 168 });
    amountBox('16  State wages, tips, etc.', b.box16, 216, 280, 90, 34);
    amountBox('17  State income tax', b.box17, 306, 280, 90, 34);
    amountBox('18  Local wages, tips, etc.', 0, 396, 280, 72, 34);
    amountBox('19  Local income tax', 0, 468, 280, 72, 34);
    box(540, 280, 36, 34);
    label('20  Locality name', 540, 280, 36);

    // Footer: the form's name and which copy this is.
    text('Form W-2', 36, 332, { size: 12, f: bold });
    text('Wage and Tax Statement', 100, 332, { size: 10, f: bold });
    text(String(form.tax_year), 260, 334, { size: 18, f: bold });
    text('Department of the Treasury - Internal Revenue Service', 360, 330, { size: 7 });
    text(`${copy.title} - ${copy.text}`, 36, 350, { size: 8, f: bold });
    wrap(copy.legend, font, 7, 540).forEach((line, i) => text(line, 36, 362 + i * 9, { size: 7 }));
  }
  return Buffer.from(await doc.save());
}

module.exports = { buildFormW2Pdf, COPIES };
