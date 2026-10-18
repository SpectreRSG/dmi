// Compliance = "is this person allowed to work?"
// We check their security license and every training course marked "required".
const db = require('../db');
const { todayStr, addDays } = require('../time');

// Returns 'valid', 'expiring' (within the warning window), 'expired' or 'no-expiry'.
function expiryStatus(expiresOn, warningDays, today = todayStr()) {
  if (!expiresOn) return 'no-expiry';
  if (expiresOn < today) return 'expired';
  if (expiresOn <= addDays(today, warningDays)) return 'expiring';
  return 'valid';
}

async function requiredCourses() {
  return db.all('SELECT * FROM training_courses WHERE required = 1 AND active = 1 ORDER BY name');
}

// The most recent training record for each person + course, keyed "employeeId:courseId".
async function latestTrainingRecords() {
  const rows = await db.all('SELECT * FROM training_records ORDER BY completed_on, id');
  const latest = new Map();
  for (const row of rows) latest.set(`${row.employee_id}:${row.course_id}`, row); // later rows win
  return latest;
}

function licenseStatus(employee, warningDays) {
  if (!employee.license_number && !employee.license_expiry) return 'missing';
  return expiryStatus(employee.license_expiry, warningDays);
}

function checkEmployee(employee, courses, latest, warningDays) {
  const items = [];
  if (employee.license_required) {
    items.push({
      label: 'Security license',
      status: licenseStatus(employee, warningDays),
      expires_on: employee.license_expiry,
    });
  }
  for (const course of courses) {
    const record = latest.get(`${employee.id}:${course.id}`);
    items.push({
      label: course.name,
      course_id: course.id,
      status: record ? expiryStatus(record.expires_on, warningDays) : 'missing',
      expires_on: record?.expires_on ?? null,
      record: record ?? null,
    });
  }
  const problems = items.filter((i) => i.status === 'expired' || i.status === 'missing');
  const warnings = items.filter((i) => i.status === 'expiring');
  return { items, problems, warnings, level: problems.length ? 'bad' : warnings.length ? 'warn' : 'ok' };
}

// Checks a list of staff. Returns the required courses plus a Map of
// employee id -> { items, problems, warnings, level }.
async function complianceFor(employees, warningDays) {
  const [courses, latest] = await Promise.all([requiredCourses(), latestTrainingRecords()]);
  const byEmployee = new Map();
  for (const employee of employees) {
    byEmployee.set(employee.id, checkEmployee(employee, courses, latest, warningDays));
  }
  return { courses, latest, byEmployee };
}

async function complianceForEmployee(employee, warningDays) {
  return (await complianceFor([employee], warningDays)).byEmployee.get(employee.id);
}

module.exports = { expiryStatus, latestTrainingRecords, complianceFor, complianceForEmployee };
