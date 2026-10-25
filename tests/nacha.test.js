// The direct deposit (NACHA/ACH) file: routing number checks and the record layout.
const test = require('node:test');
const assert = require('node:assert/strict');
const { routingOk, buildNachaFile } = require('../src/services/nacha');

test('routing numbers: 9 digits with a valid check digit', () => {
  assert.ok(routingOk('021000021'));
  assert.ok(routingOk('011000015'));
  assert.ok(!routingOk('123456789'));
  assert.ok(!routingOk('02100002'));
  assert.ok(!routingOk('02100002a'));
});

test('the file: 94-character records in blocks of 10, with matching totals', () => {
  const file = buildNachaFile({
    bank: { routing: '011000015', name: 'First Demo Bank', companyId: '1123456789', immediateOrigin: '1123456789', companyName: 'Direct Measures' },
    entries: [
      { name: 'Wendy Wágès', id: 'DMI-7', routing: '021000021', account: '000123456789', type: 'checking', cents: 102345 },
      { name: 'Wes Worker', id: 'DMI-9', routing: '011000015', account: '55501', type: 'savings', cents: 5000 },
    ],
    effectiveDate: '2026-10-30',
    now: '2026-10-28T14:05',
  });
  const lines = file.trimEnd().split('\r\n');
  assert.equal(lines.length, 10, '6 records, padded to a block of 10');
  for (const line of lines) assert.equal(line.length, 94);
  assert.equal(lines[0].slice(0, 3), '101');
  assert.equal(lines[0].slice(3, 13), ' 011000015');
  assert.equal(lines[0].slice(23, 33), '2610281405');
  assert.equal(lines[1].slice(0, 4), '5220');
  assert.equal(lines[1].slice(50, 53), 'PPD');
  assert.equal(lines[1].slice(69, 75), '261030', 'effective entry date');
  assert.equal(lines[2].slice(0, 3), '622', 'checking credit');
  assert.equal(lines[2].slice(3, 12), '021000021');
  assert.equal(lines[2].slice(12, 29), '000123456789     ');
  assert.equal(lines[2].slice(29, 39), '0000102345');
  assert.equal(lines[2].slice(54, 76), 'WENDY WAGES           ', 'plain uppercase letters');
  assert.equal(lines[3].slice(0, 3), '632', 'savings credit');
  // Batch and file control: 2 entries, hash of the 8-digit bank numbers, $1,073.45 in credits.
  const hash = String(2100002 + 1100001).padStart(10, '0');
  assert.equal(lines[4].slice(0, 20), `8220000002${hash}`);
  assert.equal(lines[4].slice(32, 44), '000000107345');
  assert.equal(lines[5].slice(0, 31), `9000001000001${'00000002'}${hash}`, '1 batch, 1 block, 2 entries');
  assert.equal(lines[5].slice(43, 55), '000000107345');
  assert.equal(lines[9], '9'.repeat(94));
});
