// Fills an EMPTY database with realistic demo data so you can explore the site.
// Run it with:  npm run seed
// To start again from scratch, stop the app and delete the "data" folder.
const crypto = require('crypto');
const db = require('../src/db');
const time = require('../src/time');
const { hashPassword } = require('../src/auth');
const { calculatePayLine } = require('../src/services/payroll');
const { getSettings, saveSettings } = require('../src/settings');

if (db.prepare('SELECT 1 FROM employees LIMIT 1').get()) {
  console.log('The database already has staff in it, so demo data was NOT added.');
  console.log('To start fresh, stop the app, delete the "data" folder, and run this again.');
  process.exit(0);
}

const today = time.todayStr();
const now = time.nowStr();
const day = (offset) => time.addDays(today, offset);
const thisMonday = time.startOfWeek(today);

// ---- Login ----------------------------------------------------------------------
let adminLogin = null;
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const password = crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Demo Admin', 'admin@example.com', ?, 'admin')").run(
    hashPassword(password)
  );
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Demo Manager', 'manager@example.com', ?, 'manager')").run(
    hashPassword(password)
  );
  adminLogin = password;
  saveSettings({ company_name: 'DMI Security' });
}
const adminId = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get().id;

const insert = (table, row) => {
  const cols = Object.keys(row);
  return db
    .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`)
    .run(row).lastInsertRowid;
};

db.transaction(() => {
  // ---- Training courses ---------------------------------------------------------
  const course = {
    firstAid: insert('training_courses', { name: 'First Aid & CPR', description: 'Provide first aid, including CPR and defibrillator use.', validity_months: 36, required: 1 }),
    fire: insert('training_courses', { name: 'Fire Warden', description: 'Evacuation procedures and fire equipment.', validity_months: 24, required: 1 }),
    induction: insert('training_courses', { name: 'Health & Safety Induction', description: 'Company policies and site safety.', validity_months: null, required: 1 }),
    conflict: insert('training_courses', { name: 'Conflict De-escalation', description: 'Managing aggressive behaviour safely.', validity_months: 24, required: 0 }),
    baton: insert('training_courses', { name: 'Baton & Handcuff', description: 'Use of restraints (where licensed).', validity_months: 12, required: 0 }),
  };

  // ---- Staff --------------------------------------------------------------------
  const people = [
    ['James', 'Carter', 'Supervisor', 'Full-time', 38, day(640)],
    ['Aisha', 'Rahman', 'Senior Security Officer', 'Full-time', 34, day(20)],
    ['Michael', "O'Brien", 'Security Officer', 'Full-time', 30, day(410)],
    ['Sofia', 'Martinez', 'Security Officer', 'Part-time', 30, day(530)],
    ['Daniel', 'Kim', 'Mobile Patrol Officer', 'Full-time', 32, day(-5)],
    ['Grace', 'Thompson', 'Security Officer', 'Casual', 33, day(300)],
    ['Liam', 'Walker', 'Event Security', 'Casual', 31, day(220)],
    ['Priya', 'Patel', 'Control Room Operator', 'Full-time', 31, day(700)],
    ['Tom', 'Nguyen', 'Security Officer', 'Part-time', 29, day(150)],
  ];
  const guards = people.map(([first_name, last_name, position, employment_type, hourly_rate, license_expiry], i) => {
    const id = insert('employees', {
      first_name,
      last_name,
      position,
      employment_type,
      hourly_rate,
      license_expiry,
      license_number: `SL-${40213 + i * 137}`,
      email: `${first_name.toLowerCase()}.${last_name.toLowerCase().replace(/[^a-z]/g, '')}@example.com`,
      phone: `0400 ${String(100 + i * 37).padStart(3, '0')} ${String(200 + i * 53).padStart(3, '0')}`,
      start_date: day(-900 + i * 60),
      emergency_contact_name: 'Next of kin',
      emergency_contact_phone: '0400 000 000',
    });
    return { id, first_name, last_name };
  });
  const hannah = insert('employees', { first_name: 'Hannah', last_name: 'Lee', position: 'Office Staff', employment_type: 'Part-time', hourly_rate: 28, license_required: 0, start_date: day(-400), email: 'hannah.lee@example.com' });
  insert('training_records', { employee_id: hannah, course_id: course.induction, completed_on: day(-395), provider: 'In-house' });
  insert('training_records', { employee_id: hannah, course_id: course.fire, completed_on: day(-180), expires_on: time.addMonths(day(-180), 24), provider: 'In-house' });
  insert('employees', { first_name: 'Mark', last_name: 'Davies', position: 'Security Officer', employment_type: 'Casual', hourly_rate: 29, status: 'inactive', start_date: day(-800), end_date: day(-120), license_number: 'SL-39001', license_expiry: day(-30) });

  // ---- Training records (with a few gaps on purpose) -----------------------------
  guards.forEach((g, i) => {
    if (g.first_name !== 'Tom') {
      const done = g.first_name === 'Grace' ? time.addMonths(day(12), -36) : day(-200 - i * 40);
      insert('training_records', { employee_id: g.id, course_id: course.firstAid, completed_on: done, expires_on: time.addMonths(done, 36), provider: 'Safe Hands Training', certificate_number: `FA-${7000 + i}` });
    }
    const fireDone = g.first_name === 'Liam' ? day(-760) : day(-100 - i * 25);
    insert('training_records', { employee_id: g.id, course_id: course.fire, completed_on: fireDone, expires_on: time.addMonths(fireDone, 24), provider: 'In-house' });
    insert('training_records', { employee_id: g.id, course_id: course.induction, completed_on: day(-880 + i * 60), provider: 'In-house' });
    if (i % 2 === 0) {
      insert('training_records', { employee_id: g.id, course_id: course.conflict, completed_on: day(-300 + i * 10), expires_on: time.addMonths(day(-300 + i * 10), 24), provider: 'Safe Hands Training' });
    }
  });

  const session = insert('training_sessions', { course_id: course.firstAid, starts_at: `${day(9)}T09:00`, location: 'Head office training room', trainer: 'Safe Hands Training', capacity: 8 });
  for (const g of guards.filter((x) => ['Tom', 'Grace'].includes(x.first_name))) {
    insert('training_attendees', { session_id: session, employee_id: g.id });
  }

  // ---- Clients, sites and contracts ----------------------------------------------
  const harbour = insert('clients', { name: 'Harbour Mall', contact_name: 'Rebecca Shaw', contact_email: 'centre.manager@harbourmall.example', contact_phone: '02 5550 1100', address: '1 Harbour St' });
  const northgate = insert('clients', { name: 'Northgate Logistics', contact_name: 'Peter Wills', contact_email: 'ops@northgate.example', contact_phone: '02 5550 2200', address: '45 Industrial Rd' });
  const riverside = insert('clients', { name: 'Riverside Medical Centre', contact_name: 'Dr. Anna Cole', contact_email: 'facilities@riverside.example', contact_phone: '02 5550 3300', address: '9 River Pde' });
  const bayside = insert('clients', { name: 'Bayside Events Co.', contact_name: 'Marcus Bell', contact_email: 'bookings@bayside.example', contact_phone: '02 5550 4400', address: '200 Waterfront Way' });

  const site = {
    mallEntrance: insert('sites', { client_id: harbour, name: 'Main entrance', address: '1 Harbour St', instructions: 'Sign in at the centre management office. Radio channel 3.' }),
    mallCarPark: insert('sites', { client_id: harbour, name: 'Car park patrol', address: '1 Harbour St (levels P1–P4)', instructions: 'Patrol every hour. Log incidents in the car park book.' }),
    warehouse: insert('sites', { client_id: northgate, name: 'Warehouse 3', address: '45 Industrial Rd', instructions: 'Gate code changes weekly – ask the supervisor.' }),
    ed: insert('sites', { client_id: riverside, name: 'Emergency department', address: '9 River Pde', instructions: 'Report to the nurse unit manager on arrival.' }),
    arena: insert('sites', { client_id: bayside, name: 'Waterfront Arena', address: '200 Waterfront Way', instructions: 'Event briefing 30 minutes before start.' }),
  };

  insert('contracts', { title: 'Static guarding – Harbour Mall', contract_type: 'Client service agreement', party_type: 'client', client_id: harbour, status: 'active', signed_on: day(-345), start_date: day(-340), end_date: day(25), value: 480000, notes: '90 days notice to renew. Rates reviewed annually.' });
  insert('contracts', { title: 'Night patrol – Northgate Logistics', contract_type: 'Client service agreement', party_type: 'client', client_id: northgate, status: 'active', signed_on: day(-125), start_date: day(-120), end_date: day(245), value: 210000 });
  insert('contracts', { title: 'Concierge security – Riverside Medical', contract_type: 'Client service agreement', party_type: 'client', client_id: riverside, status: 'active', signed_on: day(-60), start_date: day(-55), end_date: day(420), value: 96000 });
  insert('contracts', { title: 'Event security – 2026 season', contract_type: 'Client service agreement', party_type: 'client', client_id: bayside, status: 'active', start_date: day(-200), end_date: day(75), value: 58000 });
  insert('contracts', { title: 'CCTV maintenance subcontract', contract_type: 'Subcontractor agreement', party_type: 'other', other_party: 'Apex CCTV Installations', status: 'active', start_date: day(-375), end_date: day(-10) });
  insert('contracts', { title: 'Mutual NDA – Riverside Medical', contract_type: 'Non-disclosure agreement', party_type: 'client', client_id: riverside, status: 'active', signed_on: day(-60), start_date: day(-60) });
  for (const g of guards.slice(0, 4)) {
    insert('contracts', { title: `Employment contract – ${g.first_name} ${g.last_name}`, contract_type: 'Employment contract', party_type: 'employee', employee_id: g.id, status: 'active', signed_on: day(-800), start_date: day(-790) });
  }

  // ---- Roster: 3 weeks back to 2 weeks ahead -------------------------------------
  // Each "post" is a regular shift at a site. weekdays: 0 = Monday … 6 = Sunday.
  const posts = [
    { site: site.mallEntrance, start: '07:00', end: '19:00', brk: 30, weekdays: [0, 1, 2, 3, 4, 5, 6] },
    { site: site.mallCarPark, start: '19:00', end: '07:00', brk: 30, weekdays: [0, 1, 2, 3, 4, 5, 6] },
    { site: site.warehouse, start: '18:00', end: '06:00', brk: 30, weekdays: [0, 1, 2, 3, 4] },
    { site: site.ed, start: '08:00', end: '16:00', brk: 30, weekdays: [0, 1, 2, 3, 4] },
    { site: site.arena, start: '15:00', end: '23:30', brk: 0, weekdays: [5] },
    { site: site.arena, start: '15:00', end: '23:30', brk: 0, weekdays: [5] },
  ];
  const rosterGuards = guards.filter((g) => g.first_name !== 'Priya'); // Priya works in the control room
  const booked = new Map(rosterGuards.map((g) => [g.id, []]));
  const restMinutes = 10 * 60;
  const toMinutes = (dt) => time.hoursBetween('2000-01-01T00:00', dt) * 60;
  let turn = 0;

  const pickGuard = (startAt, endAt) => {
    for (let tries = 0; tries < rosterGuards.length; tries += 1) {
      const g = rosterGuards[(turn + tries) % rosterGuards.length];
      const clash = booked.get(g.id).some(([s, e]) => toMinutes(startAt) < e + restMinutes && toMinutes(endAt) + restMinutes > s);
      const weekCount = booked.get(g.id).filter(([s]) => s >= toMinutes(`${time.startOfWeek(startAt.slice(0, 10))}T00:00`)).length;
      if (!clash && weekCount < 5) {
        turn = (turn + tries + 1) % rosterGuards.length;
        booked.get(g.id).push([toMinutes(startAt), toMinutes(endAt)]);
        return g;
      }
    }
    return null;
  };

  const shifts = [];
  for (let week = -3; week <= 2; week += 1) {
    for (let d = 0; d < 7; d += 1) {
      const date = time.addDays(thisMonday, week * 7 + d);
      for (const post of posts) {
        if (!post.weekdays.includes(d)) continue;
        const range = time.buildRange(date, post.start, post.end);
        const guard = pickGuard(range.start_at, range.end_at);
        shifts.push({ ...range, site_id: post.site, employee_id: guard?.id ?? null, break_minutes: post.brk, week });
      }
    }
  }
  // Leave a few future shifts unfilled so the dashboard has something to show.
  shifts.filter((s) => s.week >= 0 && s.start_at > now).filter((_, i) => i % 11 === 5).forEach((s) => {
    s.employee_id = null;
  });

  // Hours worked: older weeks approved (and paid), last week approved, this week pending.
  const payStart = time.addDays(thisMonday, -21);
  const payEnd = time.addDays(thisMonday, -8);
  const payRun = insert('pay_runs', { period_start: payStart, period_end: payEnd, status: 'finalized', created_by: adminId, finalized_at: `${time.addDays(thisMonday, -6)} 10:15:00`, notes: 'Demo pay run' });
  let leftForMarking = 2;

  for (const s of shifts) {
    const finished = s.end_at <= now;
    const status = finished && s.employee_id ? 'completed' : 'scheduled';
    const { week, ...row } = s;
    // Leave the last couple of finished shifts un-marked so "Mark as worked" can be tried.
    const keepScheduled = finished && s.employee_id && week === 0 && leftForMarking > 0 && s.end_at > `${day(-1)}T00:00`;
    if (keepScheduled) leftForMarking -= 1;
    const shiftId = insert('shifts', { ...row, status: keepScheduled ? 'scheduled' : status });
    if (!finished || !s.employee_id || keepScheduled) continue;
    const entryStatus = week <= -1 ? 'approved' : 'pending';
    insert('time_entries', {
      employee_id: s.employee_id,
      site_id: s.site_id,
      shift_id: shiftId,
      start_at: s.start_at,
      end_at: s.end_at,
      break_minutes: s.break_minutes,
      status: entryStatus,
      approved_by: entryStatus === 'approved' ? adminId : null,
      approved_at: entryStatus === 'approved' ? `${time.addDays(s.start_at.slice(0, 10), 2)} 09:00:00` : null,
      pay_run_id: week <= -2 ? payRun : null,
    });
  }

  // Priya's control-room hours (not tied to a client site).
  const priya = guards.find((g) => g.first_name === 'Priya');
  for (let date = payStart; date < today; date = time.addDays(date, 1)) {
    const isWeekend = time.daysBetween(time.startOfWeek(date), date) >= 5;
    if (isWeekend) continue;
    const week = Math.floor(time.daysBetween(thisMonday, date) / 7);
    insert('time_entries', {
      employee_id: priya.id,
      start_at: `${date}T09:00`,
      end_at: `${date}T17:30`,
      break_minutes: 30,
      notes: 'Control room',
      status: week <= -1 ? 'approved' : 'pending',
      approved_by: week <= -1 ? adminId : null,
      approved_at: week <= -1 ? `${date} 18:00:00` : null,
      pay_run_id: week <= -2 ? payRun : null,
    });
  }

  // Work out the numbers for the finalized demo pay run.
  const settings = getSettings();
  const paid = db.prepare('SELECT * FROM time_entries WHERE pay_run_id = ? ORDER BY employee_id, start_at').all(payRun);
  const byEmployee = new Map();
  for (const e of paid) byEmployee.set(e.employee_id, [...(byEmployee.get(e.employee_id) || []), e]);
  for (const [employeeId, entries] of byEmployee) {
    const { hourly_rate } = db.prepare('SELECT hourly_rate FROM employees WHERE id = ?').get(employeeId);
    const line = calculatePayLine({ entries, hourlyRate: hourly_rate, weeklyLimit: settings.overtime_weekly_hours, multiplier: settings.overtime_multiplier });
    insert('pay_run_items', { pay_run_id: payRun, employee_id: employeeId, ...line });
  }

  db.prepare('INSERT INTO activity_log (user_id, action) VALUES (?, ?)').run(adminId, 'Loaded demo data');
})();

console.log('Demo data added.');
if (adminLogin) {
  console.log('');
  console.log('Sign in with:');
  console.log(`  Admin:   admin@example.com   / ${adminLogin}`);
  console.log(`  Manager: manager@example.com / ${adminLogin}`);
  console.log('(Write this down – it is only shown once. You can change it under "My account".)');
}
