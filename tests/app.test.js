// End-to-end tests: start the real app with an empty, temporary database and
// use it the way a browser would. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dmi-test-'));
const app = require('../src/app');
const db = require('../src/db');
const time = require('../src/time');

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
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://localhost:${server.address().port}`;
});

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('a brand-new site sends you to the setup page', async () => {
  const res = await admin.get('/');
  assert.equal(res.status, 302);
  assert.equal(res.location, '/setup');
});

test('setup creates the first admin and signs them in', async () => {
  const _csrf = await admin.token('/setup');
  const res = await fetch(`${base}/setup`, { method: 'POST' }); // no cookie, no token
  assert.equal(res.status, 403);

  const setup = await admin.post('/setup', {
    company_name: 'Test Security',
    name: 'Alex Admin',
    email: 'alex@example.com',
    password: 'correct horse battery',
    confirm: 'correct horse battery',
    _csrf,
  }, '/setup');
  assert.equal(setup.status, 302);
  assert.equal(setup.location, '/');
  const home = await admin.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Test Security/);
});

test('forms without the security token are rejected, even when signed in', async () => {
  const res = await admin.raw('POST', '/staff', { first_name: 'X', last_name: 'Y' });
  assert.equal(res.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM employees').get().n, 0);
});

test('add a client, a site and a staff member', async () => {
  let res = await admin.post('/clients', { name: 'Harbour Mall' });
  ids.client = Number(res.location.split('/').pop());
  res = await admin.post(`/clients/${ids.client}/sites`, { name: 'Main entrance' });
  assert.equal(res.status, 302);
  ids.site = db.prepare('SELECT id FROM sites WHERE client_id = ?').get(ids.client).id;
  res = await admin.post('/staff', { first_name: 'Sam', last_name: 'Guard', hourly_rate: '30', license_required: '1', status: 'active' });
  assert.equal(res.status, 302);
  ids.employee = Number(res.location.split('/').pop());
  assert.equal(db.prepare('SELECT hourly_rate FROM employees WHERE id = ?').get(ids.employee).hourly_rate, 30);
});

test('shifts: double-booking is blocked, and "mark as worked" creates timesheet hours', async () => {
  const shift = { site_id: ids.site, employee_id: ids.employee, date: lastMonday, start_time: '08:00', end_time: '18:30', break_minutes: '30' };
  let res = await admin.post('/schedule', shift);
  assert.equal(res.status, 302);
  ids.shift = db.prepare('SELECT id FROM shifts ORDER BY id DESC').get().id;

  res = await admin.post('/schedule', { ...shift, start_time: '12:00', end_time: '20:00' });
  assert.equal(res.status, 400);
  assert.match(res.text, /already booked/);

  res = await admin.post(`/schedule/${ids.shift}/complete`);
  assert.equal(res.status, 302);
  const entry = db.prepare('SELECT * FROM time_entries WHERE shift_id = ?').get(ids.shift);
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
  const pendingIds = db.prepare("SELECT id FROM time_entries WHERE status = 'pending'").all().map((r) => r.id);
  assert.equal(pendingIds.length, 5);

  res = await admin.postList('/timesheets/bulk', [['action', 'approve'], ...pendingIds.map((id) => ['ids', String(id)])]);
  assert.equal(res.status, 302);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM time_entries WHERE status = 'approved'").get().n, 5);
});

test('pay run: overtime is calculated and finalized hours are locked', async () => {
  let res = await admin.post('/pay', { period_start: lastMonday, period_end: time.addDays(lastMonday, 6) });
  assert.equal(res.status, 302);
  ids.payRun = Number(res.location.split('/').pop());
  const item = db.prepare('SELECT * FROM pay_run_items WHERE pay_run_id = ?').get(ids.payRun);
  assert.equal(item.regular_hours, 40);
  assert.equal(item.overtime_hours, 10);
  assert.equal(item.gross_pay, 40 * 30 + 10 * 30 * 1.5);

  res = await admin.post(`/pay/${ids.payRun}/items/${item.id}`, { adjustment: '50', adjustment_note: 'Bonus' });
  assert.equal(db.prepare('SELECT gross_pay FROM pay_run_items WHERE id = ?').get(item.id).gross_pay, 1700);

  // Recalculating keeps the adjustment.
  await admin.post(`/pay/${ids.payRun}/recalculate`);
  assert.equal(db.prepare('SELECT gross_pay FROM pay_run_items WHERE pay_run_id = ?').get(ids.payRun).gross_pay, 1700);

  const csv = await admin.get(`/pay/${ids.payRun}/export.csv`);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text, /Sam Guard,.*,40,10,30,1.5,1200,450,50,Bonus,1700/);

  // Rejecting hours after the draft was made: the page warns, and finalizing leaves them out.
  const lastEntry = db.prepare('SELECT id FROM time_entries WHERE pay_run_id = ? ORDER BY start_at DESC').get(ids.payRun).id;
  await admin.post(`/timesheets/${lastEntry}/reject`);
  assert.match((await admin.get(`/pay/${ids.payRun}`)).text, /no longer approved/);

  res = await admin.post(`/pay/${ids.payRun}/finalize`);
  assert.equal(db.prepare('SELECT status FROM pay_runs WHERE id = ?').get(ids.payRun).status, 'finalized');
  assert.equal(db.prepare('SELECT gross_pay FROM pay_run_items WHERE pay_run_id = ?').get(ids.payRun).gross_pay, 40 * 30 + 50);
  assert.equal(db.prepare('SELECT pay_run_id FROM time_entries WHERE id = ?').get(lastEntry).pay_run_id, null);

  res = await admin.post(`/timesheets/${ids.entry}/delete`);
  assert.ok(db.prepare('SELECT 1 FROM time_entries WHERE id = ?').get(ids.entry), 'paid hours must not be deleted');
  res = await admin.post(`/pay/${ids.payRun}/delete`);
  assert.ok(db.prepare('SELECT 1 FROM pay_runs WHERE id = ?').get(ids.payRun), 'finalized pay runs must not be deleted');
});

test('managers cannot see pay, and cannot change pay rates', async () => {
  let res = await admin.post('/users', { name: 'Morgan Manager', email: 'morgan@example.com', role: 'manager', password: 'another long password', confirm: 'another long password' });
  assert.equal(res.status, 302);

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
  assert.equal(db.prepare('SELECT hourly_rate FROM employees WHERE id = ?').get(ids.employee).hourly_rate, 30);
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
  const courseId = db.prepare('SELECT id FROM training_courses').get().id;

  res = await admin.postFile('/training/records', { employee_id: String(ids.employee), course_id: String(courseId), completed_on: '2026-01-31' }, null, '/training/records/new');
  assert.equal(res.status, 302);
  assert.equal(db.prepare('SELECT expires_on FROM training_records').get().expires_on, '2029-01-31');

  res = await admin.post('/training/sessions', { course_id: courseId, date: time.addDays(time.todayStr(), 3), start_time: '09:00' });
  const sessionId = Number(res.location.split('/').pop());
  await admin.post(`/training/sessions/${sessionId}/attendees`, { employee_id: ids.employee });
  res = await admin.post(`/training/sessions/${sessionId}/complete`, { attended: ids.employee });
  assert.equal(res.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM training_records WHERE employee_id = ?').get(ids.employee).n, 2);
  assert.equal(db.prepare('SELECT status FROM training_sessions WHERE id = ?').get(sessionId).status, 'completed');
});

test('every main page loads', async () => {
  for (const url of ['/', '/schedule', '/timesheets?status=all', '/pay', `/pay/${ids.payRun}`, '/staff', `/staff/${ids.employee}`,
    '/clients', `/clients/${ids.client}`, '/contracts', '/training', '/training/records', '/training/sessions',
    '/training/courses', '/users', '/settings', '/activity', '/account']) {
    const res = await admin.get(url);
    assert.equal(res.status, 200, url);
  }
});
