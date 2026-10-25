// A conversation's messages as a secure PDF for the admins: every message with
// its date and time, locked with a password the admin chooses (it can be
// printed, but not changed or copied; see pdfSecurity.js). Every page shows
// who downloaded it and when, and a verification code worked out from the
// messages themselves, so a copy can be checked against DMI's record.
const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const time = require('../time');
const { saveEncrypted } = require('./pdfSecurity');

const PAGE = [612, 792]; // US Letter
const MARGIN = 54;
const WIDTH = PAGE[0] - 2 * MARGIN;
const GRAY = rgb(0.38, 0.42, 0.48);
const INK = rgb(0.09, 0.11, 0.15);
const OFFICE = rgb(0.11, 0.31, 0.85);

// The standard PDF font can't show every character (e.g. emoji): swap them for "?".
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const pdfSafe = (value) => String(value)
  .replace(/\t/g, '    ')
  .replace(/[\u200d\ufe0e\ufe0f]/g, '') // emoji joiners and style marks
  .replace(/[^\n\x20-\x7e\xa0-\xff]/gu, (ch) => (WIN_ANSI_EXTRA.includes(ch) ? ch : '?'));

function wrap(text, font, size, width) {
  const lines = [];
  for (const paragraph of pdfSafe(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      if (font.widthOfTextAtSize(line + word, size) <= width) {
        line += word;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = word.trimStart();
      // A word longer than the line: break it.
      while (font.widthOfTextAtSize(line, size) > width) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut -= 1;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

// A code from the conversation's messages: any change to them gives a different code.
function verificationCode(thread, messages) {
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify([thread.id, messages.map((m) => [m.id, m.created_at, m.sender_name, m.sender_role, m.body])]))
    .digest('hex').toUpperCase();
  return digest.slice(0, 16).match(/.{4}/g).join('-');
}

const stamp = (at) => `${time.fmtDay(at.slice(0, 10))} ${at.slice(0, 4)}, ${at.slice(11, 16)}`;

// `thread` and `messages` from services/chat.js; `downloadedBy`: the admin's name.
async function chatLogPdf({ thread, messages, companyName, downloadedBy, password, roleName }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const code = verificationCode(thread, messages);
  const downloadedAt = time.nowStr().replace('T', ' ');
  const who = `${thread.name} (${roleName})`;
  doc.setTitle(`Messages with ${pdfSafe(who)}`);
  doc.setAuthor(pdfSafe(companyName));
  doc.setSubject(`Messages between ${pdfSafe(who)} and the office, ${messages.length} in all. Verification code ${code}.`);
  doc.setCreator('DMI');
  doc.setProducer('DMI');

  let page;
  let y;
  const newPage = () => {
    page = doc.addPage(PAGE);
    y = PAGE[1] - MARGIN;
  };
  const line = (text, { f = font, size = 10.5, color = INK, gap = 4 } = {}) => {
    page.drawText(text, { x: MARGIN, y: y - size, size, font: f, color });
    y -= size + gap;
  };

  newPage();
  line(pdfSafe(companyName), { f: bold, size: 16, gap: 6 });
  line(`Messages with ${pdfSafe(who)}`, { f: bold, size: 13, gap: 8 });
  const first = messages[0]?.created_at;
  const last = messages.at(-1)?.created_at;
  for (const fact of [
    messages.length ? `${messages.length} message${messages.length === 1 ? '' : 's'}, ${stamp(first)} to ${stamp(last)} (company time)` : 'No messages',
    `Downloaded by ${pdfSafe(downloadedBy)} on ${stamp(downloadedAt)}`,
    `Verification code ${code}`,
    'Confidential. Messages can\'t be changed or deleted in DMI, and are kept there for 2 years.',
  ]) line(fact, { size: 9.5, color: GRAY, gap: 3 });
  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE[0] - MARGIN, y }, thickness: 0.6, color: GRAY });
  y -= 14;

  for (const m of messages) {
    const fromOffice = m.sender_role === 'admin';
    const heading = `${stamp(m.created_at)}  ·  ${pdfSafe(m.sender_name)}${fromOffice ? ' (office)' : ''}`;
    const bodyLines = wrap(m.body, font, 10.5, WIDTH - 12);
    // Keep the heading with at least the first two lines of the message.
    if (y - 14 - Math.min(bodyLines.length, 2) * 14.5 < MARGIN + 30) newPage();
    line(heading, { f: bold, size: 9.5, color: fromOffice ? OFFICE : INK, gap: 4 });
    for (const text of bodyLines) {
      if (y - 14.5 < MARGIN + 30) newPage();
      page.drawText(text, { x: MARGIN + 12, y: y - 10.5, size: 10.5, font, color: INK });
      y -= 14.5;
    }
    y -= 10;
  }
  if (y - 20 < MARGIN + 30) newPage();
  line('End of the conversation.', { size: 9.5, color: GRAY });

  // Every page: who downloaded it, when, the code, and the page number.
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const footer = `Confidential · ${pdfSafe(companyName)} · Downloaded by ${pdfSafe(downloadedBy)} on ${stamp(downloadedAt)} · Code ${code} · Page ${i + 1} of ${pages.length}`;
    let size = 7.5;
    while (size > 6 && font.widthOfTextAtSize(footer, size) > WIDTH) size -= 0.25;
    p.drawText(footer, { x: MARGIN, y: MARGIN - 24, size, font, color: GRAY });
  });

  return { bytes: await saveEncrypted(doc, { userPassword: password }), code };
}

module.exports = { chatLogPdf, verificationCode, wrap };
