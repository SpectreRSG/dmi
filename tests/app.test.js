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
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM users')).n, 0);

  const setup = await admin.post('/setup', { ...form, setup_code: 'test-setup-code' }, '/setup');
  assert.equal(setup.status, 302);
  assert.equal(setup.location, '/');
  const home = await admin.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Test Security/);
});

test('forms without the security token are rejected, even when signed in', async () => {
  const res = await admin.raw('POST', '/staff', { first_name: 'X', last_name: 'Y' });
  assert.equal(res.status, 403);
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM employees')).n, 0);
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

test('shifts: double-booking is blocked, and "mark as worked" creates timesheet hours', async () => {
  const shift = { site_id: ids.site, employee_id: ids.employee, date: lastMonday, start_time: '08:00', end_time: '18:30', break_minutes: '30' };
  let res = await admin.post('/schedule', shift);
  assert.equal(res.status, 302);
  ids.shift = (await db.get('SELECT id FROM shifts ORDER BY id DESC')).id;

  res = await admin.post('/schedule', { ...shift, start_time: '12:00', end_time: '20:00' });
  assert.equal(res.status, 400);
  assert.match(res.text, /already booked/);

  res = await admin.post(`/schedule/${ids.shift}/complete`);
  assert.equal(res.status, 302);
  const entry = await db.get('SELECT * FROM time_entries WHERE shift_id = ?', ids.shift);
  assert.equal(entry.status, 'pending');
  assert.equal(entry.end_at, `${lastMonday}T18:30`);
  ids.entry = entry.id;
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
  const pendingIds = (await db.all("SELECT id FROM time_entries WHERE status = 'pending'")).map((r) => r.id);
  assert.equal(pendingIds.length, 5);

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
  const _csrf = await manager.token('/login');
  res = await manager.post('/login', { email: 'morgan@example.com', password: 'another long password', _csrf }, '/login');
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

test('every main page loads', async () => {
  for (const url of ['/', '/schedule', '/timesheets?status=all', '/pay', `/pay/${ids.payRun}`, '/staff', `/staff/${ids.employee}`,
    '/clients', `/clients/${ids.client}`, '/contracts', '/training', '/training/records', '/training/sessions',
    '/training/courses', '/users', '/settings', '/activity', '/account']) {
    const res = await admin.get(url);
    assert.equal(res.status, 200, url);
  }
});
