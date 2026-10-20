// End-to-end tests: start the real app with an empty, temporary database and
// use it the way a browser would. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startLocalDatabase } = require('../scripts/local-db');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dmi-test-'));
process.env.SETUP_CODE = 'test-setup-code';
const time = require('../src/time');
const totp = require('../src/services/totp');

let app;
let db;
let localDb;
let server;
let base;

// A tiny "browser": remembers cookies and reads the form security token.
function makeClient() {
  const cookies = new Map();
  async function request(method, url, body) {
    const headers = { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = (body instanceof URLSearchParams ? body : new URLSearchParams(body)).toString();
    }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const [name, value] = pair.split('=');
      cookies.set(name, value);
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text(), headers: res.headers };
  }
  return {
    get: (url) => request('GET', url),
    raw: request,
    // The session's id, from the (signed) login cookie.
    sessionId: () => decodeURIComponent(cookies.get('dmi.sid') || '').replace(/^s:/, '').replace(/\.[^.]*$/, ''),
    async token(url = '/login') {
      const page = await request('GET', url);
      return page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    },
    async post(url, form = {}, tokenPage) {
      const _csrf = await this.token(tokenPage || '/account');
      return request('POST', url, { _csrf, ...form });
    },
    // For forms that send the same field more than once (like ticked checkboxes).
    async postList(url, pairs, tokenPage) {
      const params = new URLSearchParams([['_csrf', await this.token(tokenPage || '/account')], ...pairs]);
      return request('POST', url, params);
    },
    async postFile(url, form, file, tokenPage) {
      const data = new FormData();
      data.append('_csrf', await this.token(tokenPage));
      for (const [k, v] of Object.entries(form)) data.append(k, v);
      if (file) data.append('file', new Blob([file.content]), file.name);
      return request('POST', url, data);
    },
  };
}

// Two-step sign-in, done the way a person with an authenticator app would:
// set it up by reading the key off the page, then type the current code.
async function setUpTwoStep(client) {
  const page = await client.get('/account/two-step');
  const secret = page.text.match(/data-secret="([A-Z2-7]+)"/)[1];
  return client.post('/account/two-step', { code: totp.codeAt(secret, totp.currentStep()) }, '/account/two-step');
}

// A code that hasn't been used yet (a code only works once).
async function codeFor(email) {
  const { decrypt } = require('../src/secureData');
  const user = await db.get('SELECT totp_secret, totp_last_step FROM users WHERE lower(email) = lower(?)', email);
  return totp.codeAt(await decrypt(user.totp_secret), Math.max(totp.currentStep(), Number(user.totp_last_step ?? -1) + 1));
}

// Signs in with the password, then the code (setting two-step up the first time).
async function signIn(client, email, password) {
  const res = await client.post('/login', { email, password }, '/login');
  if (res.location === '/login/verify') return client.post('/login/verify', { code: await codeFor(email) }, '/login/verify');
  const user = await db.get('SELECT role, totp_enabled_at, two_step_exempt FROM users WHERE lower(email) = lower(?)', email);
  if (res.status === 302 && user && !user.totp_enabled_at && user.role !== 'pending' && !user.two_step_exempt) await setUpTwoStep(client);
  return res;
}

// A pretend phone with Face ID, for the passkey tests. Like a real device, it
// makes a key pair for each passkey, keeps the secret half, and signs the
// site's challenge (W3C Web Authentication). `counts`: whether it counts its
// uses (security keys do; iPhones always say 0).
function makeAuthenticator({ rpId = 'localhost', counts = false, type = 'ec' } = {}) {
  const crypto = require('crypto');
  const b64 = (buf) => Buffer.from(buf).toString('base64url');
  const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
  const uint = (n, size) => {
    const buf = Buffer.alloc(size);
    buf.writeUIntBE(n, 0, size);
    return buf;
  };
  const keys = new Map(); // passkey id -> { privateKey, userHandle, count }
  // The device's report: the site (as a hash), flags (1 = touched, 4 = Face ID or PIN, 64 = new passkey), the count.
  const authData = ({ uv = true, count = 0, attested = null, site = rpId }) => Buffer.concat([
    sha256(site), Buffer.from([0x01 | (uv ? 0x04 : 0) | (attested ? 0x40 : 0)]), uint(count, 4), attested || Buffer.alloc(0),
  ]);
  const clientData = (kind, challenge, origin) => Buffer.from(JSON.stringify({ type: kind, challenge, origin: origin || base, crossOrigin: false }));
  return {
    keys,
    // What navigator.credentials.create() gives the page (as the page sends it).
    create(options, { uv = true, origin, site, claim } = {}) {
      const { privateKey, publicKey } = type === 'ed25519' ? crypto.generateKeyPairSync('ed25519') : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const id = crypto.randomBytes(16);
      const start = counts ? 5 : 0;
      // aaguid (16 zero bytes), the id's length, the id, then the key in the device's own format (an empty map here: the site uses the browser's copy).
      const attested = Buffer.concat([Buffer.alloc(16), uint(id.length, 2), id, Buffer.from([0xa0])]);
      keys.set(b64(id), { privateKey, userHandle: options.user.id, count: start });
      return {
        id: b64(id),
        clientDataJSON: b64(clientData('webauthn.create', options.challenge, origin)),
        authenticatorData: b64(authData({ uv, count: start, attested, site })),
        publicKey: b64(publicKey.export({ type: 'spki', format: 'der' })),
        publicKeyAlgorithm: String(claim ?? (type === 'ed25519' ? -8 : -7)),
        transports: 'internal',
      };
    },
    // What navigator.credentials.get() gives the page.
    get(options, { id, uv = true, origin, site, count, tamper = false } = {}) {
      const keyId = id || [...keys.keys()][0];
      const key = keys.get(keyId);
      if (counts) key.count += 1;
      const data = authData({ uv, count: count ?? key.count, site });
      const json = clientData('webauthn.get', options.challenge, origin);
      const signed = Buffer.concat([data, sha256(tamper ? Buffer.from('something else') : json)]);
      const signature = crypto.sign(type === 'ed25519' ? null : 'sha256', signed, key.privateKey);
      return { id: keyId, clientDataJSON: b64(json), authenticatorData: b64(data), signature: b64(signature), userHandle: key.userHandle };
    },
  };
}

const admin = makeClient();
const lastMonday = time.addDays(time.startOfWeek(time.todayStr()), -7);
const ids = {};

test.before(async () => {
  localDb = await startLocalDatabase(); // in memory, thrown away afterwards
  process.env.DATABASE_URL = localDb.url;
  app = require('../src/app');
  db = require('../src/db');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await db.close();
  await localDb.stop();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('SQL values are swapped in safely, even next to quoted text', () => {
  const { toPostgres } = require('../src/db');
  assert.deepEqual(toPostgres("SELECT * FROM t WHERE a = ? AND b = '?' AND c = ?", [1, 2]), {
    text: "SELECT * FROM t WHERE a = $1 AND b = '?' AND c = $2",
    values: [1, 2],
  });
  assert.deepEqual(toPostgres("UPDATE t SET a = @a, e = 'x@y.z' WHERE id = @id OR parent = @id", [{ a: 'A', id: 7 }]), {
    text: "UPDATE t SET a = $1, e = 'x@y.z' WHERE id = $2 OR parent = $2",
    values: ['A', 7],
  });
  assert.throws(() => toPostgres('SELECT ?', []), /expects 1 values/);
});

test('a brand-new site sends you to the setup page', async () => {
  const res = await admin.get('/');
  assert.equal(res.status, 302);
  assert.equal(res.location, '/setup');
});

test('test officer and demo client accounts come with the database, but setup still needs an admin first', async () => {
  const account = await db.get("SELECT * FROM users WHERE email = 'test.officer@example.com'");
  assert.equal(account.role, 'officer');
  const employee = await db.get('SELECT * FROM employees WHERE id = ?', account.employee_id);
  assert.equal(`${employee.first_name} ${employee.last_name}`, 'Test Officer');
  assert.match(account.password_hash, /^scrypt\$/);
  // The demo client: a client sign-in for a pretend client with two pretend sites, and no shifts.
  const demo = await db.get("SELECT * FROM users WHERE email = 'demo.client@example.com'");
  assert.equal(demo.role, 'client');
  assert.match(demo.password_hash, /^scrypt\$/);
  assert.equal((await db.get('SELECT name FROM clients WHERE id = ?', demo.client_id)).name, 'Demo Client');
  const demoSites = await db.all('SELECT * FROM sites WHERE client_id = ? AND active = 1 ORDER BY name', demo.client_id);
  assert.deepEqual(demoSites.map((s) => s.name), ['Demo Site: Front Gate', 'Demo Site: Warehouse']);
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM shifts WHERE site_id = ANY(?::int[])', demoSites.map((s) => s.id))).n, 0);
  assert.equal((await makeClient().get('/login')).location, '/setup', 'nobody can sign in until the first admin exists');
});

test('setup needs the setup code, then creates the first admin and signs them in', async () => {
  const blocked = await fetch(`${base}/setup`, { method: 'POST' }); // no cookie, no token
  assert.equal(blocked.status, 403);

  const form = {
    company_name: 'Test Security',
    name: 'Alex Admin',
    email: 'alex@example.com',
    password: 'correct horse battery',
    confirm: 'correct horse battery',
  };
  const wrongCode = await admin.post('/setup', { ...form, setup_code: 'guess' }, '/setup');
  assert.equal(wrongCode.status, 400);
  assert.match(wrongCode.text, /setup code is not right/);
  assert.equal((await db.get("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'")).n, 0);

  const setup = await admin.post('/setup', { ...form, setup_code: 'test-setup-code' }, '/setup');
  assert.equal(setup.status, 302);
  assert.equal(setup.location, '/');

  // Before anything else, two-step sign-in: scan the code, type the 6 digits, keep the backup codes.
  assert.equal((await admin.get('/')).location, '/account/two-step');
  const page = await admin.get('/account/two-step');
  assert.match(page.text, /<svg[^>]*viewBox/, 'a QR code to scan');
  const badCode = await admin.post('/account/two-step', { code: '000000' }, '/account/two-step');
  assert.equal(badCode.status, 400);
  const turnedOn = await setUpTwoStep(admin);
  assert.equal(turnedOn.status, 200);
  assert.equal((turnedOn.text.match(/<li><code>[a-z0-9]{4}-[a-z0-9]{4}<\/code><\/li>/g) || []).length, 10, 'ten backup codes');
  const account = await db.get("SELECT totp_secret, totp_enabled_at FROM users WHERE email = 'alex@example.com'");
  assert.ok(account.totp_enabled_at);
  assert.doesNotMatch(account.totp_secret, /^[A-Z2-7]{32}$/, 'the key is stored encrypted');
  const home = await admin.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Test Security/);
});

test('forms without the security token are rejected, even when signed in', async () => {
  const res = await admin.raw('POST', '/staff', { first_name: 'X', last_name: 'Y' });
  assert.equal(res.status, 403);
  assert.equal((await db.get("SELECT COUNT(*)::int AS n FROM employees WHERE first_name = 'X'")).n, 0);
});

test('add a client, a site and a staff member', async () => {
  let res = await admin.post('/clients', { name: 'Harbour Mall' });
  ids.client = Number(res.location.split('/').pop());
  res = await admin.post(`/clients/${ids.client}/sites`, { name: 'Main entrance' });
  assert.equal(res.status, 302);
  ids.site = (await db.get('SELECT id FROM sites WHERE client_id = ?', ids.client)).id;
  res = await admin.post('/staff', { first_name: 'Sam', last_name: 'Guard', hourly_rate: '30', license_required: '1', status: 'active' });
  assert.equal(res.status, 302);
  ids.employee = Number(res.location.split('/').pop());
  assert.equal((await db.get('SELECT hourly_rate FROM employees WHERE id = ?', ids.employee)).hourly_rate, 30);
});

test('shifts: double-booking is blocked, and finished shifts become approved hours by themselves', async () => {
  const { recordFinishedShifts } = require('../src/services/hoursFromSchedule');
  // Hours are recorded from the start of the pay period this was switched on in.
  const since = (await db.get("SELECT value FROM settings WHERE key = 'hours_from_schedule_since'")).value;
  assert.ok(time.isValidDate(since) && time.dayOfWeek(since) === 6, 'a Sunday, when a pay period starts');

  // Nothing from before then turns into hours.
  await db.run("UPDATE settings SET value = ? WHERE key = 'hours_from_schedule_since'", time.todayStr());
  const shift = { site_id: ids.site, employee_id: ids.employee, date: lastMonday, start_time: '08:00', end_time: '18:30', break_minutes: '30' };
  let res = await admin.post('/schedule', shift);
  assert.equal(res.status, 302);
  ids.shift = (await db.get('SELECT id FROM shifts ORDER BY id DESC')).id;
  await recordFinishedShifts();
  assert.ok(!(await db.get('SELECT 1 FROM time_entries WHERE shift_id = ?', ids.shift)), 'older than the switch-on date');
  await db.run("UPDATE settings SET value = '2000-01-01' WHERE key = 'hours_from_schedule_since'"); // these tests use earlier dates

  res = await admin.post('/schedule', { ...shift, start_time: '12:00', end_time: '20:00' });
  assert.equal(res.status, 400);
  assert.match(res.text, /already booked/);

  // Nobody presses anything: once a shift has ended, its hours are recorded and approved.
  assert.match((await admin.get('/timesheets?status=all')).text, /from the schedule/);
  const entry = await db.get('SELECT * FROM time_entries WHERE shift_id = ?', ids.shift);
  assert.equal(entry.status, 'approved');
  assert.equal(entry.source, 'schedule');
  assert.equal(entry.end_at, `${lastMonday}T18:30`);
  assert.equal(entry.break_minutes, 30);
  assert.equal((await db.get('SELECT status FROM shifts WHERE id = ?', ids.shift)).status, 'completed');
  ids.entry = entry.id;
  // Never twice, even when two run at the same moment.
  await Promise.all([recordFinishedShifts(), recordFinishedShifts()]);
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM time_entries WHERE shift_id = ?', ids.shift)).n, 1);

  // Shifts still to come aren't recorded.
  const tomorrow = time.addDays(time.todayStr(), 1);
  await admin.post('/schedule', { ...shift, date: tomorrow });
  const future = await db.get('SELECT id FROM shifts WHERE start_at = ?', `${tomorrow}T08:00`);
  await recordFinishedShifts();
  assert.ok(!(await db.get('SELECT 1 FROM time_entries WHERE shift_id = ?', future.id)));
  await admin.post(`/schedule/${future.id}/delete`);

  // The office fixes an exception by changing the shift: its hours follow.
  const saturday = time.addDays(lastMonday, 5);
  await admin.post('/schedule', { ...shift, date: saturday, end_time: '12:00', break_minutes: '0' });
  const extra = await db.get('SELECT id FROM shifts WHERE start_at = ?', `${saturday}T08:00`);
  await recordFinishedShifts();
  res = await admin.post(`/schedule/${extra.id}`, { site_id: ids.site, employee_id: ids.employee, date: saturday, start_time: '08:00', end_time: '11:00', break_minutes: '0', status: 'completed' });
  assert.equal(res.status, 302);
  assert.equal((await db.get('SELECT end_at FROM time_entries WHERE shift_id = ?', extra.id)).end_at, `${saturday}T11:00`);
  // Cancelling or deleting it takes the hours away.
  await admin.post(`/schedule/${extra.id}`, { site_id: ids.site, employee_id: ids.employee, date: saturday, start_time: '08:00', end_time: '11:00', break_minutes: '0', status: 'cancelled' });
  assert.ok(!(await db.get('SELECT 1 FROM time_entries WHERE shift_id = ?', extra.id)));
  await admin.post(`/schedule/${extra.id}/delete`);
  assert.ok(!(await db.get('SELECT 1 FROM shifts WHERE id = ?', extra.id)));
});

test('timesheets: overlapping hours are blocked; approve in bulk', async () => {
  let res = await admin.post('/timesheets', { employee_id: ids.employee, date: lastMonday, start_time: '17:00', end_time: '19:00' });
  assert.equal(res.status, 400);
  assert.match(res.text, /overlap/);

  // Four more 10-hour days in the same week: 50 hours in total.
  for (let d = 1; d <= 4; d += 1) {
    res = await admin.post('/timesheets', { employee_id: ids.employee, site_id: ids.site, date: time.addDays(lastMonday, d), start_time: '08:00', end_time: '18:30', break_minutes: '30' });
    assert.equal(res.status, 302);
  }
  // Hours added by hand wait for approval (the shift's were approved by themselves).
  const pendingIds = (await db.all("SELECT id FROM time_entries WHERE status = 'pending'")).map((r) => r.id);
  assert.equal(pendingIds.length, 4);

  res = await admin.postList('/timesheets/bulk', [['action', 'approve'], ...pendingIds.map((id) => ['ids', String(id)])]);
  assert.equal(res.status, 302);
  assert.equal((await db.get("SELECT COUNT(*)::int AS n FROM time_entries WHERE status = 'approved'")).n, 5);
});

test('pay run: overtime is calculated and finalized hours are locked', async () => {
  let res = await admin.post('/pay', { period_start: lastMonday, period_end: time.addDays(lastMonday, 6) });
  assert.equal(res.status, 302);
  ids.payRun = Number(res.location.split('/').pop());
  const item = await db.get('SELECT * FROM pay_run_items WHERE pay_run_id = ?', ids.payRun);
  assert.equal(item.regular_hours, 40);
  assert.equal(item.overtime_hours, 10);
  assert.equal(item.gross_pay, 40 * 30 + 10 * 30 * 1.5);

  res = await admin.post(`/pay/${ids.payRun}/items/${item.id}`, { adjustment: '50', adjustment_note: 'Bonus' });
  assert.equal((await db.get('SELECT gross_pay FROM pay_run_items WHERE id = ?', item.id)).gross_pay, 1700);

  // Recalculating keeps the adjustment.
  await admin.post(`/pay/${ids.payRun}/recalculate`);
  assert.equal((await db.get('SELECT gross_pay FROM pay_run_items WHERE pay_run_id = ?', ids.payRun)).gross_pay, 1700);

  const csv = await admin.get(`/pay/${ids.payRun}/export.csv`);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text, /Sam Guard,.*,40,10,30,1.5,1200,450,50,Bonus,1700/);

  // Rejecting hours after the draft was made: the page warns, and finalizing leaves them out.
  const lastEntry = (await db.get('SELECT id FROM time_entries WHERE pay_run_id = ? ORDER BY start_at DESC', ids.payRun)).id;
  await admin.post(`/timesheets/${lastEntry}/reject`);
  assert.match((await admin.get(`/pay/${ids.payRun}`)).text, /no longer approved/);

  res = await admin.post(`/pay/${ids.payRun}/finalize`);
  assert.equal((await db.get('SELECT status FROM pay_runs WHERE id = ?', ids.payRun)).status, 'finalized');
  assert.equal((await db.get('SELECT gross_pay FROM pay_run_items WHERE pay_run_id = ?', ids.payRun)).gross_pay, 40 * 30 + 50);
  assert.equal((await db.get('SELECT pay_run_id FROM time_entries WHERE id = ?', lastEntry)).pay_run_id, null);

  res = await admin.post(`/timesheets/${ids.entry}/delete`);
  assert.ok(await db.get('SELECT 1 FROM time_entries WHERE id = ?', ids.entry), 'paid hours must not be deleted');
  res = await admin.post(`/schedule/${ids.shift}/delete`);
  assert.ok(await db.get('SELECT 1 FROM shifts WHERE id = ?', ids.shift), 'nor the shift they came from');

  // Each person's DMI timesheet for the pay run, stamped with who finalized it.
  const alex = await db.get("SELECT id FROM users WHERE email = 'alex@example.com'");
  assert.equal((await db.get('SELECT finalized_by FROM pay_runs WHERE id = ?', ids.payRun)).finalized_by, alex.id);
  const line = await db.get('SELECT id FROM pay_run_items WHERE pay_run_id = ?', ids.payRun);
  const sheet = await admin.get(`/pay/${ids.payRun}/items/${line.id}/timesheet.pdf`);
  assert.equal(sheet.status, 200);
  assert.ok(sheet.text.startsWith('%PDF'));
  assert.match(sheet.headers.get('content-disposition'), /^inline; filename="DMI_Timesheet_Guard_Sam_/);
  res = await admin.post(`/pay/${ids.payRun}/delete`);
  assert.ok(await db.get('SELECT 1 FROM pay_runs WHERE id = ?', ids.payRun), 'finalized pay runs must not be deleted');
});

test('managers cannot see pay, and cannot change pay rates', async () => {
  let res = await admin.post('/users', { name: 'Morgan Manager', email: 'morgan@example.com', role: 'manager', password: 'another long password', confirm: 'another long password' });
  assert.equal(res.status, 302);

  const duplicate = await admin.post('/users', { name: 'Copy', email: 'MORGAN@example.com', role: 'manager', password: 'another long password', confirm: 'another long password' });
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.text, /already uses that email/);

  const manager = makeClient();
  res = await signIn(manager, 'morgan@example.com', 'another long password');
  assert.equal(res.location, '/');

  assert.equal((await manager.get('/pay')).status, 403);
  assert.equal((await manager.get('/users')).status, 403);
  const profile = await manager.get(`/staff/${ids.employee}`);
  assert.equal(profile.status, 200);
  assert.doesNotMatch(profile.text, /Hourly rate/);

  await manager.post(`/staff/${ids.employee}`, { first_name: 'Sam', last_name: 'Guard', hourly_rate: '99', status: 'active' });
  assert.equal((await db.get('SELECT hourly_rate FROM employees WHERE id = ?', ids.employee)).hourly_rate, 30);
});

test('wrong passwords are limited', async () => {
  const visitor = makeClient();
  let res;
  for (let i = 0; i < 6; i += 1) {
    const _csrf = await visitor.token('/login');
    res = await visitor.post('/login', { email: 'nobody@example.com', password: 'wrong', _csrf }, '/login');
  }
  assert.equal(res.status, 401);
  assert.match(res.text, /Too many failed attempts/);
});

test('contracts: a signed copy can be uploaded and downloaded; unsafe file types are refused', async () => {
  const form = { title: 'Guarding agreement', contract_type: 'Client service agreement', party_type: 'client', client_id: String(ids.client), status: 'active', start_date: time.todayStr(), end_date: time.addDays(time.todayStr(), 10) };
  let res = await admin.postFile('/contracts', form, { name: 'evil.exe', content: 'MZ' }, '/contracts/new');
  assert.equal(res.status, 400);
  assert.match(res.text, /isn&#39;t allowed|isn't allowed/);

  res = await admin.postFile('/contracts', form, { name: 'signed.pdf', content: '%PDF-1.4 test' }, '/contracts/new');
  assert.equal(res.status, 302);
  const contractId = Number(res.location.split('/').pop());
  const download = await admin.get(`/contracts/${contractId}/file`);
  assert.equal(download.status, 200);
  assert.equal(download.text, '%PDF-1.4 test');
  assert.match(download.headers.get('content-disposition'), /signed\.pdf/);

  const outsider = await fetch(`${base}/contracts/${contractId}/file`, { redirect: 'manual' });
  assert.equal(outsider.status, 302, 'files need a login');

  const dashboard = await admin.get('/');
  assert.match(dashboard.text, /Guarding agreement/); // ends within 30 days
});

test('training: expiry dates are filled in and completing a session creates records', async () => {
  let res = await admin.post('/training/courses', { name: 'First Aid', validity_months: '36', required: '1', active: '1' });
  assert.equal(res.status, 302);
  const courseId = (await db.get('SELECT id FROM training_courses')).id;

  res = await admin.post('/training/courses', { name: 'first aid', active: '1' });
  assert.equal(res.status, 400, 'course names are unique, ignoring capitals');

  res = await admin.postFile('/training/records', { employee_id: String(ids.employee), course_id: String(courseId), completed_on: '2026-01-31' }, null, '/training/records/new');
  assert.equal(res.status, 302);
  assert.equal((await db.get('SELECT expires_on FROM training_records')).expires_on, '2029-01-31');

  res = await admin.post('/training/sessions', { course_id: courseId, date: time.addDays(time.todayStr(), 3), start_time: '09:00' });
  const sessionId = Number(res.location.split('/').pop());
  await admin.post(`/training/sessions/${sessionId}/attendees`, { employee_id: ids.employee });
  res = await admin.post(`/training/sessions/${sessionId}/complete`, { attended: ids.employee });
  assert.equal(res.status, 302);
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM training_records WHERE employee_id = ?', ids.employee)).n, 2);
  assert.equal((await db.get('SELECT status FROM training_sessions WHERE id = ?', sessionId)).status, 'completed');
});

test('settings: the time zone can be changed, and only to a listed zone', async () => {
  let res = await admin.post('/settings', { company_name: 'Test Security', timezone: 'Mars/Olympus', currency_symbol: '$', overtime_weekly_hours: '40', overtime_multiplier: '1.5', expiry_warning_days: '30' });
  assert.equal(res.status, 400);
  res = await admin.post('/settings', { company_name: 'Test Security', timezone: 'America/New_York', currency_symbol: '$', overtime_weekly_hours: '40', overtime_multiplier: '1.5', expiry_warning_days: '30' });
  assert.equal(res.status, 302);
  assert.equal((await db.get("SELECT value FROM settings WHERE key = 'timezone'")).value, 'America/New_York');
});

test('shifts: repeat on chosen days of the week until an end date', async () => {
  const monday = time.addDays(time.startOfWeek(time.todayStr()), 21);
  const base = { site_id: ids.site, employee_id: ids.employee, start_time: '09:00', end_time: '17:00', break_minutes: '0' };
  const count = async () => (await db.get(
    'SELECT COUNT(*)::int AS n FROM shifts WHERE start_at >= ? AND start_at < ?', `${monday}T00:00`, `${time.addDays(monday, 14)}T00:00`
  )).n;

  let res = await admin.postList('/schedule', [...Object.entries({ ...base, date: monday }), ['repeat_days', '0']]);
  assert.equal(res.status, 400, 'an end date is needed');
  assert.match(res.text, /repeat until/);

  // Mon, Wed and Fri for two weeks = 6 shifts.
  res = await admin.postList('/schedule', [
    ...Object.entries({ ...base, date: monday, repeat_until: time.addDays(monday, 13) }),
    ['repeat_days', '0'], ['repeat_days', '2'], ['repeat_days', '4'],
  ]);
  assert.equal(res.status, 302);
  assert.equal(await count(), 6);
  const days = (await db.all('SELECT start_at FROM shifts WHERE start_at >= ? AND start_at < ? ORDER BY start_at', `${monday}T00:00`, `${time.addDays(monday, 14)}T00:00`))
    .map((s) => time.dayOfWeek(s.start_at));
  assert.deepEqual(days, [0, 2, 4, 0, 2, 4]);

  // Tue to Fri in the first week: Wed and Fri are already booked, so they're skipped.
  res = await admin.postList('/schedule', [
    ...Object.entries({ ...base, date: time.addDays(monday, 1), repeat_until: time.addDays(monday, 6) }),
    ...['0', '1', '2', '3', '4'].map((d) => ['repeat_days', d]),
  ]);
  assert.equal(res.status, 302);
  assert.equal(await count(), 8);
  const week = await admin.get(res.location);
  assert.match(week.text, /2 shifts added/);
  assert.match(week.text, /2 repeat shift\(s\) were skipped/);
});

test('training: a new training can be typed in by name, and sessions have a length', async () => {
  const before = (await db.get('SELECT COUNT(*)::int AS n FROM training_courses')).n;
  let res = await admin.post('/training/sessions', { course_id: 'new', new_course_name: '', date: time.addDays(time.todayStr(), 5), start_time: '09:00', duration_hours: '4' });
  assert.equal(res.status, 400);
  assert.match(res.text, /type the name of a new one/);

  res = await admin.post('/training/sessions', {
    course_id: 'new', new_course_name: 'Baton Certification', new_course_validity: '24', date: time.addDays(time.todayStr(), 5), start_time: '09:00', duration_hours: '2.5',
  });
  assert.equal(res.status, 302);
  const course = await db.get("SELECT * FROM training_courses WHERE name = 'Baton Certification'");
  assert.equal(course.validity_months, 24);
  const sessionId = Number(res.location.split('/').pop());
  assert.equal((await db.get('SELECT duration_minutes FROM training_sessions WHERE id = ?', sessionId)).duration_minutes, 150);

  // Typing a name that already exists uses that training instead of making a copy.
  res = await admin.post('/training/sessions', { course_id: 'new', new_course_name: 'FIRST AID', date: time.addDays(time.todayStr(), 6), start_time: '09:00', duration_hours: '4' });
  assert.equal(res.status, 302);
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM training_courses')).n, before + 1);

  res = await admin.postFile('/training/records', { employee_id: String(ids.employee), course_id: 'new', new_course_name: 'Pepper Spray', completed_on: '2026-02-01' }, null, '/training/records/new');
  assert.equal(res.status, 302);
  assert.ok(await db.get("SELECT 1 FROM training_courses WHERE name = 'Pepper Spray'"));

  const form = await admin.get('/training/sessions/new');
  assert.match(form.text, /Baton Certification/);
  assert.match(form.text, /New training/);
});

test('conflict checker: finds problems, and "find cover" assigns someone who is free', async () => {
  const day = time.addDays(time.startOfWeek(time.todayStr()), 35);
  const next = time.addDays(day, 1);
  let res = await admin.post('/staff', { first_name: 'Jo', last_name: 'Backup', hourly_rate: '25', license_required: '0', status: 'active' });
  const backupId = Number(res.location.split('/').pop());

  // Sam's license is fine today, but runs out a few days before these shifts.
  await db.run('UPDATE employees SET license_required = 1, license_number = ?, license_expiry = ? WHERE id = ?', 'L-123', time.addDays(day, -3), ids.employee);
  const shift = (date, start, end, employee = ids.employee) => admin.post('/schedule', { site_id: ids.site, employee_id: employee || '', date, start_time: start, end_time: end, break_minutes: '0' });
  await shift(day, '06:00', '14:00');
  await shift(day, '18:00', '23:00'); // only 4 hours' rest
  await shift(day, '08:00', '16:00', null); // unfilled
  const unfilledId = (await db.get('SELECT id FROM shifts WHERE employee_id IS NULL ORDER BY id DESC')).id;
  await shift(next, '10:00', '18:00');
  // Training at the same time as that shift.
  const firstAid = (await db.get("SELECT id FROM training_courses WHERE name = 'First Aid'")).id;
  res = await admin.post('/training/sessions', { course_id: firstAid, date: next, start_time: '09:00', duration_hours: '4' });
  await admin.post(`/training/sessions/${Number(res.location.split('/').pop())}/attendees`, { employee_id: ids.employee });
  // Double bookings can't be made on the Schedule page, but could come from older data.
  for (const [start, end] of [['08:00', '16:00'], ['12:00', '20:00']]) {
    await db.run('INSERT INTO shifts (site_id, employee_id, start_at, end_at) VALUES (?, ?, ?, ?)', ids.site, ids.employee, `${time.addDays(day, 2)}T${start}`, `${time.addDays(day, 2)}T${end}`);
  }

  const page = await admin.get(`/schedule/conflicts?from=${day}&to=${time.addDays(day, 6)}`);
  assert.equal(page.status, 200);
  for (const label of ['Double-booked', 'Clashes with training', 'Not enough rest', 'Unfilled shift', 'License or training problem']) {
    assert.match(page.text, new RegExp(`class="badge badge-\\w+">${label}<`), label);
  }
  assert.doesNotMatch(page.text, /class="badge badge-\w+">Overtime</, 'Sam is under 40 hours that week');
  assert.match(page.text, /only gets 4 h rest/);
  assert.match(page.text, /Security license \(expired/);

  const week = await admin.get(`/schedule?week=${day}`);
  assert.match(week.text, /\d+ conflicts/);

  const cover = await admin.get(`/schedule/${unfilledId}/cover`);
  assert.equal(cover.status, 200);
  assert.match(cover.text, /Jo Backup/);
  assert.match(cover.text, /Already booked 06:00–14:00/);

  res = await admin.post(`/schedule/${unfilledId}/assign`, { employee_id: ids.employee, back: '/schedule/conflicts' });
  assert.match(res.location, new RegExp(`/schedule/${unfilledId}/cover`), 'someone who is busy is not assigned');
  assert.equal((await db.get('SELECT employee_id FROM shifts WHERE id = ?', unfilledId)).employee_id, null);

  res = await admin.post(`/schedule/${unfilledId}/assign`, { employee_id: backupId, back: 'https://example.com/elsewhere' });
  assert.equal(res.status, 302);
  assert.equal(res.location, `/schedule?week=${day}`, 'only goes back to schedule pages');
  assert.equal((await db.get('SELECT employee_id FROM shifts WHERE id = ?', unfilledId)).employee_id, backupId);
  ids.backup = backupId;
  ids.conflictDay = day;
});

const officer = makeClient();

test('sign-up: new accounts wait for approval, then an admin makes them an officer', async () => {
  const form = { requested_role: 'officer', name: 'Olivia Officer', email: 'olivia@example.com', phone: '555-0100', password: 'officer password 1', confirm: 'officer password 1' };
  let res = await officer.post('/register', form, '/register');
  assert.equal(res.status, 302);
  assert.equal(res.location, '/waiting');
  assert.match((await officer.get('/waiting')).text, /waiting for the office to approve/);
  assert.equal((await officer.get('/')).location, '/waiting', 'a new account sees nothing yet');
  assert.equal((await officer.get('/schedule')).location, '/waiting');
  assert.equal((await officer.post('/staff', { first_name: 'X', last_name: 'Y' })).status, 403);

  const copy = await makeClient().post('/register', { ...form, email: 'OLIVIA@example.com' }, '/register');
  assert.equal(copy.status, 400, 'one account per email');

  const userId = (await db.get("SELECT id FROM users WHERE email = 'olivia@example.com'")).id;
  assert.match((await admin.get('/')).text, /waiting for a role/);
  assert.match((await admin.get('/users')).text, /Approve/);
  res = await admin.post(`/users/${userId}`, { name: 'Olivia Officer', email: 'olivia@example.com', phone: '555-0100', role: 'officer', employee_id: '', active: '1' });
  assert.equal(res.status, 400, 'an officer must be linked to a staff record');
  res = await admin.post(`/users/${userId}`, { name: 'Olivia Officer', email: 'olivia@example.com', phone: '555-0100', role: 'officer', employee_id: 'new', active: '1' });
  assert.equal(res.status, 302);
  const user = await db.get('SELECT * FROM users WHERE id = ?', userId);
  assert.equal(user.role, 'officer');
  const employee = await db.get('SELECT * FROM employees WHERE id = ?', user.employee_id);
  assert.equal(`${employee.first_name} ${employee.last_name}`, 'Olivia Officer');
  ids.officer = employee.id;

  // First, two-step sign-in (needed for every account with a role).
  assert.equal((await officer.get('/my')).location, '/account/two-step');
  assert.equal((await setUpTwoStep(officer)).status, 200);

  // Officers get their own pages, and nothing from the back office.
  assert.equal((await officer.get('/')).location, '/my');
  assert.equal((await officer.get('/my')).location, '/my/schedule');
  for (const url of ['/staff', '/pay', '/timesheets', '/users', '/tax']) {
    assert.equal((await officer.get(url)).location, '/my', url);
  }
  assert.equal((await officer.post('/schedule', { site_id: ids.site })).status, 403);
});

test('calendar: officers see their own month, clients see their sites with short names', async () => {
  const today = time.todayStr();
  const nextMonth = time.addMonths(`${today.slice(0, 7)}-01`, 1);
  for (const date of [today, time.addDays(nextMonth, 2)]) {
    await admin.post('/schedule', { site_id: ids.site, employee_id: ids.officer, date, start_time: '06:00', end_time: '14:00', break_minutes: '0' });
  }
  let res = await officer.get('/my/schedule');
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(time.fmtMonth(today.slice(0, 7))));
  assert.match(res.text, /Main entrance/);
  assert.match(res.text, /Your next shift/);
  res = await officer.get(`/my/schedule?month=${nextMonth.slice(0, 7)}`);
  assert.match(res.text, /06:00–14:00/);

  res = await admin.post('/users', { name: 'Carla Client', email: 'carla@example.com', role: 'client', client_id: ids.client, password: 'client password 1', confirm: 'client password 1' });
  assert.equal(res.status, 302);
  const client = makeClient();
  res = await signIn(client, 'carla@example.com', 'client password 1');
  assert.equal(res.location, '/my');
  res = await client.get('/my/schedule');
  assert.match(res.text, /Olivia O\./);
  assert.doesNotMatch(res.text, /Olivia Officer/);
  assert.equal((await client.get('/my/pay')).status, 403, 'pay is for officers');
  assert.equal((await client.get('/staff')).location, '/my');
});

test('officers: no timesheets to fill in; their hours from the schedule show in My pay', async () => {
  const { periodStartFor } = require('../src/services/officerTimesheet');
  const period = time.addDays(periodStartFor(time.todayStr()), -14);
  const monday = time.addDays(period, 1);
  await admin.post('/schedule', { site_id: ids.site, employee_id: ids.officer, date: monday, start_time: '08:00', end_time: '16:00', break_minutes: '0' });

  assert.equal((await officer.get('/my/timesheets')).location, '/my/pay', 'old links go to My pay');
  assert.equal((await officer.get(`/my/timesheets/new?period=${period}`)).location, '/my/pay');
  assert.notEqual((await officer.post('/my/timesheets', { period, in_1: '0800', out_1: '1600', confirm: '1' })).status, 302);
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM timesheet_submissions')).n, 0, 'officers no longer send timesheets');

  const page = await officer.get('/my/pay');
  assert.equal(page.status, 200);
  assert.match(page.text, /Main entrance/);
  assert.match(page.text, /08:00–16:00/);
  assert.match(page.text, /fill in your W-9/);
  const entry = await db.get('SELECT * FROM time_entries WHERE employee_id = ? AND start_at = ?', ids.officer, `${monday}T08:00`);
  assert.equal(entry.status, 'approved');
  assert.equal(entry.source, 'schedule');
  // A one-time list of things to set up.
  assert.match((await officer.get('/my/schedule')).text, /Finish setting up/);
});

test('my details: officers keep their contact details up to date', async () => {
  let res = await officer.post('/my/details', { phone: '12', email: 'olivia@example.com' });
  assert.equal(res.status, 400);
  assert.match(res.text, /phone number/);
  res = await officer.post('/my/details', {
    phone: '(213) 555-0199', email: 'olivia.o@example.com', address: '1 Test St, Los Angeles',
    emergency_contact_name: 'Oscar Officer', emergency_contact_phone: '213-555-0123',
  });
  assert.equal(res.status, 302);
  const me = await db.get('SELECT * FROM employees WHERE id = ?', ids.officer);
  assert.equal(me.phone, '(213) 555-0199');
  assert.equal(me.email, 'olivia.o@example.com');
  assert.equal(me.emergency_contact_phone, '213-555-0123');
  const account = await db.get('SELECT * FROM users WHERE employee_id = ?', ids.officer);
  assert.equal(account.phone, '(213) 555-0199');
  assert.equal(account.email, 'olivia@example.com', 'the email she signs in with stays the same');
  assert.match((await admin.get('/activity')).text, /Olivia Officer updated their phone, email, address, emergency contact, emergency contact phone/);
  assert.match((await admin.get(`/staff/${ids.officer}`)).text, /Oscar Officer/);

  const schedule = await officer.get('/my/schedule');
  assert.doesNotMatch(schedule.text, /Add your phone number|Add an emergency contact/);
  assert.match(schedule.text, /Fill in your W-9/, 'only the W-9 is left');
});

test('1099-NEC: W-9 details, company details, issuing and sharing online', async () => {
  const year = Number(time.todayStr().slice(0, 4));
  // Pay Olivia for her approved hours.
  await db.run('UPDATE employees SET hourly_rate = 25 WHERE id = ?', ids.officer);
  const { periodStartFor } = require('../src/services/officerTimesheet');
  const period = time.addDays(periodStartFor(time.todayStr()), -14);
  let res = await admin.post('/pay', { period_start: period, period_end: time.addDays(period, 13) });
  const payRun = Number(res.location.split('/').pop());
  await admin.post(`/pay/${payRun}/finalize`, { paid_on: time.todayStr() });
  assert.equal((await db.get('SELECT paid_on FROM pay_runs WHERE id = ?', payRun)).paid_on, time.todayStr());

  // Her payslip and DMI timesheet are in My pay.
  const line = await db.get('SELECT * FROM pay_run_items WHERE pay_run_id = ? AND employee_id = ?', payRun, ids.officer);
  assert.match((await officer.get('/my/pay')).text, new RegExp(`/my/pay/${line.id}/timesheet\\.pdf`));
  assert.match((await officer.get(`/my/pay/${line.id}`)).text, /\$200\.00/);
  let sheet = await officer.get(`/my/pay/${line.id}/timesheet.pdf`);
  assert.equal(sheet.status, 200);
  assert.ok(sheet.text.startsWith('%PDF'));
  assert.match(sheet.headers.get('content-disposition'), /^inline;/);
  const kept = (await db.get('SELECT timesheet_file FROM pay_run_items WHERE id = ?', line.id)).timesheet_file;
  sheet = await officer.get(`/my/pay/${line.id}/timesheet.pdf?download=1`);
  assert.match(sheet.headers.get('content-disposition'), /^attachment/);
  assert.equal((await db.get('SELECT timesheet_file FROM pay_run_items WHERE id = ?', line.id)).timesheet_file, kept, 'made once, then kept');
  // Nobody else's.
  res = await admin.post('/users', { name: 'Owen Other', email: 'owen@example.com', role: 'officer', employee_id: 'new', password: 'other officer 1', confirm: 'other officer 1', active: '1' });
  assert.equal(res.status, 302);
  const other = makeClient();
  await signIn(other, 'owen@example.com', 'other officer 1');
  assert.equal((await other.get(`/my/pay/${line.id}`)).status, 404);
  assert.equal((await other.get(`/my/pay/${line.id}/timesheet.pdf`)).status, 404);

  // Her W-9 details.
  assert.match((await officer.get('/my/tax')).text, /Fill in now/);
  const w9 = { legal_name: 'Olivia Officer', tax_classification: 'individual', address: '1 Test St', city: 'Los Angeles', state: 'ca', zip: '90012', tin_type: 'SSN', certify: '1', signed_name: 'Olivia Officer' };
  res = await officer.post('/my/tax/w9', { ...w9, tin: '000-12-3456' });
  assert.equal(res.status, 400);
  res = await officer.post('/my/tax/w9', { ...w9, tin: '123-45-6789' });
  assert.equal(res.status, 302);
  const profile = await db.get('SELECT * FROM tax_profiles WHERE employee_id = ?', ids.officer);
  assert.equal(profile.tin_last4, '6789');
  assert.equal(profile.state, 'CA');
  assert.ok(!profile.tin_encrypted.includes('123456789'), 'the number is stored encrypted');

  // The company's details are needed first.
  res = await admin.post('/tax/forms', { year, employee_id: ids.officer });
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM tax_forms')).n, 0);
  res = await admin.post('/settings', {
    company_name: 'Test Security', timezone: 'America/New_York', currency_symbol: '$', overtime_weekly_hours: '40', overtime_multiplier: '1.5', expiry_warning_days: '30', min_rest_hours: '8',
    payer_name: 'Test Security LLC', payer_ein: '12 3456789', payer_address: '100 Main St', payer_city: 'Los Angeles', payer_state: 'CA', payer_zip: '90012', payer_phone: '(213) 555-0100',
  });
  assert.equal(res.status, 302);
  assert.equal((await db.get("SELECT value FROM settings WHERE key = 'payer_ein'")).value, '12-3456789');

  const list = await admin.get(`/tax?year=${year}`);
  assert.match(list.text, /Olivia Officer/);
  res = await admin.post('/tax/forms', { year, employee_id: ids.officer });
  assert.equal(res.status, 302);
  const formId = Number(res.location.split('/').pop());
  const form = await db.get('SELECT * FROM tax_forms WHERE id = ?', formId);
  assert.equal(form.box1, 8 * 25);
  assert.equal(form.recipient.name, 'Olivia Officer');
  const page = await admin.get(`/tax/forms/${formId}`);
  assert.match(page.text, /\*\*\*-\*\*-6789/);
  assert.doesNotMatch(page.text, /123-45-6789/);
  for (const copy of ['', '?copy=payer']) {
    const pdf = await admin.get(`/tax/forms/${formId}/pdf${copy}`);
    assert.equal(pdf.status, 200);
    assert.ok(pdf.text.startsWith('%PDF'));
  }

  // Not visible to her until it's issued, she agreed to get it online, and it's shared.
  assert.equal((await officer.get(`/my/tax/1099/${formId}`)).status, 404);
  await admin.post(`/tax/forms/${formId}/release`, { release: '1' });
  assert.equal((await db.get('SELECT released FROM tax_forms WHERE id = ?', formId)).released, 0, 'drafts are never shared');
  await admin.post(`/tax/forms/${formId}/issue`);
  await admin.post(`/tax/forms/${formId}/release`, { release: '1' });
  assert.equal((await db.get('SELECT released FROM tax_forms WHERE id = ?', formId)).released, 0, 'not without her agreement');
  await officer.post('/my/tax/consent', { agree: '1' });
  assert.equal((await db.get('SELECT electronic_consent FROM tax_profiles WHERE employee_id = ?', ids.officer)).electronic_consent, 0, 'she must tick that she read it');
  await officer.post('/my/tax/consent', { agree: '1', understand: '1' });
  await admin.post(`/tax/forms/${formId}/release`, { release: '1' });
  assert.equal((await db.get('SELECT released FROM tax_forms WHERE id = ?', formId)).released, 1);
  assert.match((await officer.get('/my/tax')).text, new RegExp(String(year)));
  const download = await officer.get(`/my/tax/1099/${formId}`);
  assert.equal(download.status, 200);
  assert.ok(download.text.startsWith('%PDF'));

  // Issued forms are locked; the filing summary has the full number for the IRS.
  await admin.post(`/tax/forms/${formId}`, { box1: '1' });
  assert.equal((await db.get('SELECT box1 FROM tax_forms WHERE id = ?', formId)).box1, 200);
  const filing = await admin.get(`/tax/filing?year=${year}`);
  assert.match(filing.text, /123-45-6789/);
  assert.equal(filing.headers.get('cache-control'), 'no-store');

  // Switching back to paper takes it out of her account.
  await officer.post('/my/tax/consent', { agree: '0' });
  assert.equal((await officer.get(`/my/tax/1099/${formId}`)).status, 404);

  // A correction reopens it as a draft marked CORRECTED.
  await admin.post(`/tax/forms/${formId}/correct`);
  const corrected = await db.get('SELECT status, corrected FROM tax_forms WHERE id = ?', formId);
  assert.deepEqual([corrected.status, corrected.corrected], ['draft', 1]);
});

test('timesheets officers sent before: the approved copy is in My pay to view or download', async () => {
  // A timesheet Olivia sent herself, before hours came from the schedule.
  const { periodStartFor, buildTimesheetPdf } = require('../src/services/officerTimesheet');
  const { saveUpload } = require('../src/uploads');
  const period = time.addDays(periodStartFor(time.todayStr()), -28);
  const pdf = await buildTimesheetPdf({ name: 'Officer, Olivia', location: 'Harbour Mall', phone: '555-0100', start: period, worked: [] });
  const stored = await saveUpload({ originalname: 'timesheet.pdf', buffer: pdf, size: pdf.length });
  const sheetId = await db.insert(
    'INSERT INTO timesheet_submissions (employee_id, period_start, period_end, total_hours, file_name) VALUES (?, ?, ?, 12, ?)',
    ids.officer, period, time.addDays(period, 13), stored.file_name
  );
  for (const [day, end] of [[1, '16:00'], [2, '12:00']]) {
    const date = time.addDays(period, day);
    await db.run("INSERT INTO time_entries (employee_id, start_at, end_at, submission_id, source) VALUES (?, ?, ?, ?, 'officer')", ids.officer, `${date}T08:00`, `${date}T${end}`, sheetId);
  }

  // The approved copy is made when the LAST waiting day is checked.
  const [first, second] = await db.all('SELECT id FROM time_entries WHERE submission_id = ? ORDER BY start_at', sheetId);
  await admin.post(`/timesheets/${first.id}/approve`);
  assert.equal((await db.get('SELECT approved_file_name FROM timesheet_submissions WHERE id = ?', sheetId)).approved_file_name, null, 'not while a day is still waiting');
  assert.match((await officer.get(`/my/timesheets/${sheetId}/pdf`)).headers.get('content-disposition'), /filename="[^"]*\d\.pdf"/, 'until then, the copy they signed');
  let res = await admin.post(`/timesheets/${second.id}/reject`);
  const done = await db.get('SELECT * FROM timesheet_submissions WHERE id = ?', sheetId);
  assert.ok(done.approved_file_name, 'one day approved and one rejected still counts as checked');
  assert.notEqual(done.approved_file_name, done.file_name);
  assert.match((await admin.get(res.location)).text, /now fully approved/);
  assert.match((await admin.get('/timesheets/submissions')).text, /View approved copy/);
  res = await admin.get(`/timesheets/submissions/${sheetId}/approved-pdf`);
  assert.match(res.headers.get('content-disposition'), /^inline;/);
  assert.ok(res.text.startsWith('%PDF'));

  // In her account: "View" opens it in the browser; "Download" saves it.
  const list = await officer.get('/my/pay');
  assert.match(list.text, /Timesheets you sent before/);
  assert.match(list.text, /Approved copy · Alex Admin/);
  assert.match(list.text, new RegExp(`/my/timesheets/${sheetId}/pdf\\?download=1`));
  res = await officer.get(`/my/timesheets/${sheetId}/pdf`);
  assert.equal(res.status, 200);
  assert.ok(res.text.startsWith('%PDF'));
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /^inline; filename=".*_approved\.pdf"/);
  res = await officer.get(`/my/timesheets/${sheetId}/pdf?download=1`);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="?.*_approved\.pdf/);

  // Nobody else can open it.
  const client = makeClient();
  await signIn(client, 'carla@example.com', 'client password 1');
  assert.equal((await client.get(`/my/timesheets/${sheetId}/pdf`)).status, 403);
  assert.equal((await makeClient().get(`/my/timesheets/${sheetId}/pdf`)).status, 302, 'needs a login');
});

test('call-outs: the shift is offered to officers who could take it, and the first to claim it gets it', async () => {
  const notify = require('../src/services/notify');
  const { advanceOffers, claimShift } = require('../src/services/openShifts');
  const sent = [];
  notify.setSender(async (subscription, payload) => sent.push({ to: subscription.endpoint.split('/').pop(), ...JSON.parse(payload) }));
  const to = (who) => sent.filter((m) => m.to === who);
  const device = (who) => ({ endpoint: `https://push.example.com/${who}`, p256dh: `BKey${who}`, auth: `auth${who}`, device: 'Android phone' });

  // Turning on notifications saves the device with the account.
  const owen = makeClient();
  await signIn(owen, 'owen@example.com', 'other officer 1');
  for (const [client, who] of [[officer, 'olivia'], [owen, 'owen'], [admin, 'alex']]) {
    assert.deepEqual(JSON.parse((await client.post('/account/push', device(who))).text), { ok: true });
  }
  assert.equal((await officer.post('/account/push', { endpoint: 'http://not-secure.example.com', p256dh: 'x', auth: 'y' })).status, 400);
  assert.deepEqual(JSON.parse((await officer.post('/account/push/test')).text), { sent: 1 });
  assert.equal(to('olivia')[0].title, 'Notifications are on');
  const testOfficer = await db.get("SELECT id, employee_id FROM users WHERE email = 'test.officer@example.com'");
  await notify.saveSubscription(testOfficer.id, device('test'));

  // Owen is a regular at the site; the test officer isn't. Both are licensed and trained.
  const owenId = (await db.get("SELECT employee_id FROM users WHERE email = 'owen@example.com'")).employee_id;
  await db.run('UPDATE employees SET license_required = 0 WHERE id = ?', owenId);
  await db.run('UPDATE training_courses SET required = 0');
  const before = time.addDays(time.todayStr(), -10);
  await db.run("INSERT INTO shifts (site_id, employee_id, start_at, end_at, status) VALUES (?, ?, ?, ?, 'completed')", ids.site, owenId, `${before}T09:00`, `${before}T17:00`);

  // Olivia can't make a shift in two days.
  const day = time.addDays(time.todayStr(), 2);
  await admin.post('/schedule', { site_id: ids.site, employee_id: ids.officer, date: day, start_time: '09:00', end_time: '17:00', break_minutes: '0' });
  const shift = await db.get('SELECT * FROM shifts WHERE employee_id = ? AND start_at = ?', ids.officer, `${day}T09:00`);
  assert.equal(to('olivia').at(-1).title, 'New shift', 'she was told about it');
  assert.match((await officer.get(`/my/schedule?month=${day.slice(0, 7)}`)).text, new RegExp(`/my/shifts/${shift.id}/call-out`));
  assert.equal((await officer.get(`/my/shifts/${shift.id}/call-out`)).status, 200);
  let res = await officer.post(`/my/shifts/${shift.id}/call-out`, { reason: 'Sick' });
  assert.equal(res.status, 302);
  assert.equal((await db.get('SELECT employee_id FROM shifts WHERE id = ?', shift.id)).employee_id, null);
  const callout = await db.get('SELECT * FROM shift_callouts WHERE shift_id = ?', shift.id);
  assert.equal(callout.reason, 'Sick');
  assert.ok(callout.hours_notice > 24);
  const offer = await db.get("SELECT * FROM shift_offers WHERE shift_id = ? AND status = 'open'", shift.id);
  assert.match(to('alex').at(-1).title, /^Call-out: Olivia O\./, 'the office hears about it');
  assert.match(to('owen').at(-1).title, /^Open shift:/, 'the regular hears first');
  assert.equal(to('owen').at(-1).url, `/my/open-shifts/${offer.id}`);
  assert.equal(to('test').length, 0, 'everyone else hears ten minutes later');
  assert.ok(!(await db.get('SELECT 1 FROM shift_offer_recipients WHERE offer_id = ? AND employee_id = ?', offer.id, ids.officer)), 'never offered back to her');
  assert.match((await claimShift(offer.id, testOfficer.employee_id, (await require('../src/settings').getSettings()))).error, /wasn't offered to you/);

  // Ten minutes on: the next wave. Thirty minutes on with no claim: the office. Each only once.
  await db.run("UPDATE shift_offers SET next_wave_at = '2000-01-01T00:00' WHERE id = ?", offer.id);
  await advanceOffers();
  await advanceOffers();
  assert.equal(to('test').length, 1);
  await db.run("UPDATE shift_offers SET escalate_at = '2000-01-01T00:00' WHERE id = ?", offer.id);
  await advanceOffers();
  await advanceOffers();
  assert.equal(sent.filter((m) => m.to === 'alex' && m.title.startsWith('Still open')).length, 1);
  assert.match((await admin.get('/')).text, /Nobody has claimed it/);

  // Owen sees it and both claim at the same moment: exactly one gets it.
  assert.match((await owen.get('/my/schedule')).text, /Open shifts you can take/);
  assert.match((await owen.get(`/my/open-shifts/${offer.id}`)).text, /Claim this shift/);
  const settings = await require('../src/settings').getSettings();
  const claims = await Promise.all([claimShift(offer.id, owenId, settings), claimShift(offer.id, testOfficer.employee_id, settings)]);
  assert.equal(claims.filter((c) => c.shift).length, 1, 'only one winner');
  const winner = claims.find((c) => c.shift).employee.id;
  assert.equal((await db.get('SELECT employee_id FROM shifts WHERE id = ?', shift.id)).employee_id, winner);
  assert.equal((await db.get('SELECT status, filled_by FROM shift_offers WHERE id = ?', offer.id)).filled_by, winner);
  assert.match(claims.find((c) => c.error).error, /Someone else already took this shift/);
  assert.match(to('alex').at(-1).title, /^Covered:/);
  if (winner !== owenId) {
    res = await owen.post(`/my/open-shifts/${offer.id}/claim`);
    assert.match((await owen.get(res.location)).text, /Someone else already took this shift/);
  }

  // The office notes a call-out for someone who phoned in, then assigns cover itself.
  const later = time.addDays(day, 1);
  await admin.post('/schedule', { site_id: ids.site, employee_id: owenId, date: later, start_time: '09:00', end_time: '17:00', break_minutes: '0' });
  const second = await db.get('SELECT * FROM shifts WHERE employee_id = ? AND start_at = ?', owenId, `${later}T09:00`);
  res = await admin.post(`/schedule/${second.id}/call-out`, { reason: 'Car broke down' });
  assert.equal(res.status, 302);
  assert.equal(to('owen').at(-1).title, 'Taken off a shift');
  assert.match((await admin.get(res.location)).text, /Offered to officers/);
  res = await admin.post(`/schedule/${second.id}/assign`, { employee_id: testOfficer.employee_id });
  assert.equal((await db.get("SELECT status FROM shift_offers WHERE shift_id = ? ORDER BY id DESC", second.id)).status, 'withdrawn');
  assert.equal(to('test').at(-1).title, 'New shift');

  // An unfilled shift can be offered straight away too.
  await admin.post('/schedule', { site_id: ids.site, date: later, start_time: '18:00', end_time: '22:00', break_minutes: '0' });
  const unfilled = await db.get('SELECT id FROM shifts WHERE employee_id IS NULL AND start_at = ?', `${later}T18:00`);
  res = await admin.post(`/schedule/${unfilled.id}/offer`);
  assert.ok(await db.get("SELECT 1 FROM shift_offers WHERE shift_id = ? AND status = 'open'", unfilled.id));
  assert.match((await admin.get('/schedule?week=' + time.startOfWeek(later))).text, /Open: offered to officers/);
  notify.setSender(null);
});

test('availability: officers say when they can\'t work; the schedule warns, and open shifts skip them', async () => {
  const notify = require('../src/services/notify');
  const { coverOptions } = require('../src/services/conflicts');
  const { getSettings } = require('../src/settings');
  const sent = [];
  notify.setSender(async (subscription, payload) => sent.push({ to: subscription.endpoint.split('/').pop(), ...JSON.parse(payload) }));

  // Olivia can't work on one evening a week, from today.
  const day = time.addDays(time.todayStr(), 4);
  let res = await officer.post('/my/availability', { kind: 'unavailable', repeat: 'weekly', start_date: time.todayStr(), weekdays: String(time.dayOfWeek(day)), start_time: '18:00', end_time: '23:00', note: 'Night class' });
  assert.equal(res.status, 302);
  assert.match((await officer.get('/my/availability')).text, /Every \w{3}, 18:00–23:00/);
  res = await officer.post('/my/availability', { kind: 'unavailable', repeat: 'weekly', start_date: time.todayStr(), all_day: '1' });
  assert.equal(res.status, 400, 'a weekly repeat needs its days');
  assert.match((await officer.get(`/my/schedule?month=${day.slice(0, 7)}`)).text, /Can&#39;t work|Can't work/);

  // The office booking her then is warned, and the conflict checker lists it.
  res = await admin.post('/schedule', { site_id: ids.site, employee_id: ids.officer, date: day, start_time: '19:00', end_time: '22:00', break_minutes: '0' });
  assert.match((await admin.get(res.location)).text, /said they can&#39;t work then|said they can't work then/);
  assert.match((await admin.get(`/schedule/conflicts?from=${day}&to=${day}`)).text, /Booked while unavailable/);
  const booked = await db.get('SELECT * FROM shifts WHERE employee_id = ? AND start_at = ?', ids.officer, `${day}T19:00`);

  // "Find cover" and open shifts skip her then; at other times she's fine.
  const settings = await getSettings();
  const options = await coverOptions({ id: 0, site_id: ids.site, employee_id: null, start_at: `${day}T20:00`, end_at: `${day}T23:00`, break_minutes: 0 }, settings);
  assert.match(options.find((o) => o.employee.id === ids.officer).blockers.join(), /can't work/);
  const morning = await coverOptions({ id: 0, site_id: ids.site, employee_id: null, start_at: `${day}T08:00`, end_at: `${day}T12:00`, break_minutes: 0 }, settings);
  assert.ok(!morning.find((o) => o.employee.id === ids.officer).blockers.some((b) => /can't work/.test(b)));

  // Saying she can't work when she's already booked: she's told what to do, and so is the office.
  const nextWeek = time.addDays(day, 7);
  await admin.post('/schedule', { site_id: ids.site, employee_id: ids.officer, date: nextWeek, start_time: '08:00', end_time: '12:00', break_minutes: '0' });
  res = await officer.post('/my/availability', { kind: 'unavailable', repeat: 'once', start_date: nextWeek, all_day: '1', note: 'Wedding' });
  assert.match((await officer.get(res.location)).text, /already booked then/);
  assert.match(sent.filter((m) => m.to === 'alex').at(-1).title, /says they can't work, but is booked/);

  // Available for extra shifts: she's asked first. The office can see all of it.
  res = await officer.post('/my/availability', { kind: 'available', repeat: 'once', start_date: time.addDays(day, 1), all_day: '1' });
  const extra = await coverOptions({ id: 0, site_id: ids.site, employee_id: null, start_at: `${time.addDays(day, 1)}T08:00`, end_at: `${time.addDays(day, 1)}T12:00`, break_minutes: 0 }, settings);
  assert.equal(extra.find((o) => o.employee.id === ids.officer).markedAvailable, true);
  assert.match((await admin.get('/schedule/availability')).text, /Olivia Officer[\s\S]*Night class/);
  assert.match((await admin.get(`/staff/${ids.officer}`)).text, /Wedding/);

  // Removing one.
  const entry = await db.get("SELECT id FROM availability WHERE note = 'Wedding'");
  await officer.post(`/my/availability/${entry.id}/delete`);
  assert.ok(!(await db.get('SELECT 1 FROM availability WHERE id = ?', entry.id)));
  await admin.post(`/schedule/${booked.id}/delete`);
  notify.setSender(null);
});

test('shift requests: a site asks, the office approves, and the officers they asked for get first choice', async () => {
  const notify = require('../src/services/notify');
  const { claimShift } = require('../src/services/openShifts');
  const { getSettings } = require('../src/settings');
  const sent = [];
  notify.setSender(async (subscription, payload) => sent.push({ to: subscription.endpoint.split('/').pop(), ...JSON.parse(payload) }));
  const to = (who) => sent.filter((m) => m.to === who);

  const site = makeClient();
  await signIn(site, 'carla@example.com', 'client password 1');
  const carla = await db.get("SELECT id FROM users WHERE email = 'carla@example.com'");
  await notify.saveSubscription(carla.id, { endpoint: 'https://push.example.com/carla', p256dh: 'BKeycarla', auth: 'authcarla' });
  const owenId = (await db.get("SELECT employee_id FROM users WHERE email = 'owen@example.com'")).employee_id;
  const testOfficer = await db.get("SELECT employee_id FROM users WHERE email = 'test.officer@example.com'");

  // The form lists officers who've worked at their sites, by short name.
  const form = await site.get('/my/requests/new');
  assert.match(form.text, /Owen O\./);
  assert.doesNotMatch(form.text, /Owen Other/);
  assert.equal((await officer.get('/my/requests')).status, 403, 'requests are for sites');

  const day = time.addDays(time.todayStr(), 6);
  const ask = (extra = []) => site.postList('/my/requests', [
    ['site_id', String(ids.site)], ['date', day], ['start_time', '10:00'], ['end_time', '14:00'], ['officers_needed', '2'],
    ['notes', 'Farmers market'], ...extra,
  ], '/my/requests/new');
  let res = await site.postList('/my/requests', [['site_id', String(ids.site)], ['date', time.addDays(time.todayStr(), -1)], ['start_time', '10:00'], ['end_time', '14:00'], ['officers_needed', '1']], '/my/requests/new');
  assert.equal(res.status, 400, 'not in the past');
  res = await ask([['officers', String(owenId)]]);
  assert.equal(res.status, 302);
  const request = await db.get('SELECT * FROM shift_requests ORDER BY id DESC');
  assert.equal(request.status, 'pending');
  assert.equal(request.officers_needed, 2);
  assert.match(to('alex').at(-1).title, /^Shift request from Harbour Mall/);
  assert.match((await site.get('/my/requests')).text, /Waiting for approval/);
  assert.match((await site.get(`/my/schedule?month=${day.slice(0, 7)}`)).text, /Requested ×2/);
  assert.match((await admin.get('/')).text, /waiting for approval/);
  assert.match((await admin.get('/schedule/requests')).text, /Farmers market[\s\S]*Owen O\./);

  // Approved: two open shifts on the schedule, offered to Owen first (he was asked for).
  res = await admin.post(`/schedule/requests/${request.id}/approve`);
  assert.equal(res.status, 302);
  const shifts = await db.all('SELECT * FROM shifts WHERE request_id = ? ORDER BY id', request.id);
  assert.equal(shifts.length, 2);
  assert.ok(shifts.every((s) => !s.employee_id && s.status === 'scheduled'));
  const offers = await db.all("SELECT * FROM shift_offers WHERE shift_id = ANY(?::int[]) AND status = 'open'", shifts.map((s) => s.id));
  assert.equal(offers.length, 2);
  assert.match(to('owen').at(-1).title, /^Harbour Mall asked for you/);
  assert.equal(to('test').filter((m) => m.url.includes(`/my/open-shifts/${offers[0].id}`)).length, 0, 'everyone else waits');
  const minutesFirst = (Date.parse(`${offers[0].next_wave_at}:00Z`) - Date.parse(`${time.nowStr()}:00Z`)) / 60000;
  assert.ok(minutesFirst >= 115 && minutesFirst <= 121, 'first choice for up to 2 hours');
  assert.match(to('carla').at(-1).title, /^Approved:/);
  assert.match((await admin.post(`/schedule/requests/${request.id}/approve`)).location, /requests/);
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM shifts WHERE request_id = ?', request.id)).n, 2, 'approving twice makes nothing extra');
  assert.match((await site.get(`/my/schedule?month=${day.slice(0, 7)}`)).text, /Open: offered to officers/);
  assert.match((await admin.get(`/schedule?week=${time.startOfWeek(day)}`)).text, /is-offered/);

  // Owen takes one; the site hears who's coming. Both can't go to him (same time).
  const settings = await getSettings();
  assert.ok((await claimShift(offers[0].id, owenId, settings)).shift);
  assert.match(to('carla').at(-1).title, /^Covered:/);
  assert.match(to('carla').at(-1).body, /Owen O\./);
  assert.match((await claimShift(offers[1].id, owenId, settings)).error, /already booked/i);
  assert.match((await site.get('/my/requests')).text, /1 of 2 covered[\s\S]*Owen O\./);
  // After the first-choice time, everyone else is told about the other one.
  await db.run("UPDATE shift_offers SET next_wave_at = '2000-01-01T00:00' WHERE id = ?", offers[1].id);
  await require('../src/services/openShifts').advanceOffers();
  assert.ok(to('test').some((m) => m.url === `/my/open-shifts/${offers[1].id}`));
  assert.ok((await claimShift(offers[1].id, testOfficer.employee_id, settings)).shift);
  assert.match((await site.get('/my/requests')).text, /Covered/);

  // A request can also be declined (with a reason) or cancelled by the site while it waits.
  await ask();
  const second = await db.get('SELECT * FROM shift_requests ORDER BY id DESC');
  await admin.post(`/schedule/requests/${second.id}/decline`, { reason: 'No officers free that day' });
  assert.equal((await db.get('SELECT status FROM shift_requests WHERE id = ?', second.id)).status, 'declined');
  assert.match(to('carla').at(-1).body, /No officers free that day/);
  await ask();
  const third = await db.get('SELECT * FROM shift_requests ORDER BY id DESC');
  await site.post(`/my/requests/${third.id}/cancel`, {}, '/my/requests');
  assert.equal((await db.get('SELECT status FROM shift_requests WHERE id = ?', third.id)).status, 'cancelled');
  assert.equal((await site.post(`/my/requests/${second.id}/cancel`, {}, '/my/requests')).status, 302);
  assert.equal((await db.get('SELECT status FROM shift_requests WHERE id = ?', second.id)).status, 'declined', 'only waiting requests can be cancelled');
  notify.setSender(null);
});

test('repeating shift requests: one approval, offered two weeks ahead, one alert per officer; and the site sees its history', async () => {
  const notify = require('../src/services/notify');
  const { advanceOffers } = require('../src/services/openShifts');
  const { runDueJobs } = require('../src/services/jobs');
  const sent = [];
  notify.setSender(async (subscription, payload) => sent.push({ to: subscription.endpoint.split('/').pop(), ...JSON.parse(payload) }));
  const site = makeClient();
  await signIn(site, 'carla@example.com', 'client password 1');
  const carla = await db.get("SELECT id, client_id FROM users WHERE email = 'carla@example.com'");
  const owenId = (await db.get("SELECT employee_id FROM users WHERE email = 'owen@example.com'")).employee_id;
  const form = (fields) => site.postList('/my/requests', Object.entries(fields).flatMap(([k, v]) => [v].flat().map((x) => [k, String(x)])), '/my/requests/new');
  const base = { site_id: ids.site, start_time: '18:00', end_time: '06:00', officers_needed: 1 };
  const monday = time.addDays(time.startOfWeek(time.todayStr()), 7);

  // The form has the repeat box; mistakes are explained.
  assert.match((await site.get('/my/requests/new')).text, /name="repeat_days" value="0"[\s\S]*name="repeat_until"/);
  for (const [fields, message] of [
    [{ date: monday, repeat_days: [0, 2, 4], repeat_until: time.addDays(monday, -1) }, /on or after the first date/],
    [{ date: monday, repeat_days: [0, 2, 4], repeat_until: time.addDays(monday, 120) }, /up to 3 months/],
    [{ date: monday, repeat_days: [4], repeat_until: time.addDays(monday, 2) }, /None of the ticked days/],
    [{ date: monday, repeat_days: [0, 1, 2, 3, 4, 5, 6], repeat_until: time.addDays(monday, 90), officers_needed: 3 }, /Please ask for 200 or fewer/],
  ]) {
    const res = await form({ ...base, ...fields });
    assert.equal(res.status, 400, String(message));
    assert.match(res.text, message);
  }

  // Every Mon, Wed and Fri, 18:00–06:00, for five weeks (14 dates), with Owen first.
  const until = time.addDays(monday, 31); // a Thursday: weeks 1–4 (12 dates), then Mon and Wed of week 5
  let res = await form({ ...base, date: monday, repeat_days: [0, 2, 4], repeat_until: until, officers: owenId, notes: 'Night patrol' });
  assert.equal(res.status, 302);
  const request = await db.get('SELECT * FROM shift_requests ORDER BY id DESC');
  assert.equal(request.repeat_days, '0,2,4');
  assert.equal(request.repeat_until, until);
  assert.equal(request.start_at, `${monday}T18:00`);
  assert.equal(request.last_end_at, `${time.addDays(monday, 31)}T06:00`, 'the last shift: Wed of week 5, ending Thursday morning');
  assert.match(sent.at(-1).body, /^Every Mon, Wed, Fri, 18:00–06:00 \(\+1\), .* \(14 dates\) at Main entrance, 1 officer each time/);
  let page = await site.get('/my/requests');
  assert.match(page.text, /Repeats[\s\S]*Every Mon, Wed, Fri[\s\S]*Waiting for approval/);
  page = await site.get(`/my/requests/${request.id}`);
  assert.equal((page.text.match(/<span class="muted">Waiting for approval<\/span>/g) || []).length, 14, "each date listed");
  page = await admin.get('/schedule/requests');
  assert.match(page.text, /See all 14 dates[\s\S]*Approve all 14 shifts/);
  // The site's calendar shows each waiting date, not just the first.
  const lastDate = time.addDays(monday, 30);
  page = await site.get(`/my/schedule?month=${lastDate.slice(0, 7)}`);
  assert.ok((page.text.match(/Requested/g) || []).length >= (lastDate.slice(0, 7) === monday.slice(0, 7) ? 14 : 2));

  // One approval: 14 shifts on the schedule; only the next two weeks' are offered now.
  const before = sent.length;
  res = await admin.post(`/schedule/requests/${request.id}/approve`);
  assert.equal(res.status, 302);
  const shifts = await db.all('SELECT * FROM shifts WHERE request_id = ? ORDER BY start_at', request.id);
  assert.equal(shifts.length, 14);
  const horizon = `${time.addDays(time.todayStr(), 14)}T23:59`;
  const soon = shifts.filter((sh) => sh.start_at <= horizon);
  const tried = await db.all('SELECT * FROM shift_offers WHERE shift_id = ANY(?::int[])', shifts.map((sh) => sh.id));
  assert.equal(new Set(tried.map((o) => o.shift_id)).size, soon.length, 'every shift in the next two weeks, and no others');
  assert.ok(tried.every((o) => soon.some((sh) => sh.id === o.shift_id)));
  // Each officer gets one alert for all of them, not one per shift.
  const alerts = sent.slice(before).filter((m) => m.to !== 'carla');
  const perOfficer = new Map();
  for (const m of alerts) perOfficer.set(m.to, (perOfficer.get(m.to) || 0) + 1);
  assert.ok(perOfficer.size > 0, 'someone was told');
  assert.ok([...perOfficer.values()].every((n) => n === 1), 'one alert each');
  if (tried.filter((o) => o.status === 'open').length > 1) assert.ok(alerts.some((m) => /asked for you: \d+ shifts|^\d+ open shifts/.test(m.title)));
  assert.match(sent.slice(before).find((m) => m.to === 'carla').body, /about two weeks ahead/);
  assert.match((await admin.get('/schedule/requests')).text, /about two weeks before each date/);
  page = await site.get(`/my/requests/${request.id}`);
  assert.match(page.text, /Offered about two weeks ahead/);
  assert.match((await site.get('/my/requests')).text, /0 of 14 covered/);

  // Later waves that fall due together are one alert per officer too, and so is the office's "still open".
  await db.run("UPDATE shift_offers SET next_wave_at = '2000-01-01T00:00', escalate_at = '2000-01-01T00:00' WHERE shift_id = ANY(?::int[]) AND status = 'open'", shifts.map((sh) => sh.id));
  const beforeWaves = sent.length;
  await advanceOffers();
  const waveCounts = new Map();
  for (const m of sent.slice(beforeWaves)) waveCounts.set(m.to, (waveCounts.get(m.to) || 0) + 1);
  assert.ok([...waveCounts.values()].every((n) => n === 1), 'one alert each');
  const openNow = tried.filter((o) => o.status === 'open').length;
  if (openNow > 1) assert.ok(sent.slice(beforeWaves).some((m) => m.to === 'alex' && new RegExp(`^${openNow} shifts still open`).test(m.title)));

  // As dates come within two weeks, the 5-minute job offers them (once).
  const later = shifts.find((sh) => sh.start_at > horizon);
  const day = time.addDays(time.todayStr(), 3);
  await db.run('UPDATE shifts SET start_at = ?, end_at = ? WHERE id = ?', `${day}T18:00`, `${time.addDays(day, 1)}T06:00`, later.id);
  await runDueJobs();
  assert.ok(await db.get("SELECT 1 FROM shift_offers WHERE shift_id = ? AND status = 'open'", later.id));
  await runDueJobs();
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM shift_offers WHERE shift_id = ?', later.id)).n, 1, 'offered once');
  // Nobody free: it's noted once, and the office is told once.
  const another = shifts.filter((sh) => sh.start_at > horizon)[1];
  const day2 = time.addDays(time.todayStr(), 4);
  await db.run('UPDATE shifts SET start_at = ?, end_at = ? WHERE id = ?', `${day2}T18:00`, `${time.addDays(day2, 1)}T06:00`, another.id);
  await db.run("UPDATE users SET active = 0 WHERE role = 'officer'");
  const beforeNobody = sent.length;
  await runDueJobs();
  await runDueJobs();
  await db.run("UPDATE users SET active = 1 WHERE role = 'officer'");
  const marked = await db.all('SELECT * FROM shift_offers WHERE shift_id = ?', another.id);
  assert.deepEqual(marked.map((o) => [o.status, o.closed_note]), [['withdrawn', 'Nobody was free to take it']]);
  assert.equal(sent.slice(beforeNobody).filter((m) => m.to === 'alex' && /^No officer free/.test(m.title)).length, 1);
  assert.match((await site.get(`/my/requests/${request.id}`)).text, /The office is finding cover/);

  // History: every request, newest first, with page buttons; the current tab only has what's still to come.
  await site.post(`/my/requests/${request.id}/cancel`, {}, '/my/requests'); // approved already: only the office can cancel it
  assert.equal((await db.get('SELECT status FROM shift_requests WHERE id = ?', request.id)).status, 'approved');
  const old = await db.insert(
    `INSERT INTO shift_requests (client_id, site_id, requested_by, start_at, end_at, last_end_at, status, decided_at, created_at)
     VALUES (?, ?, ?, '2025-03-03T08:00', '2025-03-03T16:00', '2025-03-03T16:00', 'approved', '2025-03-01 09:00:00', '2025-03-01 08:00:00')`,
    carla.client_id, ids.site, carla.id
  );
  assert.doesNotMatch((await site.get('/my/requests')).text, new RegExp(`/my/requests/${old}"`), 'past requests leave the current tab');
  page = await site.get('/my/requests?view=history');
  assert.match(page.text, /class="active">History/);
  assert.match(page.text, new RegExp(`/my/requests/${request.id}"[\\s\\S]*/my/requests/${old}"`), 'newest first');
  assert.match(page.text, /Done/);
  for (let i = 0; i < 26; i += 1) {
    await db.run(
      `INSERT INTO shift_requests (client_id, site_id, start_at, end_at, last_end_at, status, created_at)
       VALUES (?, ?, '2025-01-06T08:00', '2025-01-06T16:00', '2025-01-06T16:00', 'cancelled', '2024-12-01 08:00:00')`,
      carla.client_id, ids.site
    );
  }
  page = await site.get('/my/requests?view=history');
  assert.match(page.text, /Older →/);
  page = await site.get('/my/requests?view=history&page=2');
  assert.match(page.text, /← Newer/);
  assert.match(page.text, /Cancelled/);
  assert.equal((await site.get(`/my/requests/${old}`)).status, 200);
  // Another client's request can't be opened.
  const otherClient = await db.insert("INSERT INTO clients (name) VALUES ('Someone Else')");
  const otherSite = await db.insert("INSERT INTO sites (client_id, name) VALUES (?, 'Their site')", otherClient);
  const theirs = await db.insert(
    "INSERT INTO shift_requests (client_id, site_id, start_at, end_at, last_end_at) VALUES (?, ?, '2030-01-01T08:00', '2030-01-01T16:00', '2030-01-01T16:00')",
    otherClient, otherSite
  );
  assert.equal((await site.get(`/my/requests/${theirs}`)).status, 404);
  assert.doesNotMatch((await site.get('/my/requests?view=history')).text, /Their site/);
  notify.setSender(null);
});

test('security: two-step codes, backup codes, remembered devices, signing out, and the office resetting it', async () => {
  const notify = require('../src/services/notify');
  const twoStep = require('../src/services/twoStep');
  notify.setSender(async () => {}); // she has notifications on: sign-in alerts go there
  const login = { email: 'olivia@example.com', password: 'officer password 1' };
  const oliviaId = (await db.get("SELECT id FROM users WHERE email = 'olivia@example.com'")).id;

  // A new phone: the password alone doesn't sign her in.
  const phone = makeClient();
  let res = await phone.post('/login', login, '/login');
  assert.equal(res.location, '/login/verify');
  assert.match((await phone.get('/my/schedule')).location, /^\/login/, 'not signed in until the code');
  res = await phone.post('/login/verify', { code: '000000' }, '/login/verify');
  assert.equal(res.status, 400);
  const code = await codeFor(login.email);
  res = await phone.post('/login/verify', { code, remember: '1' }, '/login/verify');
  assert.equal(res.location, '/my');
  const page = await phone.get('/my/schedule');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store', 'the browser never keeps signed-in pages');
  assert.match(page.text, /class="mobile-signout"/, 'a Sign out button on phones');
  assert.match((await admin.get('/activity')).text, /Signed in \(/);

  // A code only works once.
  const other = makeClient();
  await other.post('/login', login, '/login');
  assert.match((await other.post('/login/verify', { code }, '/login/verify')).text, /already used/);

  // On the remembered phone, the password is enough next time.
  await phone.post('/logout');
  assert.match((await phone.get('/my/schedule')).location, /^\/login/, 'signed out');
  assert.equal((await phone.post('/login', login, '/login')).location, '/my', 'no code on a remembered device');

  // Sensitive things ask for a fresh code: here, new backup codes.
  res = await phone.post('/account/two-step/backup-codes');
  assert.match(res.location, /^\/account\/confirm\?next=/);
  res = await phone.post('/account/confirm', { code: await codeFor(login.email), next: '/account' }, '/account/confirm?next=/account');
  assert.equal(res.location, '/account');
  res = await phone.post('/account/two-step/backup-codes');
  const backupCodes = [...res.text.matchAll(/<li><code>([a-z0-9]{4}-[a-z0-9]{4})<\/code><\/li>/g)].map((m) => m[1]);
  assert.equal(backupCodes.length, 10);

  // A backup code works once, instead of the app.
  const laptop = makeClient();
  await laptop.post('/login', login, '/login');
  res = await laptop.post('/login/verify', { code: backupCodes[0] }, '/login/verify');
  assert.equal(res.location, '/my');
  assert.match((await laptop.get('/my')).location, /\/my\/schedule/);
  const again = makeClient();
  await again.post('/login', login, '/login');
  assert.equal((await again.post('/login/verify', { code: backupCodes[0] }, '/login/verify')).status, 400);

  // Five wrong codes (counted across all devices) and signing in is blocked for 15 minutes.
  await db.run('DELETE FROM login_attempts WHERE key = ?', `code|${oliviaId}`); // the wrong codes above count too
  const guesser = makeClient();
  await guesser.post('/login', login, '/login');
  for (let i = 0; i < 4; i += 1) assert.equal((await guesser.post('/login/verify', { code: '111111' }, '/login/verify')).status, 400);
  await guesser.post('/login/verify', { code: '111111' }, '/login/verify'); // the fifth
  res = await guesser.post('/login/verify', { code: await codeFor(login.email) }, '/login');
  assert.equal(res.location, '/login', 'even the right code is refused now');
  assert.match((await admin.get('/activity')).text, /blocked after 5 wrong codes/);
  await db.run('DELETE FROM login_attempts WHERE key = ?', `code|${oliviaId}`);

  // "Sign out everywhere else" (from her first browser) signs out the phone and laptop, and forgets the phone.
  res = await officer.post('/account/sign-out-others');
  assert.equal(res.location, '/account');
  assert.match((await laptop.get('/my/schedule')).location, /^\/login/);
  assert.match((await phone.get('/my/schedule')).location, /^\/login/);
  assert.equal((await phone.post('/login', login, '/login')).location, '/login/verify', 'the phone needs a code again');
  assert.equal((await officer.get('/my/schedule')).status, 200, 'still signed in where she pressed it');

  // Lost phone: the office resets it. She's signed out, and sets it up again at her next sign-in.
  res = await admin.post(`/users/${oliviaId}/reset-two-step`);
  assert.equal(res.status, 302);
  assert.equal((await db.get('SELECT totp_enabled_at FROM users WHERE id = ?', oliviaId)).totp_enabled_at, null);
  assert.match((await officer.get('/my/schedule')).location, /^\/login/);
  await signIn(officer, login.email, login.password);
  assert.equal((await officer.get('/my/schedule')).status, 200);
  assert.ok((await db.get('SELECT totp_enabled_at FROM users WHERE id = ?', oliviaId)).totp_enabled_at);

  // An admin whose last code was over 15 minutes ago is asked again before full tax ID numbers.
  const desk = makeClient();
  await signIn(desk, 'alex@example.com', 'correct horse battery');
  await db.run("UPDATE sessions SET data = jsonb_set(data, '{codeAt}', '0'::jsonb) WHERE sid = ?", desk.sessionId());
  res = await desk.get('/tax/filing');
  assert.equal(res.location, '/account/confirm?next=%2Ftax%2Ffiling');
  res = await desk.post('/users', { name: 'Nope', email: 'nope@example.com', role: 'manager', password: 'harbor lamp violin 42', confirm: 'harbor lamp violin 42' }, '/users/new');
  assert.match(res.location, /^\/account\/confirm/);
  assert.ok(!(await db.get("SELECT 1 FROM users WHERE email = 'nope@example.com'")), 'nothing changed without the code');
  res = await desk.post('/account/confirm', { code: await codeFor('alex@example.com'), next: '/tax/filing' }, '/account/confirm?next=/tax/filing');
  assert.equal(res.location, '/tax/filing');
  assert.equal((await desk.get('/tax/filing')).status, 200);

  // However busy, everyone signs in again after 12 hours.
  await db.run("UPDATE sessions SET data = jsonb_set(data, '{signedInAt}', '0'::jsonb) WHERE sid = ?", desk.sessionId());
  assert.match((await desk.get('/')).location, /^\/login/);

  // Common passwords, and ones that are just your name, are refused.
  for (const password of ['password123', 'oliviaofficer1']) {
    res = await makeClient().post('/register', { requested_role: 'officer', name: 'Olivia Officer', email: 'olivia.second@example.com', password, confirm: password }, '/register');
    assert.equal(res.status, 400, password);
    assert.match(res.text, /too common|mostly your name/);
  }
  // Who needs it: everyone by default; the office can limit it to admins and managers.
  assert.equal(twoStep.isRequired({ role: 'officer' }, { two_step_required_for: 'everyone' }), true);
  assert.equal(twoStep.isRequired({ role: 'officer' }, { two_step_required_for: 'office' }), false);
  assert.equal(twoStep.isRequired({ role: 'manager' }, { two_step_required_for: 'office' }), true);
  assert.equal(twoStep.isRequired({ role: 'pending' }, { two_step_required_for: 'everyone' }), false);
  notify.setSender(null);
});

test('passkeys: Face ID instead of a password and code, as the second step, and the checks that keep them safe', async () => {
  const notify = require('../src/services/notify');
  const twoStep = require('../src/services/twoStep');
  notify.setSender(async () => {});
  const json = (res) => JSON.parse(res.text);
  const login = { email: 'pat@example.com', password: 'pat manager words 7' };
  let res = await admin.post('/users', { name: 'Pat Manager', ...login, role: 'manager', confirm: login.password }, '/users/new');
  assert.equal(res.status, 302);
  const patId = (await db.get("SELECT id FROM users WHERE email = 'pat@example.com'")).id;

  // Pat's first sign-in: two-step sign-in is needed, and a passkey is offered as the easy way.
  const iphone = makeAuthenticator();
  const pat = makeClient();
  await pat.post('/login', login, '/login');
  assert.equal((await pat.get('/')).location, '/account/two-step');
  assert.match((await pat.get('/account/two-step')).text, /data-passkey="register"[\s\S]*Easiest: a passkey/);
  let options = json(await pat.get('/account/passkeys/options'));
  assert.equal(options.rp.id, 'localhost');
  assert.equal(options.user.name, 'pat@example.com');
  assert.equal(Buffer.from(options.user.id, 'base64url').toString(), String(patId));
  assert.equal(options.authenticatorSelection.userVerification, 'required');
  assert.deepEqual(options.pubKeyCredParams.map((p) => p.alg), [-7, -257, -8], 'ES256 (iPhones) first');

  // Made for another website, without Face ID, or claiming the wrong kind of key: refused.
  res = await pat.post('/account/passkeys', iphone.create(options, { origin: 'https://fake-dmi.example' }), '/account/two-step');
  assert.equal(res.status, 400);
  assert.match(json(res).error, /different website/);
  options = json(await pat.get('/account/passkeys/options'));
  res = await pat.post('/account/passkeys', iphone.create(options, { uv: false }), '/account/two-step');
  assert.match(json(res).error, /Face ID, Touch ID or the device PIN/);
  options = json(await pat.get('/account/passkeys/options'));
  res = await pat.post('/account/passkeys', iphone.create(options, { site: 'fake-dmi.example' }), '/account/two-step');
  assert.match(json(res).error, /different website/);
  options = json(await pat.get('/account/passkeys/options'));
  res = await pat.post('/account/passkeys', iphone.create(options, { claim: -257 }), '/account/two-step');
  assert.match(json(res).error, /isn't supported/);
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM passkeys WHERE user_id = ?', patId)).n, 0);
  iphone.keys.clear();

  // The real thing: Face ID, and that's two-step sign-in set up, with backup codes shown once.
  options = json(await pat.get('/account/passkeys/options'));
  const answer = iphone.create(options);
  res = await pat.post('/account/passkeys', answer, '/account/two-step');
  assert.deepEqual(json(res), { redirect: '/account/backup-codes' });
  res = await pat.get('/account/backup-codes');
  const backupCodes = [...res.text.matchAll(/<li><code>([a-z0-9]{4}-[a-z0-9]{4})<\/code><\/li>/g)].map((m) => m[1]);
  assert.equal(backupCodes.length, 10);
  assert.equal((await pat.get('/account/backup-codes')).location, '/account', 'shown once');
  assert.equal((await pat.get('/')).status, 200, 'two-step sign-in is done');
  const saved = await db.get('SELECT * FROM passkeys WHERE user_id = ?', patId);
  assert.equal(saved.rp_id, 'localhost');
  assert.equal(saved.credential_id, answer.id);
  assert.equal((await db.get('SELECT totp_enabled_at FROM users WHERE id = ?', patId)).totp_enabled_at, null, 'no authenticator app needed');
  res = await pat.get('/account');
  assert.match(res.text, /id="passkeys"[\s\S]*A browser on an unknown device/);
  assert.match(res.text, /You sign in with a passkey/);
  assert.match((await admin.get('/users')).text, /On \(passkey\)/);
  // The same passkey can't be saved twice.
  options = json(await pat.get('/account/passkeys/options'));
  assert.deepEqual(options.excludeCredentials.map((c) => c.id), [answer.id], 'the phone is told it already has one');
  res = await pat.post('/account/passkeys', { ...answer, clientDataJSON: iphone.create(options).clientDataJSON }, '/account');
  assert.equal(res.status, 400);
  iphone.keys.delete([...iphone.keys.keys()][1]);

  // Signing in with just Face ID: no email, password or code.
  const phone = makeClient();
  assert.match((await phone.get('/login')).text, /autocomplete="username webauthn"[\s\S]*Sign in with a passkey/);
  options = json(await phone.get('/login/passkey/options'));
  assert.deepEqual(options.allowCredentials, [], 'any passkey this phone has for the site');
  assert.equal(options.rpId, 'localhost');
  const signedAnswer = iphone.get(options);
  res = await phone.post('/login/passkey', { ...signedAnswer, next: '/' }, '/login');
  assert.deepEqual(json(res), { redirect: '/' });
  assert.equal((await phone.get('/')).status, 200);
  assert.match((await admin.get('/activity')).text, /Signed in \([^)]*, passkey\)/);
  // iPhones always count 0, so a second sign-in works too.
  const phone2 = makeClient();
  options = json(await phone2.get('/login/passkey/options'));
  assert.deepEqual(json(await phone2.post('/login/passkey', iphone.get(options), '/login')), { redirect: '/' });

  // Someone who copied an old answer can't reuse it (the challenge is new every time and works once).
  const thief = makeClient();
  await thief.get('/login/passkey/options');
  res = await thief.post('/login/passkey', signedAnswer, '/login');
  assert.equal(res.status, 400);
  assert.match(json(res).error, /expired/);
  // Answers made for a look-alike site, without Face ID, or with a bad signature are refused.
  for (const [how, message] of [[{ origin: 'https://fake-dmi.example' }, /different website/], [{ site: 'fake-dmi.example' }, /different website/],
    [{ uv: false }, /Face ID/], [{ tamper: true }, /didn't check out/]]) {
    options = json(await thief.get('/login/passkey/options'));
    res = await thief.post('/login/passkey', iphone.get(options, how), '/login');
    assert.match(json(res).error, message);
  }
  assert.match((await thief.get('/')).location, /^\/login/, 'none of that signed them in');

  // As the second step after the password, on a computer.
  const laptop = makeClient();
  assert.equal((await laptop.post('/login', login, '/login')).location, '/login/verify');
  res = await laptop.get('/login/verify');
  assert.match(res.text, /Use my passkey/);
  assert.match(res.text, /Backup code/);
  assert.doesNotMatch(res.text, /authenticator app/, "Pat doesn't have one");
  options = json(await laptop.get('/login/passkey/options'));
  assert.deepEqual(options.allowCredentials.map((c) => c.id), [answer.id], 'only Pat\'s passkeys');
  assert.deepEqual(json(await laptop.post('/login/passkey', iphone.get(options), '/login/verify')), { redirect: '/' });
  // Someone else's passkey can't finish Olivia's sign-in.
  const mixUp = makeClient();
  await mixUp.post('/login', { email: 'olivia@example.com', password: 'officer password 1' }, '/login');
  options = json(await mixUp.get('/login/passkey/options'));
  res = await mixUp.post('/login/passkey', iphone.get(options), '/login/verify');
  assert.match(json(res).error, /isn't set up for an account here/);
  assert.match((await mixUp.get('/my/schedule')).location, /^\/login/);
  // A backup code still works instead of the passkey.
  const borrowed = makeClient();
  await borrowed.post('/login', login, '/login');
  assert.equal((await borrowed.post('/login/verify', { code: backupCodes[0] }, '/login/verify')).location, '/');

  // A security key that counts its uses: a count that doesn't go up means a copied key.
  await db.run("UPDATE sessions SET data = jsonb_set(data, '{codeAt}', '0'::jsonb) WHERE sid = ?", pat.sessionId());
  res = await pat.get('/account/passkeys/options');
  assert.equal(res.status, 403, "adding another needs a fresh confirm-it's-you");
  assert.equal(json(res).redirect, '/account/confirm?next=%2Faccount%23passkeys');
  // Confirming it's Pat with the passkey.
  res = await pat.get('/account/confirm?next=/account');
  assert.match(res.text, /data-passkey="confirm"/);
  options = json(await pat.get('/account/confirm/passkey-options'));
  assert.deepEqual(json(await pat.post('/account/confirm/passkey', { ...iphone.get(options), next: '/account' })), { redirect: '/account' });
  const key = makeAuthenticator({ counts: true });
  options = json(await pat.get('/account/passkeys/options'));
  assert.deepEqual(json(await pat.post('/account/passkeys', key.create(options))), { redirect: '/account#passkeys' }, 'no new backup codes: Pat has some');
  const desk = makeClient();
  options = json(await desk.get('/login/passkey/options'));
  assert.deepEqual(json(await desk.post('/login/passkey', key.get(options), '/login')), { redirect: '/' });
  const copy = makeClient();
  options = json(await copy.get('/login/passkey/options'));
  res = await copy.post('/login/passkey', key.get(options, { count: 6 }), '/login');
  assert.match(json(res).error, /looks like a copy/);
  // Ed25519 keys (some Android phones and security keys) work too.
  const ed = makeAuthenticator({ type: 'ed25519' });
  options = json(await pat.get('/account/passkeys/options'));
  assert.equal((await pat.post('/account/passkeys', ed.create(options))).status, 200);
  const edClient = makeClient();
  options = json(await edClient.get('/login/passkey/options'));
  assert.deepEqual(json(await edClient.post('/login/passkey', ed.get(options), '/login')), { redirect: '/' });

  // Removing passkeys: fine while another way remains; the last one stays (managers must have two-step sign-in).
  const mine = await db.all('SELECT id FROM passkeys WHERE user_id = ? ORDER BY id', patId);
  assert.equal(mine.length, 3);
  for (const p of mine.slice(1)) assert.equal((await pat.post(`/account/passkeys/${p.id}/delete`)).location, '/account#passkeys');
  await pat.post(`/account/passkeys/${mine[0].id}/delete`);
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM passkeys WHERE user_id = ?', patId)).n, 1, 'the last one is kept');
  assert.match((await pat.get('/account')).text, /your only way to do two-step sign-in/);
  // Someone else's passkey can't be removed.
  await officer.post(`/account/passkeys/${mine[0].id}/delete`);
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM passkeys WHERE user_id = ?', patId)).n, 1);

  // Lost phone: the office's reset removes passkeys too, and signs Pat out.
  await admin.post(`/users/${patId}/reset-two-step`);
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM passkeys WHERE user_id = ?', patId)).n, 0);
  assert.match((await phone.get('/')).location, /^\/login/);
  const after = makeClient();
  options = json(await after.get('/login/passkey/options'));
  assert.match(json(await after.post('/login/passkey', iphone.get(options), '/login')).error, /isn't set up/);

  assert.equal(twoStep.hasSecondStep({ totp_enabled_at: null, passkey_count: 1 }), true);
  assert.equal(twoStep.hasSecondStep({ totp_enabled_at: null, passkey_count: 0 }), false);
  await db.run("DELETE FROM login_attempts WHERE key LIKE 'passkey|%'");
  notify.setSender(null);
});

test('the demo accounts sign in with just their password (no code, no passkey), and can ask for a shift', async () => {
  const { hashPassword } = require('../src/auth');
  const twoStep = require('../src/services/twoStep');
  const exempt = await db.all('SELECT email FROM users WHERE two_step_exempt = 1 ORDER BY email');
  assert.deepEqual(exempt.map((u) => u.email), ['demo.client@example.com', 'test.officer@example.com'], 'only the two demo accounts');
  await db.run("UPDATE users SET password_hash = ? WHERE email IN ('demo.client@example.com', 'test.officer@example.com')", hashPassword('demo password for tests 9'));

  // The Demo Client: straight in after the password, even though everyone else needs two-step sign-in.
  assert.equal((await require('../src/settings').getSettings()).two_step_required_for, 'everyone');
  const demo = makeClient();
  let res = await demo.post('/login', { email: 'demo.client@example.com', password: 'demo password for tests 9' }, '/login');
  assert.equal(res.location, '/my');
  assert.equal((await demo.get('/my/schedule')).status, 200, 'no two-step setup page first');
  assert.match((await demo.get('/my/schedule')).text, /Demo Client/);
  const form = await demo.get('/my/requests/new');
  assert.equal(form.status, 200);
  assert.match(form.text, /Demo Site: Front Gate[\s\S]*Demo Site: Warehouse/);
  assert.doesNotMatch(form.text, /Harbour Mall|Northgate/, 'only its own sites');
  // It can't set up a code or a passkey, and My account says why.
  assert.equal((await demo.get('/account/two-step')).location, '/account');
  assert.equal((await demo.get('/account/passkeys/options')).location, '/account');
  assert.equal((await demo.post('/account/passkeys', { id: 'x' })).location, '/account');
  const account = await demo.get('/account');
  assert.match(account.text, /This is a demo account, so it signs in with just its password/);
  assert.doesNotMatch(account.text, /id="passkeys"/);
  assert.match((await admin.get('/users')).text, /Not needed \(demo\)/);

  // The Test Officer too, even if a code had been set up on it before.
  await db.run("UPDATE users SET totp_enabled_at = app_now() WHERE email = 'test.officer@example.com'");
  const officerDemo = makeClient();
  res = await officerDemo.post('/login', { email: 'test.officer@example.com', password: 'demo password for tests 9' }, '/login');
  assert.equal(res.location, '/my', 'no code asked for');
  assert.equal((await officerDemo.get('/my/schedule')).status, 200);
  await db.run("UPDATE users SET totp_enabled_at = NULL WHERE email = 'test.officer@example.com'");

  // Only while they're officer or client accounts: as a manager, two-step sign-in is back.
  assert.equal(twoStep.isExempt({ two_step_exempt: 1, role: 'client' }), true);
  assert.equal(twoStep.isExempt({ two_step_exempt: 1, role: 'manager' }), false);
  assert.equal(twoStep.isRequired({ two_step_exempt: 1, role: 'admin' }, { two_step_required_for: 'everyone' }), true);
  assert.equal(twoStep.isRequired({ two_step_exempt: 0, role: 'officer' }, { two_step_required_for: 'everyone' }), true);

  await db.run("UPDATE users SET active = 0 WHERE email = 'demo.client@example.com'"); // as the office would when done
  assert.match((await demo.get('/my/schedule')).location, /^\/login/);
});

test("staff positions: a dropdown of the office's five; older positions stay until changed, and are pointed out", async () => {
  const positions = ['Armed Security Officer', 'Unarmed Security Officer', 'Supervisor', 'Manager', 'Administrator'];
  let page = await admin.get('/staff/new');
  assert.deepEqual([...page.text.matchAll(/<option\s*(?:selected)?\s*>([^<]+)<\/option>/g)].map((m) => m[1]).filter((p) => positions.includes(p)), positions);
  assert.doesNotMatch(page.text, /list="positions"/, 'no free typing');
  // Only the five can be chosen.
  let res = await admin.post('/staff', { first_name: 'Pat', last_name: 'Position', position: 'Event Security', status: 'active' }, '/staff/new');
  assert.equal(res.status, 400);
  assert.match(res.text, /Choose a position from the list/);
  res = await admin.post('/staff', { first_name: 'Pat', last_name: 'Position', position: 'Armed Security Officer', status: 'active' }, '/staff/new');
  assert.equal(res.status, 302);
  assert.equal((await db.get("SELECT position FROM employees WHERE last_name = 'Position'")).position, 'Armed Security Officer');

  // Someone with an older position keeps it when their record is saved, and the Staff list points them out.
  const oldie = await db.get("SELECT * FROM employees WHERE email = 'test.officer@example.com'");
  assert.equal(oldie.position, 'Security officer', 'from before the new list');
  page = await admin.get(`/staff/${oldie.id}/edit`);
  assert.match(page.text, /<option value="Security officer" selected>Security officer \(old, please choose a new one\)/);
  res = await admin.post(`/staff/${oldie.id}`, { first_name: 'Test', last_name: 'Officer', position: 'Security officer', status: 'active' }, `/staff/${oldie.id}/edit`);
  assert.equal(res.status, 302);
  assert.equal((await db.get('SELECT position FROM employees WHERE id = ?', oldie.id)).position, 'Security officer', 'kept');
  page = await admin.get('/staff');
  assert.match(page.text, /1 active staff member has a position that isn(&#39;|')t on the list any more[\s\S]*Show them/);
  page = await admin.get('/staff?position=old&status=active');
  assert.match(page.text, /Test<\/strong>|Test Officer/);
  assert.match(page.text, /Security officer <span class="badge badge-amber">Old<\/span>/);
  assert.doesNotMatch(page.text, /Pat Position/, 'only the ones with an old position');
  // Choosing a new one clears it.
  await admin.post(`/staff/${oldie.id}`, { first_name: 'Test', last_name: 'Officer', position: 'Unarmed Security Officer', status: 'active' }, `/staff/${oldie.id}/edit`);
  assert.equal((await db.get('SELECT position FROM employees WHERE id = ?', oldie.id)).position, 'Unarmed Security Officer');
  assert.doesNotMatch((await admin.get('/staff/new')).text, /Security officer \(old/);
});

test('every main page loads', async () => {
  for (const url of ['/', '/schedule', '/timesheets?status=all', '/pay', `/pay/${ids.payRun}`, '/staff', `/staff/${ids.employee}`,
    '/clients', `/clients/${ids.client}`, '/contracts', '/training', '/training/records', '/training/sessions',
    '/training/courses', '/training/sessions/new', '/training/records/new', '/schedule/conflicts', `/schedule/${ids.shift}/cover`,
    '/timesheets/submissions', '/tax', '/tax/filing', '/users', '/settings', '/activity', '/account']) {
    const res = await admin.get(url);
    assert.equal(res.status, 200, url);
  }
});
