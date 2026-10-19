// Fills an EMPTY local database with realistic demo data so you can explore the site.
// Run it with:  npm run seed   (stop the app first if it's running)
// To start again from scratch, stop the app and delete the "data" folder.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { startLocalDatabase } = require('./local-db');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

async function main() {
  let localDb = null;
  if (!process.env.DATABASE_URL) {
    const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
    localDb = await startLocalDatabase({ directory: path.join(dataDir, 'pg') });
    process.env.DATABASE_URL = localDb.url;
  }
  // These read DATABASE_URL when loaded, so they're loaded after it is set.
  const db = require('../src/db');
  try {
    await seed(db);
  } finally {
    await db.close();
    await localDb?.stop();
  }
}

async function seed(db) {
  const time = require('../src/time');
  const { hashPassword } = require('../src/auth');
  const { calculatePayLine } = require('../src/services/payroll');
  const { getSettings, saveSettings } = require('../src/settings');

  if (await db.get('SELECT 1 FROM clients LIMIT 1')) {
    console.log('The database already has clients in it, so demo data was NOT added.');
    console.log('To start fresh, stop the app, delete the "data" folder, and run this again.');
    return;
  }

  // ---- Login ----------------------------------------------------------------------
  let adminLogin = null;
  if (!(await db.get("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1"))) {
    const password = crypto.randomBytes(9).toString('base64url');
    await db.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Demo Admin', 'admin@example.com', ?, 'admin')", hashPassword(password));
    await db.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Demo Manager', 'manager@example.com', ?, 'manager')", hashPassword(password));
    adminLogin = password;
    await saveSettings({ company_name: 'DMI Security' });
  }
  const settings = await getSettings();
  time.setTimeZone(settings.timezone);
  const adminId = (await db.get("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")).id;

  const today = time.todayStr();
  const now = time.nowStr();
  const day = (offset) => time.addDays(today, offset);
  const thisMonday = time.startOfWeek(today);

  await db.transaction(async (tx) => {
    const sqlFor = (table, row) => {
      const cols = Object.keys(row);
      return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`;
    };
    const insert = (table, row) => tx.insert(sqlFor(table, row), row);

    // ---- Training courses ---------------------------------------------------------
    const course = {
      firstAid: await insert('training_courses', { name: 'First Aid & CPR', description: 'Provide first aid, including CPR and defibrillator use.', validity_months: 36, required: 1 }),
      fire: await insert('training_courses', { name: 'Fire Warden', description: 'Evacuation procedures and fire equipment.', validity_months: 24, required: 1 }),
      induction: await insert('training_courses', { name: 'Health & Safety Induction', description: 'Company policies and site safety.', validity_months: null, required: 1 }),
      conflict: await insert('training_courses', { name: 'Conflict De-escalation', description: 'Managing aggressive behaviour safely.', validity_months: 24, required: 0 }),
      baton: await insert('training_courses', { name: 'Baton & Handcuff', description: 'Use of restraints (where licensed).', validity_months: 12, required: 0 }),
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
    const guards = [];
    for (const [i, [first_name, last_name, position, employment_type, hourly_rate, license_expiry]] of people.entries()) {
      const id = await insert('employees', {
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
      guards.push({ id, first_name, last_name });
    }
    const hannah = await insert('employees', { first_name: 'Hannah', last_name: 'Lee', position: 'Office Staff', employment_type: 'Part-time', hourly_rate: 28, license_required: 0, start_date: day(-400), email: 'hannah.lee@example.com' });
    await insert('training_records', { employee_id: hannah, course_id: course.induction, completed_on: day(-395), provider: 'In-house' });
    await insert('training_records', { employee_id: hannah, course_id: course.fire, completed_on: day(-180), expires_on: time.addMonths(day(-180), 24), provider: 'In-house' });
    await insert('employees', { first_name: 'Mark', last_name: 'Davies', position: 'Security Officer', employment_type: 'Casual', hourly_rate: 29, status: 'inactive', start_date: day(-800), end_date: day(-120), license_number: 'SL-39001', license_expiry: day(-30) });

    // ---- Training records (with a few gaps on purpose) -----------------------------
    for (const [i, g] of guards.entries()) {
      if (g.first_name !== 'Tom') {
        const done = g.first_name === 'Grace' ? time.addMonths(day(12), -36) : day(-200 - i * 40);
        await insert('training_records', { employee_id: g.id, course_id: course.firstAid, completed_on: done, expires_on: time.addMonths(done, 36), provider: 'Safe Hands Training', certificate_number: `FA-${7000 + i}` });
      }
      const fireDone = g.first_name === 'Liam' ? day(-760) : day(-100 - i * 25);
      await insert('training_records', { employee_id: g.id, course_id: course.fire, completed_on: fireDone, expires_on: time.addMonths(fireDone, 24), provider: 'In-house' });
      await insert('training_records', { employee_id: g.id, course_id: course.induction, completed_on: day(-880 + i * 60), provider: 'In-house' });
      if (i % 2 === 0) {
        await insert('training_records', { employee_id: g.id, course_id: course.conflict, completed_on: day(-300 + i * 10), expires_on: time.addMonths(day(-300 + i * 10), 24), provider: 'Safe Hands Training' });
      }
    }

    const session = await insert('training_sessions', { course_id: course.firstAid, starts_at: `${day(9)}T09:00`, location: 'Head office training room', trainer: 'Safe Hands Training', capacity: 8 });
    for (const g of guards.filter((x) => ['Tom', 'Grace'].includes(x.first_name))) {
      await tx.run('INSERT INTO training_attendees (session_id, employee_id) VALUES (?, ?)', session, g.id);
    }

    // ---- Clients, sites and contracts ----------------------------------------------
    const harbour = await insert('clients', { name: 'Harbour Mall', contact_name: 'Rebecca Shaw', contact_email: 'centre.manager@harbourmall.example', contact_phone: '02 5550 1100', address: '1 Harbour St' });
    const northgate = await insert('clients', { name: 'Northgate Logistics', contact_name: 'Peter Wills', contact_email: 'ops@northgate.example', contact_phone: '02 5550 2200', address: '45 Industrial Rd' });
    const riverside = await insert('clients', { name: 'Riverside Medical Centre', contact_name: 'Dr. Anna Cole', contact_email: 'facilities@riverside.example', contact_phone: '02 5550 3300', address: '9 River Pde' });
    const bayside = await insert('clients', { name: 'Bayside Events Co.', contact_name: 'Marcus Bell', contact_email: 'bookings@bayside.example', contact_phone: '02 5550 4400', address: '200 Waterfront Way' });

    const site = {
      mallEntrance: await insert('sites', { client_id: harbour, name: 'Main entrance', address: '1 Harbour St', instructions: 'Sign in at the centre management office. Radio channel 3.' }),
      mallCarPark: await insert('sites', { client_id: harbour, name: 'Car park patrol', address: '1 Harbour St (levels P1–P4)', instructions: 'Patrol every hour. Log incidents in the car park book.' }),
      warehouse: await insert('sites', { client_id: northgate, name: 'Warehouse 3', address: '45 Industrial Rd', instructions: 'Gate code changes weekly – ask the supervisor.' }),
      ed: await insert('sites', { client_id: riverside, name: 'Emergency department', address: '9 River Pde', instructions: 'Report to the nurse unit manager on arrival.' }),
      arena: await insert('sites', { client_id: bayside, name: 'Waterfront Arena', address: '200 Waterfront Way', instructions: 'Event briefing 30 minutes before start.' }),
    };

    await insert('contracts', { title: 'Static guarding – Harbour Mall', contract_type: 'Client service agreement', party_type: 'client', client_id: harbour, status: 'active', signed_on: day(-345), start_date: day(-340), end_date: day(25), value: 480000, notes: '90 days notice to renew. Rates reviewed annually.' });
    await insert('contracts', { title: 'Night patrol – Northgate Logistics', contract_type: 'Client service agreement', party_type: 'client', client_id: northgate, status: 'active', signed_on: day(-125), start_date: day(-120), end_date: day(245), value: 210000 });
    await insert('contracts', { title: 'Concierge security – Riverside Medical', contract_type: 'Client service agreement', party_type: 'client', client_id: riverside, status: 'active', signed_on: day(-60), start_date: day(-55), end_date: day(420), value: 96000 });
    await insert('contracts', { title: 'Event security – 2026 season', contract_type: 'Client service agreement', party_type: 'client', client_id: bayside, status: 'active', start_date: day(-200), end_date: day(75), value: 58000 });
    await insert('contracts', { title: 'CCTV maintenance subcontract', contract_type: 'Subcontractor agreement', party_type: 'other', other_party: 'Apex CCTV Installations', status: 'active', start_date: day(-375), end_date: day(-10) });
    await insert('contracts', { title: 'Mutual NDA – Riverside Medical', contract_type: 'Non-disclosure agreement', party_type: 'client', client_id: riverside, status: 'active', signed_on: day(-60), start_date: day(-60) });
    for (const g of guards.slice(0, 4)) {
      await insert('contracts', { title: `Employment contract – ${g.first_name} ${g.last_name}`, contract_type: 'Employment contract', party_type: 'employee', employee_id: g.id, status: 'active', signed_on: day(-800), start_date: day(-790) });
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

    // Hours worked: recorded (and approved) from the schedule when each shift
    // ended. Older weeks are paid already.
    const payStart = time.addDays(thisMonday, -21);
    const payRun = await insert('pay_runs', { period_start: payStart, period_end: time.addDays(thisMonday, -8), status: 'finalized', created_by: adminId, finalized_by: adminId, finalized_at: `${time.addDays(thisMonday, -6)} 10:15:00`, paid_on: time.addDays(thisMonday, -5), notes: 'Demo pay run' });

    for (const s of shifts) {
      const { week, ...row } = s;
      const status = s.end_at <= now && s.employee_id ? 'completed' : 'scheduled';
      const shiftId = await insert('shifts', { ...row, status });
      if (status !== 'completed') continue;
      await insert('time_entries', {
        employee_id: s.employee_id,
        site_id: s.site_id,
        shift_id: shiftId,
        start_at: s.start_at,
        end_at: s.end_at,
        break_minutes: s.break_minutes,
        status: 'approved',
        approved_at: `${s.end_at.slice(0, 10)} ${s.end_at.slice(11)}:00`,
        source: 'schedule',
        pay_run_id: week <= -2 ? payRun : null,
      });
    }

    // Priya's control-room hours (not on the schedule, so the office enters
    // them), weekdays only. This week's are still waiting for approval.
    const priya = guards.find((g) => g.first_name === 'Priya');
    for (let date = payStart; date < today; date = time.addDays(date, 1)) {
      if (time.daysBetween(time.startOfWeek(date), date) >= 5) continue;
      const week = Math.floor(time.daysBetween(thisMonday, date) / 7);
      const approved = week <= -1;
      await insert('time_entries', {
        employee_id: priya.id,
        start_at: `${date}T09:00`,
        end_at: `${date}T17:30`,
        break_minutes: 30,
        notes: 'Control room',
        status: approved ? 'approved' : 'pending',
        approved_by: approved ? adminId : null,
        approved_at: approved ? `${date} 18:00:00` : null,
        pay_run_id: week <= -2 ? payRun : null,
      });
    }

    // Work out the numbers for the finalized demo pay run.
    const paid = await tx.all('SELECT * FROM time_entries WHERE pay_run_id = ? ORDER BY employee_id, start_at', payRun);
    const byEmployee = new Map();
    for (const e of paid) byEmployee.set(e.employee_id, [...(byEmployee.get(e.employee_id) || []), e]);
    for (const [employeeId, entries] of byEmployee) {
      const { hourly_rate } = await tx.get('SELECT hourly_rate FROM employees WHERE id = ?', employeeId);
      const line = calculatePayLine({ entries, hourlyRate: hourly_rate, weeklyLimit: settings.overtime_weekly_hours, multiplier: settings.overtime_multiplier });
      await insert('pay_run_items', { pay_run_id: payRun, employee_id: employeeId, ...line });
    }

    await tx.run('INSERT INTO activity_log (user_id, action) VALUES (?, ?)', adminId, 'Loaded demo data');
  });

  // Demo officer and client accounts, to see what they see.
  if (adminLogin) {
    const guard = await db.get("SELECT * FROM employees WHERE status = 'active' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.employee_id = employees.id) ORDER BY id LIMIT 1");
    const client = await db.get('SELECT * FROM clients ORDER BY id LIMIT 1');
    await db.run(
      "INSERT INTO users (name, email, password_hash, role, employee_id) VALUES (?, 'officer@example.com', ?, 'officer', ?)",
      `${guard.first_name} ${guard.last_name}`, hashPassword(adminLogin), guard.id
    );
    await db.run(
      "INSERT INTO users (name, email, password_hash, role, client_id) VALUES (?, 'client@example.com', ?, 'client', ?)",
      `${client.name} (demo)`, hashPassword(adminLogin), client.id
    );
  }

  console.log('Demo data added.');
  if (adminLogin) {
    console.log('');
    console.log('Sign in with:');
    console.log(`  Admin:   admin@example.com   / ${adminLogin}`);
    console.log(`  Manager: manager@example.com / ${adminLogin}`);
    console.log(`  Officer: officer@example.com / ${adminLogin}`);
    console.log(`  Client:  client@example.com  / ${adminLogin}`);
    console.log('(Write this down – it is only shown once. You can change it under "My account".)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
