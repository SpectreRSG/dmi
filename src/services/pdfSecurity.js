// Locks a PDF made with pdf-lib, which can't do this itself: AES-256
// encryption with a password to open the file, and permissions that allow
// printing but not changing it or copying its text. This is the standard PDF
// security handler, revision 6 (ISO 32000-2, section 7.6.4), which Adobe
// Acrobat, Apple Preview, Chrome and Edge all open.
//
// How it works: a random file key encrypts every string and stream in the
// file; the open password and a random owner password (never kept) each guard
// a copy of that key. See tests/pdfSecurity.test.js.
const crypto = require('crypto');
const { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFStream, PDFString, PDFBool } = require('pdf-lib');

const MAX_PASSWORD_BYTES = 127;

const aes = (algorithm, key, iv, data, padding) => {
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  cipher.setAutoPadding(padding);
  return Buffer.concat([cipher.update(data), cipher.final()]);
};

// A password as the standard wants it: UTF-8, at most 127 bytes.
function passwordBytes(password) {
  return Buffer.from(String(password).normalize('NFKC'), 'utf8').subarray(0, MAX_PASSWORD_BYTES);
}

// Algorithm 2.B: turns a password (with a salt) into a 32-byte key, slowly on purpose.
function hash2B(password, salt, userKey = Buffer.alloc(0)) {
  let k = crypto.createHash('sha256').update(Buffer.concat([password, salt, userKey])).digest();
  let e = Buffer.from([0]);
  for (let round = 0; round < 64 || e[e.length - 1] > round - 32; round += 1) {
    const block = Buffer.concat([password, k, userKey]);
    e = aes('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32), Buffer.concat(Array(64).fill(block)), false);
    const pick = e.subarray(0, 16).reduce((sum, b) => sum + b, 0) % 3;
    k = crypto.createHash(['sha256', 'sha384', 'sha512'][pick]).update(e).digest();
  }
  return k.subarray(0, 32);
}

// Permission bits (1-based, as numbered in the standard). Bits 7, 8 and 13–32 must be set.
const ALLOW = { print: 1 << 2, modify: 1 << 3, copy: 1 << 4, annotate: 1 << 5, fillForms: 1 << 8, accessibility: 1 << 9, assemble: 1 << 10, printHigh: 1 << 11 };
function permissionFlags(allowed) {
  // Read as a signed 32-bit number, as the file stores it.
  return allowed.reduce((p, name) => p | ALLOW[name], 0xfffff0c0 | 0) | 0;
}

// The /Encrypt dictionary's values for these passwords and file key (Algorithms 8, 9 and 10).
function securityValues({ userPassword, ownerPassword, fileKey, permissions }) {
  const user = passwordBytes(userPassword);
  const owner = passwordBytes(ownerPassword);
  const zeroIv = Buffer.alloc(16);
  const [uValidation, uKeySalt, oValidation, oKeySalt] = [8, 8, 8, 8].map((n) => crypto.randomBytes(n));
  const U = Buffer.concat([hash2B(user, uValidation), uValidation, uKeySalt]);
  const UE = aes('aes-256-cbc', hash2B(user, uKeySalt), zeroIv, fileKey, false);
  const O = Buffer.concat([hash2B(owner, oValidation, U), oValidation, oKeySalt]);
  const OE = aes('aes-256-cbc', hash2B(owner, oKeySalt, U), zeroIv, fileKey, false);
  const perms = Buffer.alloc(16);
  perms.writeInt32LE(permissions, 0);
  perms.writeUInt32LE(0xffffffff, 4);
  perms.write('Tadb', 8, 'latin1'); // T: the metadata is encrypted too
  crypto.randomBytes(4).copy(perms, 12);
  const Perms = aes('aes-256-ecb', fileKey, null, perms, false);
  return { U, UE, O, OE, Perms };
}

// One string or stream: a random 16-byte IV, then AES-256-CBC with padding.
function encryptBytes(fileKey, bytes) {
  const iv = crypto.randomBytes(16);
  return Buffer.concat([iv, aes('aes-256-cbc', fileKey, iv, Buffer.from(bytes), true)]);
}

const hex = (bytes) => PDFHexString.of(Buffer.from(bytes).toString('hex'));

function encryptStrings(object, fileKey) {
  if (object instanceof PDFString || object instanceof PDFHexString) return hex(encryptBytes(fileKey, object.asBytes()));
  if (object instanceof PDFDict) {
    for (const [key, value] of object.entries()) object.set(key, encryptStrings(value, fileKey));
  } else if (object instanceof PDFArray) {
    for (let i = 0; i < object.size(); i += 1) object.set(i, encryptStrings(object.get(i), fileKey));
  }
  return object;
}

// Encrypts a pdf-lib document in place and returns the saved, locked file.
// `allow`: what people may do once it's open (printing, by default, and screen readers).
async function saveEncrypted(doc, { userPassword, ownerPassword = crypto.randomBytes(32).toString('hex'), allow = ['print', 'printHigh', 'accessibility'] }) {
  if (!passwordBytes(userPassword).length) throw new Error('A password is needed to lock the PDF.');
  await doc.flush(); // everything that will be in the file now exists
  const { context } = doc;
  const fileKey = crypto.randomBytes(32);
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFStream) {
      const contents = object.getContents(); // already compressed, if the stream is
      encryptStrings(object.dict, fileKey);
      context.assign(ref, PDFRawStream.of(object.dict, encryptBytes(fileKey, contents)));
    } else {
      encryptStrings(object, fileKey);
    }
  }
  const permissions = permissionFlags(allow);
  const values = securityValues({ userPassword, ownerPassword, fileKey, permissions });
  const filter = context.obj({ Type: 'CryptFilter', CFM: 'AESV3', AuthEvent: 'DocOpen', Length: 32 });
  const encrypt = context.obj({
    Filter: 'Standard', V: 5, R: 6, Length: 256, P: PDFNumber.of(permissions), EncryptMetadata: PDFBool.True,
    CF: context.obj({ StdCF: filter }), StmF: PDFName.of('StdCF'), StrF: PDFName.of('StdCF'),
    O: hex(values.O), U: hex(values.U), OE: hex(values.OE), UE: hex(values.UE), Perms: hex(values.Perms),
  });
  context.trailerInfo.Encrypt = context.register(encrypt);
  const id = crypto.randomBytes(16);
  context.trailerInfo.ID = context.obj([hex(id), hex(id)]);
  // Classic cross-reference table: object streams would need encrypting differently.
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

module.exports = { saveEncrypted, hash2B, permissionFlags, passwordBytes, MAX_PASSWORD_BYTES };
