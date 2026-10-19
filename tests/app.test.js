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

test('a test officer account comes with the database, but setup still needs an admin first', async () => {
  const account = await db.get("SELECT * FROM users WHERE email = 'test.officer@example.com'");
  assert.equal(account.role, 'officer');
  const employee = await db.get('SELECT * FROM employees WHERE id = ?', account.employee_id);
  assert.equal(`${employee.first_name} ${employee.last_name}`, 'Test Officer');
  assert.match(account.password_hash, /^scrypt\$/);
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

// A tiny valid PNG picture, standing in for a drawn signature.
const SIGNATURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const officer = makeClient();
const signIn = async (client, email, password) => client.post('/login', { email, password }, '/login');

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
  assert.equal((await client.get('/my/timesheets')).status, 403, 'timesheets are for officers');
  assert.equal((await client.get('/staff')).location, '/my');
});

test('officer timesheet: sending it saves hours for approval and the filled-in DMI PDF', async () => {
  const { periodStartFor } = require('../src/services/officerTimesheet');
  const period = time.addDays(periodStartFor(time.todayStr()), -14);
  const monday = time.addDays(period, 1);
  await admin.post('/schedule', { site_id: ids.site, employee_id: ids.officer, date: monday, start_time: '08:00', end_time: '16:00', break_minutes: '0' });

  const form = await officer.get(`/my/timesheets/new?period=${period}`);
  assert.equal(form.status, 200);
  assert.match(form.text, /Officer, Olivia/);
  assert.match((await officer.get(`/my/timesheets/new?period=${period}&fill=schedule`)).text, /value="0800"/, 'can start from the schedule');

  const sheet = { period, phone: '555-0100', location: 'Harbour Mall', in_1: '0800', out_1: '1600', comment_1: 'Main gate', in_2: '2200', out_2: '0600', confirm: '1' };
  let res = await officer.post('/my/timesheets', sheet);
  assert.equal(res.status, 400);
  assert.match(res.text, /sign in the signature box/);
  res = await officer.post('/my/timesheets', { ...sheet, out_2: '2500', signature: SIGNATURE });
  assert.equal(res.status, 400);
  assert.match(res.text, /Check the clock times/);

  res = await officer.post('/my/timesheets', { ...sheet, signature: SIGNATURE });
  assert.equal(res.status, 302);
  const submission = await db.get("SELECT * FROM timesheet_submissions WHERE employee_id = ? AND status = 'submitted'", ids.officer);
  assert.equal(submission.total_hours, 16);
  const entries = await db.all('SELECT * FROM time_entries WHERE submission_id = ? ORDER BY start_at', submission.id);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.status === 'pending'));
  assert.equal(entries[0].site_id, ids.site, 'linked to the scheduled shift');
  assert.equal((await db.get('SELECT status FROM shifts WHERE id = ?', entries[0].shift_id)).status, 'completed');
  assert.equal(entries[1].end_at, `${time.addDays(period, 3)}T06:00`, 'an overnight shift ends the next day');

  const pdf = await officer.get(`/my/timesheets/${submission.id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.ok(pdf.text.startsWith('%PDF'));
  const office = await admin.get('/timesheets/submissions');
  assert.match(office.text, /Olivia Officer/);
  assert.ok((await admin.get(`/timesheets/submissions/${submission.id}/pdf`)).text.startsWith('%PDF'));
  assert.match((await admin.get('/timesheets')).text, /Officer&#39;s PDF|Officer's PDF/);

  // Sending again replaces the earlier one (while the office hasn't checked it).
  res = await officer.post('/my/timesheets', { ...sheet, in_1: '0900', out_1: '1700', in_2: '', out_2: '', signature: SIGNATURE });
  assert.equal(res.status, 302);
  assert.equal((await db.get('SELECT status FROM timesheet_submissions WHERE id = ?', submission.id)).status, 'replaced');
  const current = await db.all('SELECT * FROM time_entries WHERE employee_id = ?', ids.officer);
  assert.equal(current.length, 1);

  // Once the office approves it, it can't be changed from the officer's side.
  await admin.post(`/timesheets/${current[0].id}/approve`);
  res = await officer.post('/my/timesheets', { ...sheet, signature: SIGNATURE });
  assert.equal(res.status, 400);
  assert.match(res.text, /already checked/);
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

test('approved timesheets: the officer views or downloads the approved copy in their account', async () => {
  // The earlier approval made the approved copy.
  const submission = await db.get("SELECT * FROM timesheet_submissions WHERE employee_id = ? AND status = 'submitted' AND approved_at IS NOT NULL", ids.officer);
  assert.ok(submission.approved_file_name);
  assert.notEqual(submission.approved_file_name, submission.file_name);
  const list = await officer.get('/my/timesheets');
  assert.match(list.text, /Approved copy · Alex Admin/);
  assert.match(list.text, new RegExp(`/my/timesheets/${submission.id}/pdf\\?download=1`));

  // "View" opens it in the browser; "Download" saves it.
  let res = await officer.get(`/my/timesheets/${submission.id}/pdf`);
  assert.equal(res.status, 200);
  assert.ok(res.text.startsWith('%PDF'));
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /^inline; filename=".*_approved\.pdf"/);
  res = await officer.get(`/my/timesheets/${submission.id}/pdf?download=1`);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="?.*_approved\.pdf/);

  // Nobody else can open it.
  const client = makeClient();
  await signIn(client, 'carla@example.com', 'client password 1');
  assert.equal((await client.get(`/my/timesheets/${submission.id}/pdf`)).status, 403);
  assert.equal((await makeClient().get(`/my/timesheets/${submission.id}/pdf`)).status, 302, 'needs a login');

  // The approved copy is made when the LAST waiting day is checked.
  const { periodStartFor } = require('../src/services/officerTimesheet');
  const period = time.addDays(periodStartFor(time.todayStr()), -28);
  res = await officer.post('/my/timesheets', { period, in_1: '0800', out_1: '1600', in_2: '0800', out_2: '1200', confirm: '1', signature: SIGNATURE });
  assert.equal(res.status, 302);
  const sheet = await db.get("SELECT * FROM timesheet_submissions WHERE employee_id = ? AND period_start = ? AND status = 'submitted'", ids.officer, period);
  const [first, second] = await db.all('SELECT id FROM time_entries WHERE submission_id = ? ORDER BY start_at', sheet.id);
  await admin.post(`/timesheets/${first.id}/approve`);
  assert.equal((await db.get('SELECT approved_file_name FROM timesheet_submissions WHERE id = ?', sheet.id)).approved_file_name, null, 'not while a day is still waiting');
  assert.match((await officer.get(`/my/timesheets/${sheet.id}/pdf`)).headers.get('content-disposition'), /filename="[^"]*\d\.pdf"/, 'until then, the copy they signed');
  res = await admin.post(`/timesheets/${second.id}/reject`);
  const done = await db.get('SELECT * FROM timesheet_submissions WHERE id = ?', sheet.id);
  assert.ok(done.approved_file_name, 'one day approved and one rejected still counts as checked');
  assert.match((await admin.get(res.location)).text, /now fully approved/);
  assert.match((await admin.get('/timesheets/submissions')).text, /View approved copy/);
  res = await admin.get(`/timesheets/submissions/${sheet.id}/approved-pdf`);
  assert.match(res.headers.get('content-disposition'), /^inline;/);
  assert.ok(res.text.startsWith('%PDF'));
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
