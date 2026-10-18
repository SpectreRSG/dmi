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

test('portal: a passphrase shows the right month, can be replaced or turned off, and guesses are limited', async () => {
  const month = ids.conflictDay.slice(0, 7);
  const makePassphrase = async (form) => {
    const res = await admin.post('/portal-access', form, '/portal-access');
    assert.equal(res.status, 200);
    return res.text.match(/class="passphrase"[^>]*>([^<]+)</)[1].trim();
  };
  const signIn = async (client, passphrase) => client.post('/portal', { passphrase }, '/portal');

  const officerPhrase = await makePassphrase({ scope: 'employee', employee_id: ids.employee, label: 'Phone' });
  assert.match(officerPhrase, /^[a-z]+-[a-z]+-[a-z]+-\d{2}$/);
  const row = await db.get('SELECT * FROM portal_access WHERE employee_id = ?', ids.employee);
  assert.notEqual(row.passphrase_hash, officerPhrase, 'only a fingerprint is stored');

  const officer = makeClient();
  assert.match((await officer.get('/portal')).text, /Passphrase/);
  let res = await signIn(officer, 'not-the-right-one-12');
  assert.equal(res.status, 400);
  res = await signIn(officer, `  ${officerPhrase.toUpperCase().replaceAll('-', ' ')} `);
  assert.equal(res.status, 302);
  res = await officer.get(`/portal?month=${month}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Sam Guard/);
  assert.match(res.text, /Main entrance/);
  assert.match(res.text, /First Aid training/);
  assert.doesNotMatch(res.text, /\$/, 'no pay shown');
  assert.equal((await officer.get('/schedule')).status, 302, 'the portal is not a login to the admin site');
  assert.ok((await db.get('SELECT last_used_at FROM portal_access WHERE id = ?', row.id)).last_used_at);

  // A site passphrase shows everyone at the site, with short names.
  const sitePhrase = await makePassphrase({ scope: 'site', site_id: ids.site });
  const client = makeClient();
  await signIn(client, sitePhrase);
  res = await client.get(`/portal?month=${month}`);
  assert.match(res.text, /Sam G\./);
  assert.match(res.text, /Jo B\./);
  assert.doesNotMatch(res.text, /Sam Guard/);

  // A new passphrase signs out anyone using the old one.
  res = await admin.post(`/portal-access/${row.id}/regenerate`, {}, '/portal-access');
  const newPhrase = res.text.match(/class="passphrase"[^>]*>([^<]+)</)[1].trim();
  assert.match((await officer.get('/portal')).text, /Type the passphrase/);
  assert.equal((await signIn(officer, officerPhrase)).status, 400);
  assert.equal((await signIn(officer, newPhrase)).status, 302);

  // Turned off: stops working straight away.
  await admin.post(`/portal-access/${row.id}/delete`, {}, '/portal-access');
  assert.match((await officer.get('/portal')).text, /Type the passphrase/);
  assert.equal((await signIn(officer, newPhrase)).status, 400);

  // Too many wrong guesses from one address: locked out for a while.
  const guesser = makeClient();
  for (let i = 0; i < 6 && res.status !== 429; i += 1) res = await signIn(guesser, `wrong-guess-${i}`);
  assert.equal(res.status, 429);
  assert.equal((await signIn(guesser, sitePhrase)).status, 429, 'even the right passphrase waits');
});

test('every main page loads', async () => {
  for (const url of ['/', '/schedule', '/timesheets?status=all', '/pay', `/pay/${ids.payRun}`, '/staff', `/staff/${ids.employee}`,
    '/clients', `/clients/${ids.client}`, '/contracts', '/training', '/training/records', '/training/sessions',
    '/training/courses', '/training/sessions/new', '/training/records/new', '/schedule/conflicts', `/schedule/${ids.shift}/cover`,
    '/portal-access', '/users', '/settings', '/activity', '/account']) {
    const res = await admin.get(url);
    assert.equal(res.status, 200, url);
  }
});
