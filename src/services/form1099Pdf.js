// Draws Form 1099-NEC as a PDF: the copies the company prints or hands out
// (Copy B and Copy 2 for the officer, Copy C and Copy 1 for the company).
//
// These are "substitute" forms, which the IRS allows for these copies (see IRS
// Publication 1179). Copy A, the one the IRS itself gets, can't be printed
// like this: it's filed online (IRS IRIS) or on the official red-ink form.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const COPIES = {
  B: {
    title: 'Copy B',
    subtitle: 'For Recipient',
    legend: 'This is important tax information and is being furnished to the IRS. If you are required to file a return, a negligence penalty or other sanction may be imposed on you if this income is taxable and the IRS determines that it has not been reported.',
    keep: '(keep for your records)',
    maskTin: true,
  },
  2: {
    title: 'Copy 2',
    subtitle: "To be filed with recipient's state income tax return, when required.",
    legend: '',
    keep: '',
    maskTin: true,
  },
  C: {
    title: 'Copy C',
    subtitle: 'For Payer',
    legend: 'For Privacy Act and Paperwork Reduction Act Notice, see the current General Instructions for Certain Information Returns.',
    keep: '',
    maskTin: false,
  },
  1: {
    title: 'Copy 1',
    subtitle: 'For State Tax Department',
    legend: '',
    keep: '',
    maskTin: false,
  },
};

// The instructions printed on the back of the official Copy B.
const RECIPIENT_INSTRUCTIONS = [
  ['', "You received this form instead of Form W-2 because the payer didn't consider you an employee and didn't withhold income tax or social security and Medicare tax."],
  ['', 'If you believe you are an employee and cannot get the payer to correct this form, report the amount shown in box 1 on the line for "Wages, salaries, tips, etc." of Form 1040, 1040-SR, or 1040-NR. You must also complete Form 8919 and attach it to your return. For more information, see Pub. 1779, Independent Contractor or Employee.'],
  ['', 'If you are not an employee but the amount in box 1 is not self-employment (SE) income (for example, it is income from a sporadic activity or a hobby), report the amount shown in box 1 on the "Other income" line (on Schedule 1 (Form 1040)).'],
  ["Recipient's taxpayer identification number (TIN).", 'For your protection, this form may show only the last four digits of your TIN (social security number (SSN), individual taxpayer identification number (ITIN), adoption taxpayer identification number (ATIN), or employer identification number (EIN)). However, the issuer has reported your complete TIN to the IRS.'],
  ['Account number.', 'May show an account or other unique number the payer assigned to distinguish your account.'],
  ['Box 1.', 'Shows nonemployee compensation. If the amount in this box is SE income, report it on Schedule C or F (Form 1040) if a sole proprietor, or on Form 1065 and Schedule K-1 (Form 1065) if a partnership, and the recipient/partner completes Schedule SE (Form 1040).'],
  ['Note:', 'If you are receiving payments on which no income, social security, and Medicare taxes are withheld, you should make estimated tax payments. See Form 1040-ES (or Form 1040-ES (NR)). Individuals must report these amounts as explained in these box 1 instructions. Corporations, fiduciaries, and partnerships must report these amounts on the appropriate line of their tax returns.'],
  ['Box 2.', 'If checked, consumer products totaling $5,000 or more were sold to you for resale, on a buy-sell, a deposit-commission, or other basis. Generally, report any income from your sale of these products on Schedule C (Form 1040).'],
  ['Box 3.', 'Shows your total compensation of excess golden parachute payments subject to a 20% excise tax. See your tax return instructions for where to report.'],
  ['Box 4.', 'Shows backup withholding. A payer must backup withhold on certain payments if you did not give your TIN to the payer. See Form W-9, Request for Taxpayer Identification Number and Certification, for information on backup withholding. Include this amount on your income tax return as tax withheld.'],
  ['Boxes 5-7.', 'State income tax withheld reporting boxes.'],
  ['Future developments.', 'For the latest information about developments related to Form 1099-NEC and its instructions, such as legislation enacted after they were published, go to www.irs.gov/Form1099NEC.'],
  ['Free File Program.', 'Go to www.irs.gov/FreeFile to see if you qualify for no-cost online federal tax preparation, e-filing, and direct deposit or payment options.'],
];

const money = (n) => (Number(n) ? Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');

// Splits text into lines that fit a width (the first line can be shorter, to
// leave room for a bold heading in front of it).
function wrap(text, font, size, width, firstWidth = width) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > (lines.length ? width : firstWidth)) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// `form` = { tax_year, box1, box4, box5, box6, box7, corrected, payer, recipient, recipientTin, payerTin }.
// `copies` = which copies to include, e.g. ['B', '2'].
async function buildForm1099Pdf(form, copies) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Form 1099-NEC ${form.tax_year} – ${form.recipient.name}`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const H = 792;

  for (const copyName of copies) {
    const copy = COPIES[copyName];
    const page = doc.addPage([612, H]);
    // Everything below is measured from the TOP of the page, in points (72 per inch).
    const text = (value, x, top, { size = 9, f = font, maxWidth = null } = {}) => {
      let s = String(value ?? '');
      if (!s) return;
      if (maxWidth) while (s.length > 1 && f.widthOfTextAtSize(s, size) > maxWidth) s = s.slice(0, -1);
      page.drawText(s, { x, y: H - top, size, font: f, color: black });
    };
    const para = (value, x, top, width, { size = 6.5, f = font, gap = 1.25 } = {}) => {
      let y = top;
      for (const line of wrap(value, f, size, width)) {
        text(line, x, y, { size, f });
        y += size * gap;
      }
      return y;
    };
    const box = (x, top, w, h) => page.drawRectangle({ x, y: H - top - h, width: w, height: h, borderColor: black, borderWidth: 0.75 });
    const label = (value, x, top, width, f = font) => para(value, x + 3, top + 7, width - 6, { size: 6, f });

    const recipientTin = copy.maskTin ? form.maskedRecipientTin : form.recipientTin;

    // "CORRECTED (if checked)"
    box(306, 40, 7, 7);
    if (form.corrected) text('X', 307.2, 46, { size: 7, f: bold });
    text('CORRECTED (if checked)', 317, 46.5, { size: 7 });

    // Left column: payer and recipient.
    box(36, 60, 270, 90);
    label("PAYER'S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone no.", 36, 60, 270);
    const p = form.payer;
    [p.name, p.address, `${p.city}, ${p.state} ${p.zip}`, p.phone].forEach((line, i) => text(line, 42, 92 + i * 12, { size: 9.5, maxWidth: 258 }));

    box(36, 150, 135, 26);
    label("PAYER'S TIN", 36, 150, 135);
    text(p.tin, 42, 170, { size: 9.5 });
    box(171, 150, 135, 26);
    label("RECIPIENT'S TIN", 171, 150, 135);
    text(recipientTin, 177, 170, { size: 9.5 });

    const r = form.recipient;
    box(36, 176, 270, 32);
    label("RECIPIENT'S name", 36, 176, 270);
    text(r.name, 42, 193, { size: 9.5, maxWidth: 258 });
    if (r.business_name) text(r.business_name, 42, 204, { size: 8, maxWidth: 258 });
    box(36, 208, 270, 24);
    label('Street address (including apt. no.)', 36, 208, 270);
    text(r.address, 42, 227, { size: 9.5, maxWidth: 258 });
    box(36, 232, 270, 24);
    label('City or town, state or province, country, and ZIP or foreign postal code', 36, 232, 270);
    text(`${r.city}, ${r.state} ${r.zip}`, 42, 251, { size: 9.5, maxWidth: 258 });
    box(36, 256, 270, 24);
    label('Account number (see instructions)', 36, 256, 270);
    text(r.account, 42, 275, { size: 9 });

    // Middle column: form name and money boxes.
    box(306, 60, 144, 54);
    text('OMB No. 1545-0116', 312, 72, { size: 7 });
    text('Form 1099-NEC', 312, 90, { size: 12, f: bold });
    text(`For calendar year ${form.tax_year}`, 312, 106, { size: 8 });

    box(306, 114, 144, 34);
    label('1 Nonemployee compensation', 306, 114, 144);
    text(`$ ${money(form.box1)}`, 312, 141, { size: 10, f: bold });
    box(306, 148, 144, 40);
    label('2 Payer made direct sales totaling $5,000 or more of consumer products to recipient for resale', 306, 148, 120);
    box(434, 172, 8, 8);
    box(306, 188, 144, 30);
    label('3 Excess golden parachute payments', 306, 188, 144);
    text(`$ ${money(0)}`, 312, 211, { size: 10 });
    box(306, 218, 144, 62);
    label('4 Federal income tax withheld', 306, 218, 144, bold);
    text(`$ ${money(form.box4)}`, 312, 243, { size: 10 });

    // Right column: the form's name and which copy this is.
    box(450, 60, 126, 54);
    text('Nonemployee', 456, 82, { size: 11, f: bold });
    text('Compensation', 456, 96, { size: 11, f: bold });
    box(450, 114, 126, 166);
    text(copy.title, 456, 130, { size: 11, f: bold });
    let y = para(copy.subtitle, 456, 144, 114, { size: 8, f: bold });
    if (copy.legend) para(copy.legend, 456, y + 6, 114, { size: 6.5 });

    // Bottom row: state boxes.
    box(36, 280, 180, 34);
    label('5 State tax withheld', 36, 280, 180);
    text(`$ ${money(form.box5)}`, 42, 307, { size: 10 });
    box(216, 280, 180, 34);
    label("6 State/Payer's state no.", 216, 280, 180);
    text(form.box6 || '', 222, 307, { size: 9.5, maxWidth: 168 });
    box(396, 280, 180, 34);
    label('7 State income', 396, 280, 180);
    text(`$ ${money(form.box7)}`, 402, 307, { size: 10 });

    text('Form 1099-NEC', 36, 326, { size: 8, f: bold });
    text(copy.keep, 100, 326, { size: 7 });
    text('www.irs.gov/Form1099NEC', 250, 326, { size: 7 });
    text('Department of the Treasury - Internal Revenue Service', 372, 326, { size: 7 });

    // Copy B: the recipient instructions go on the same page, under the form.
    if (copyName === 'B') {
      text('Instructions for Recipient', 36, 360, { size: 10, f: bold });
      let top = 376;
      for (const [heading, body] of RECIPIENT_INSTRUCTIONS) {
        const lead = heading ? `${heading} ` : '';
        const leadWidth = bold.widthOfTextAtSize(lead, 7.5);
        text(lead, 36, top, { size: 7.5, f: bold });
        wrap(body, font, 7.5, 540, 540 - leadWidth).forEach((line, i) => {
          text(line, i === 0 ? 36 + leadWidth : 36, top, { size: 7.5 });
          top += 9.5;
        });
        top += 3;
      }
    }
  }
  return Buffer.from(await doc.save());
}

module.exports = { buildForm1099Pdf, COPIES };
