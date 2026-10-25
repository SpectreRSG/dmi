// The PDF lock (services/pdfSecurity.js), checked the way a PDF reader opens
// it: the password unlocks the file key, the key decrypts the pages. (The
// files were also checked with Poppler and pypdf when this was written.)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const zlib = require('zlib');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { saveEncrypted, hash2B, permissionFlags, passwordBytes } = require('../src/services/pdfSecurity');
const { chatLogPdf, verificationCode, wrap } = require('../src/services/chatPdf');

const field = (text, name) => Buffer.from(text.match(new RegExp(`/${name} <([0-9a-f]+)>`))[1], 'hex');
const decipher = (alg, key, iv, data, padding) => {
  const d = crypto.createDecipheriv(alg, key, iv);
  d.setAutoPadding(padding);
  return Buffer.concat([d.update(data), d.final()]);
};

// Opens a locked file with the password: returns the file key, or null if it's the wrong password.
function open(bytes, password) {
  const text = Buffer.from(bytes).toString('latin1');
  const U = field(text, 'U');
  const pw = passwordBytes(password);
  if (!hash2B(pw, U.subarray(32, 40)).equals(U.subarray(0, 32))) return null;
  return decipher('aes-256-cbc', hash2B(pw, U.subarray(40, 48)), Buffer.alloc(16), field(text, 'UE'), false);
}

// Every stream in the file, decrypted with the file key and uncompressed.
function streams(bytes, key) {
  const buf = Buffer.from(bytes);
  const out = [];
  let at = 0;
  for (;;) {
    const start = buf.indexOf('stream\n', at);
    if (start < 0) break;
    const end = buf.indexOf('\nendstream', start);
    const data = buf.subarray(start + 7, end);
    const plain = decipher('aes-256-cbc', key, data.subarray(0, 16), data.subarray(16), true);
    // Page text is written as hex strings (<48656C6C6F> Tj): turn it back into words.
    const content = zlib.inflateSync(plain).toString('latin1');
    out.push([...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('\n'));
    at = end + 10;
  }
  return out;
}

test('a locked PDF: AES-256, the password opens it, printing allowed but not changes or copying', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('Meet at the north gate', { x: 50, y: 700, size: 12, font });
  doc.setTitle('Secret title');
  const bytes = await saveEncrypted(doc, { userPassword: 'open sesame 42' });
  const text = Buffer.from(bytes).toString('latin1');
  assert.match(text, /\/Filter \/Standard/);
  assert.match(text, /\/V 5/);
  assert.match(text, /\/R 6/);
  assert.match(text, /\/CFM \/AESV3/);
  assert.doesNotMatch(text, /north gate|Secret title/, 'nothing readable without the password');
  assert.equal(open(bytes, 'wrong password'), null);
  const key = open(bytes, 'open sesame 42');
  assert.equal(key.length, 32);
  assert.ok(streams(bytes, key).some((s) => s.includes('Meet at the north gate')), 'the password unlocks the page');
  // Perms: the permissions, sealed with the file key.
  const perms = decipher('aes-256-ecb', key, null, field(text, 'Perms'), false);
  assert.equal(perms.subarray(9, 12).toString('latin1'), 'adb');
  const p = perms.readInt32LE(0);
  assert.equal(p, Number(text.match(/\/P (-?\d+)/)[1]));
  assert.equal(p, permissionFlags(['print', 'printHigh', 'accessibility']));
  assert.ok(p & (1 << 2), 'can print');
  assert.ok(!(p & (1 << 3)) && !(p & (1 << 4)) && !(p & (1 << 5)), 'no changes, copying or notes');
  await assert.rejects(saveEncrypted(await PDFDocument.create(), { userPassword: '' }), /password is needed/);
});

test('the conversation PDF: every message with its time, a verification code, locked', async () => {
  const thread = { id: 7, name: 'Olivia Officer', person_role: 'officer' };
  const messages = [
    { id: 1, created_at: '2026-10-25 06:05:12', sender_name: 'Olivia Officer', sender_role: 'officer', body: 'Running late 🚗\nTraffic on the 101.' },
    { id: 2, created_at: '2026-10-25 06:07:40', sender_name: 'Alex Admin', sender_role: 'admin', body: 'Thanks. '.repeat(120) },
  ];
  const { bytes, code } = await chatLogPdf({ thread, messages, companyName: 'Direct Measures Inc', downloadedBy: 'Alex Admin', password: 'kept safe 123', roleName: 'officer' });
  assert.match(code, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
  assert.equal(code, verificationCode(thread, messages), 'the same messages give the same code');
  assert.notEqual(code, verificationCode(thread, [{ ...messages[0], body: 'Running late' }, messages[1]]), 'any change gives a different code');
  const pages = streams(bytes, open(bytes, 'kept safe 123')).join('\n');
  assert.match(pages, /Messages with Olivia Officer \(officer\)/);
  assert.match(pages, /Sun 25 Oct 2026, 06:05  ·  Olivia Officer/);
  assert.match(pages, /Running late \?\n/, 'an emoji the font can\'t show becomes one ?');
  assert.match(pages, /Alex Admin \(office\)/);
  assert.match(pages, new RegExp(`Code ${code} · Page 1 of 1`));
  assert.ok(wrap('x'.repeat(300), { widthOfTextAtSize: (s) => s.length * 5 }, 10, 100).every((l) => l.length <= 20), 'long words are broken');
});
