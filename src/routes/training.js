// Training: courses, who has completed them, and upcoming training sessions.
const express = require('express');
const db = require('../db');
const {
  clean, toId, toNumber, asArray, notFound, numericIdParam, logActivity, isInUseError, isDuplicateError, employeeName,
} = require('../helpers');
const time = require('../time');
const { complianceFor, expiryStatus, latestTrainingRecords } = require('../services/compliance');
const { saveUpload, deleteUpload, sendUpload, UploadError } = require('../uploads');

const router = express.Router();
numericIdParam(router);
router.param('employeeId', (req, res, next, id) => (/^\d+$/.test(id) ? next() : next('route')));

function activeStaff(includeId) {
  return db.all("SELECT * FROM employees WHERE status = 'active' OR id = ? ORDER BY last_name, first_name", includeId || 0);
}

function courseOptions(includeId) {
  return db.all('SELECT * FROM training_courses WHERE active = 1 OR id = ? ORDER BY name', includeId || 0);
}

function findCourse(id) {
  return db.get('SELECT * FROM training_courses WHERE id = ?', id);
}

// A training picked from the list, or a new one typed in. A new one is only
// created when the rest of the form is valid (see createCourseIfNew).
async function readCourseChoice(body) {
  const courseId = toId(body.course_id);
  if (courseId) {
    const course = await findCourse(courseId);
    return course ? { course } : { error: 'Please choose a training from the list.' };
  }
  const name = String(body.new_course_name || '').trim().slice(0, 200);
  if (!name) return { error: 'Choose a training from the list, or type the name of a new one.' };
  const existing = await db.get('SELECT * FROM training_courses WHERE lower(name) = lower(?)', name);
  if (existing) return { course: existing };
  const validity = toNumber(String(body.new_course_validity || '').trim(), null);
  if (validity !== null && (!Number.isInteger(validity) || validity < 1)) {
    return { error: 'Validity must be a whole number of months, or left empty if it never expires.' };
  }
  return { newCourse: { name, validity_months: validity } };
}

async function createCourseIfNew(choice, req) {
  if (choice.course) return choice.course;
  const id = await db.insert(
    'INSERT INTO training_courses (name, validity_months, required, active) VALUES (?, ?, 0, 1)',
    choice.newCourse.name,
    choice.newCourse.validity_months
  );
  await logActivity(req, `Added training course ${choice.newCourse.name}`);
  return findCourse(id);
}

// If no expiry date was typed, work it out from the course's validity period.
function expiryFor(course, completedOn, typedExpiry) {
  if (typedExpiry) return typedExpiry;
  if (course?.validity_months && completedOn) return time.addMonths(completedOn, course.validity_months);
  return null;
}

// ---- Overview ---------------------------------------------------------------------

router.get('/', async (req, res) => {
  const warningDays = res.locals.settings.expiry_warning_days;
  const employees = await activeStaff();
  const [{ courses, byEmployee }, sessions, courseCount] = await Promise.all([
    complianceFor(employees, warningDays),
    db.all(
      `SELECT ts.*, c.name AS course_name,
         (SELECT COUNT(*)::int FROM training_attendees a WHERE a.session_id = ts.id) AS attendee_count
       FROM training_sessions ts JOIN training_courses c ON c.id = ts.course_id
       WHERE ts.status = 'scheduled' ORDER BY ts.starts_at`
    ),
    db.get('SELECT COUNT(*)::int AS n FROM training_courses'),
  ]);

  // Everything expired, expiring or missing, soonest first.
  const attention = [];
  for (const employee of employees) {
    for (const item of byEmployee.get(employee.id).items) {
      if (['expired', 'expiring', 'missing'].includes(item.status)) attention.push({ employee, ...item });
    }
  }
  const order = { expired: 0, missing: 1, expiring: 2 };
  attention.sort((a, b) => order[a.status] - order[b.status] || String(a.expires_on).localeCompare(String(b.expires_on)));

  res.render('training/index', {
    title: 'Training',
    employees,
    courses,
    byEmployee,
    attention,
    sessions,
    courseCount: courseCount.n,
  });
});

// ---- Courses ----------------------------------------------------------------------

function readCourseForm(body) {
  const v = clean(body, ['name', 'description', 'validity_months']);
  v.validity_months = toNumber(v.validity_months, null);
  v.required = body.required ? 1 : 0;
  v.active = body.active ? 1 : 0;
  let error = null;
  if (!v.name) error = 'Please give the course a name.';
  else if (v.validity_months !== null && (!Number.isInteger(v.validity_months) || v.validity_months < 1)) {
    error = 'Validity must be a whole number of months, or left empty if it never expires.';
  }
  return { values: v, error };
}

function renderCourseForm(res, course, error, status = 200) {
  res.status(status).render('training/course-form', { title: course.id ? `Edit ${course.name}` : 'Add course', course, error });
}

async function saveCourse(req, res, course) {
  const { values, error } = readCourseForm(req.body);
  if (error) return renderCourseForm(res, { ...values, id: course?.id }, error, 400);
  try {
    if (course) {
      await db.run(
        'UPDATE training_courses SET name = @name, description = @description, validity_months = @validity_months, required = @required, active = @active WHERE id = @id',
        { ...values, id: course.id }
      );
    } else {
      await db.run(
        'INSERT INTO training_courses (name, description, validity_months, required, active) VALUES (@name, @description, @validity_months, @required, @active)',
        values
      );
    }
  } catch (err) {
    if (!isDuplicateError(err)) throw err;
    return renderCourseForm(res, { ...values, id: course?.id }, 'A course with that name already exists.', 400);
  }
  await logActivity(req, `${course ? 'Updated' : 'Added'} training course ${values.name}`);
  req.flash('success', 'Course saved.');
  res.redirect('/training/courses');
}

router.get('/courses', async (req, res) => {
  const courses = await db.all(
    `SELECT c.*, (SELECT COUNT(*)::int FROM training_records r WHERE r.course_id = c.id) AS record_count
     FROM training_courses c ORDER BY c.active DESC, c.name`
  );
  res.render('training/courses', { title: 'Training courses', courses });
});

router.get('/courses/new', (req, res) => renderCourseForm(res, { active: 1, required: 0 }, null));
router.post('/courses', (req, res) => saveCourse(req, res, null));

router.get('/courses/:id/edit', async (req, res) => {
  const course = await findCourse(req.params.id);
  if (!course) return notFound(res, 'course');
  renderCourseForm(res, course, null);
});

router.post('/courses/:id', async (req, res) => {
  const course = await findCourse(req.params.id);
  if (!course) return notFound(res, 'course');
  await saveCourse(req, res, course);
});

router.post('/courses/:id/delete', async (req, res) => {
  const course = await findCourse(req.params.id);
  if (!course) return notFound(res, 'course');
  try {
    await db.run('DELETE FROM training_courses WHERE id = ?', course.id);
  } catch (err) {
    if (!isInUseError(err)) throw err;
    req.flash('error', `"${course.name}" has training records or sessions, so it can't be deleted. Untick "Active" instead.`);
    return res.redirect(`/training/courses/${course.id}/edit`);
  }
  await logActivity(req, `Deleted training course ${course.name}`);
  req.flash('success', 'Course deleted.');
  res.redirect('/training/courses');
});

// ---- Training records (certificates) ------------------------------------------------

const RECORD_SELECT = `
  SELECT r.*, c.name AS course_name, e.first_name, e.last_name
  FROM training_records r
  JOIN training_courses c ON c.id = r.course_id
  JOIN employees e ON e.id = r.employee_id`;

function findRecord(id) {
  return db.get(`${RECORD_SELECT} WHERE r.id = ?`, id);
}

async function readRecordForm(body) {
  const v = clean(body, ['employee_id', 'course_id', 'completed_on', 'expires_on', 'provider', 'certificate_number', 'notes', 'new_course_name', 'new_course_validity']);
  v.employee_id = toId(v.employee_id);
  v.course_id = toId(v.course_id);
  const choice = await readCourseChoice(body);
  let error = null;
  if (!v.employee_id || !(await db.get('SELECT 1 FROM employees WHERE id = ?', v.employee_id))) {
    error = 'Please choose a staff member.';
  } else if (choice.error) error = choice.error;
  else if (!time.isValidDate(v.completed_on)) error = 'Please enter the date the course was completed.';
  else if (v.expires_on && !time.isValidDate(v.expires_on)) error = 'Please use the date picker for the expiry date.';
  if (!error) v.expires_on = expiryFor(choice.course || choice.newCourse, v.completed_on, v.expires_on);
  return { values: v, choice, error };
}

async function renderRecordForm(res, record, error, status = 200) {
  const [staff, courses] = await Promise.all([activeStaff(record.employee_id), courseOptions(record.course_id)]);
  res.status(status).render('training/record-form', {
    title: record.id ? 'Edit training record' : 'Add training record',
    record,
    error,
    staff,
    courses,
  });
}

router.get('/records', async (req, res) => {
  const employeeId = toId(req.query.employee);
  const courseId = toId(req.query.course);
  const where = ['1 = 1'];
  const params = [];
  if (employeeId) {
    where.push('r.employee_id = ?');
    params.push(employeeId);
  }
  if (courseId) {
    where.push('r.course_id = ?');
    params.push(courseId);
  }
  const [records, latest, staff, courses] = await Promise.all([
    db.all(`${RECORD_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.completed_on DESC LIMIT 500`, ...params),
    latestTrainingRecords(),
    activeStaff(),
    courseOptions(),
  ]);
  // Mark older certificates that have been replaced by a newer one.
  for (const r of records) r.superseded = latest.get(`${r.employee_id}:${r.course_id}`)?.id !== r.id;
  res.render('training/records', { title: 'Training records', records, employeeId, courseId, staff, courses });
});

router.get('/records/new', async (req, res) => {
  await renderRecordForm(
    res,
    { employee_id: toId(req.query.employee), course_id: toId(req.query.course), completed_on: time.todayStr() },
    null
  );
});

router.post('/records', async (req, res) => {
  const { values, choice, error } = await readRecordForm(req.body);
  if (error) return renderRecordForm(res, values, error, 400);
  let file = null;
  try {
    file = await saveUpload(req.file);
  } catch (err) {
    if (err instanceof UploadError) return renderRecordForm(res, values, err.message, 400);
    throw err;
  }
  values.course_id = (await createCourseIfNew(choice, req)).id;
  await db.run(
    `INSERT INTO training_records (employee_id, course_id, completed_on, expires_on, provider, certificate_number, notes, file_name, file_original)
     VALUES (@employee_id, @course_id, @completed_on, @expires_on, @provider, @certificate_number, @notes, @file_name, @file_original)`,
    { ...values, file_name: file?.file_name ?? null, file_original: file?.file_original ?? null }
  );
  const employee = await db.get('SELECT first_name, last_name FROM employees WHERE id = ?', values.employee_id);
  const course = await findCourse(values.course_id);
  await logActivity(req, `Recorded ${course.name} for ${employeeName(employee)}`);
  req.flash('success', `Training record added for ${employeeName(employee)}.`);
  res.redirect(`/staff/${values.employee_id}`);
});

router.get('/records/:id/file', async (req, res) => {
  const record = await findRecord(req.params.id);
  if (!record?.file_name) return notFound(res, 'file');
  await sendUpload(res, record.file_name, record.file_original);
});

router.get('/records/:id/edit', async (req, res) => {
  const record = await findRecord(req.params.id);
  if (!record) return notFound(res, 'training record');
  await renderRecordForm(res, record, null);
});

router.post('/records/:id', async (req, res) => {
  const record = await findRecord(req.params.id);
  if (!record) return notFound(res, 'training record');
  const { values, choice, error } = await readRecordForm(req.body);
  const formValues = { ...values, id: record.id, file_name: record.file_name, file_original: record.file_original };
  if (error) return renderRecordForm(res, formValues, error, 400);
  let file = null;
  try {
    file = await saveUpload(req.file);
  } catch (err) {
    if (err instanceof UploadError) return renderRecordForm(res, formValues, err.message, 400);
    throw err;
  }
  let { file_name, file_original } = record;
  if (file || req.body.remove_file) {
    await deleteUpload(record.file_name);
    file_name = file?.file_name ?? null;
    file_original = file?.file_original ?? null;
  }
  values.course_id = (await createCourseIfNew(choice, req)).id;
  await db.run(
    `UPDATE training_records SET employee_id = @employee_id, course_id = @course_id, completed_on = @completed_on,
     expires_on = @expires_on, provider = @provider, certificate_number = @certificate_number, notes = @notes,
     file_name = @file_name, file_original = @file_original WHERE id = @id`,
    { ...values, file_name, file_original, id: record.id }
  );
  await logActivity(req, `Updated training record #${record.id} (${record.course_name}, ${employeeName(record)})`);
  req.flash('success', 'Training record saved.');
  res.redirect(`/staff/${values.employee_id}`);
});

router.post('/records/:id/delete', async (req, res) => {
  const record = await findRecord(req.params.id);
  if (!record) return notFound(res, 'training record');
  await db.run('DELETE FROM training_records WHERE id = ?', record.id);
  await deleteUpload(record.file_name);
  await logActivity(req, `Deleted training record #${record.id} (${record.course_name}, ${employeeName(record)})`);
  req.flash('success', 'Training record deleted.');
  res.redirect(`/staff/${record.employee_id}`);
});

// ---- Training sessions (classes) ----------------------------------------------------

const SESSION_SELECT = `
  SELECT ts.*, c.name AS course_name, c.validity_months
  FROM training_sessions ts JOIN training_courses c ON c.id = ts.course_id`;

function findSession(id) {
  return db.get(`${SESSION_SELECT} WHERE ts.id = ?`, id);
}

async function readSessionForm(body) {
  const v = clean(body, ['course_id', 'date', 'start_time', 'duration_hours', 'location', 'trainer', 'capacity', 'notes', 'status', 'new_course_name', 'new_course_validity']);
  const durationHours = toNumber(v.duration_hours, 4);
  const values = {
    course_id: toId(v.course_id),
    new_course_name: v.new_course_name,
    new_course_validity: v.new_course_validity,
    date: v.date,
    start_time: v.start_time,
    location: v.location,
    trainer: v.trainer,
    capacity: toNumber(v.capacity, null),
    notes: v.notes,
    status: ['scheduled', 'completed', 'cancelled'].includes(v.status) ? v.status : 'scheduled',
    duration_hours: durationHours,
    duration_minutes: Math.round(durationHours * 60),
  };
  const choice = await readCourseChoice(body);
  let error = null;
  if (choice.error) error = choice.error;
  else if (!time.isValidDate(values.date)) error = 'Please choose a date.';
  else if (!time.isValidTime(values.start_time)) error = 'Please enter a start time.';
  else if (Number.isNaN(durationHours) || durationHours < 0.5 || durationHours > 24) {
    error = 'Length must be between half an hour and 24 hours.';
  }
  else if (values.capacity !== null && (!Number.isInteger(values.capacity) || values.capacity < 1)) {
    error = 'Capacity must be a whole number, or left empty.';
  }
  values.starts_at = `${values.date}T${values.start_time}`;
  return { values, choice, error };
}

async function renderSessionForm(res, session, error, status = 200) {
  res.status(status).render('training/session-form', {
    title: session.id ? 'Edit training session' : 'Schedule training session',
    session,
    error,
    courses: await courseOptions(session.course_id),
  });
}

router.get('/sessions', async (req, res) => {
  const sessions = await db.all(
    `SELECT ts.*, c.name AS course_name,
       (SELECT COUNT(*)::int FROM training_attendees a WHERE a.session_id = ts.id) AS attendee_count
     FROM training_sessions ts JOIN training_courses c ON c.id = ts.course_id
     ORDER BY ts.starts_at DESC LIMIT 300`
  );
  res.render('training/sessions', { title: 'Training sessions', sessions });
});

router.get('/sessions/new', async (req, res) => {
  await renderSessionForm(
    res,
    { course_id: toId(req.query.course), date: time.addDays(time.todayStr(), 7), start_time: '09:00', duration_hours: 4 },
    null
  );
});

router.post('/sessions', async (req, res) => {
  const { values, choice, error } = await readSessionForm(req.body);
  if (error) return renderSessionForm(res, values, error, 400);
  values.course_id = (await createCourseIfNew(choice, req)).id;
  const id = await db.insert(
    `INSERT INTO training_sessions (course_id, starts_at, duration_minutes, location, trainer, capacity, notes)
     VALUES (@course_id, @starts_at, @duration_minutes, @location, @trainer, @capacity, @notes)`,
    values
  );
  await logActivity(req, `Scheduled training session #${id} on ${values.date}`);
  req.flash('success', 'Training session scheduled. Now add the people attending.');
  res.redirect(`/training/sessions/${id}`);
});

router.get('/sessions/:id', async (req, res) => {
  const session = await findSession(req.params.id);
  if (!session) return notFound(res, 'training session');
  const warningDays = res.locals.settings.expiry_warning_days;
  const [latest, attendees, staff] = await Promise.all([
    latestTrainingRecords(),
    db.all(
      `SELECT a.attended, e.* FROM training_attendees a JOIN employees e ON e.id = a.employee_id
       WHERE a.session_id = ? ORDER BY e.last_name, e.first_name`,
      session.id
    ),
    activeStaff(),
  ]);
  // Show each person's current status for this course.
  const withStatus = (e) => {
    const record = latest.get(`${e.id}:${session.course_id}`);
    return { ...e, current: record ? expiryStatus(record.expires_on, warningDays) : 'missing', current_expiry: record?.expires_on };
  };
  const bookedIds = new Set(attendees.map((a) => a.id));
  const available = staff.filter((e) => !bookedIds.has(e.id)).map(withStatus);
  // So an empty list can say why: everyone's booked, or staff are inactive.
  const { n: inactiveCount } = await db.get("SELECT COUNT(*)::int AS n FROM employees WHERE status = 'inactive'");
  res.render('training/session', {
    title: `${session.course_name} – ${time.fmtDate(session.starts_at)}`,
    session,
    attendees: attendees.map(withStatus),
    available,
    activeCount: staff.length,
    inactiveCount,
    dueCount: available.filter((e) => e.current !== 'valid' && e.current !== 'no-expiry').length,
  });
});

router.get('/sessions/:id/edit', async (req, res) => {
  const session = await findSession(req.params.id);
  if (!session) return notFound(res, 'training session');
  await renderSessionForm(
    res,
    { ...session, date: session.starts_at.slice(0, 10), start_time: time.fmtTime(session.starts_at), duration_hours: session.duration_minutes / 60 },
    null
  );
});

router.post('/sessions/:id', async (req, res) => {
  const session = await findSession(req.params.id);
  if (!session) return notFound(res, 'training session');
  const { values, choice, error } = await readSessionForm(req.body);
  if (error) return renderSessionForm(res, { ...values, id: session.id }, error, 400);
  values.course_id = (await createCourseIfNew(choice, req)).id;
  await db.run(
    `UPDATE training_sessions SET course_id = @course_id, starts_at = @starts_at, duration_minutes = @duration_minutes, location = @location, trainer = @trainer,
     capacity = @capacity, notes = @notes, status = @status WHERE id = @id`,
    { ...values, id: session.id }
  );
  await logActivity(req, `Updated training session #${session.id}`);
  req.flash('success', 'Training session saved.');
  res.redirect(`/training/sessions/${session.id}`);
});

router.post('/sessions/:id/delete', async (req, res) => {
  const session = await findSession(req.params.id);
  if (!session) return notFound(res, 'training session');
  await db.run('DELETE FROM training_sessions WHERE id = ?', session.id);
  await logActivity(req, `Deleted training session #${session.id} (${session.course_name})`);
  req.flash('success', 'Training session deleted.');
  res.redirect('/training');
});

function sessionIsOpen(req, res, session) {
  if (session.status === 'scheduled') return true;
  req.flash('error', `This session is ${session.status}, so attendees can't be changed.`);
  res.redirect(`/training/sessions/${session.id}`);
  return false;
}

async function addAttendees(session, employeeIds) {
  let added = 0;
  let room = Infinity;
  await db.transaction(async (tx) => {
    const { n } = await tx.get('SELECT COUNT(*)::int AS n FROM training_attendees WHERE session_id = ?', session.id);
    room = session.capacity ? Math.max(session.capacity - n, 0) : Infinity;
    for (const id of employeeIds) {
      if (added >= room) break;
      const result = await tx.run(
        'INSERT INTO training_attendees (session_id, employee_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
        session.id,
        id
      );
      added += result.changes;
    }
  });
  return { added, full: added < employeeIds.length && added >= room };
}

router.post('/sessions/:id/attendees', async (req, res) => {
  const session = await findSession(req.params.id);
  if (!session) return notFound(res, 'training session');
  if (!sessionIsOpen(req, res, session)) return;
  const employeeId = toId(req.body.employee_id);
  if (!employeeId || !(await db.get('SELECT 1 FROM employees WHERE id = ?', employeeId))) {
    req.flash('error', 'Please choose someone to add.');
  } else {
    const { added } = await addAttendees(session, [employeeId]);
    req.flash(added ? 'success' : 'error', added ? 'Attendee added.' : 'This session is full.');
  }
  res.redirect(`/training/sessions/${session.id}`);
});

// Adds everyone whose certificate for this course is missing, expired or expiring.
router.post('/sessions/:id/add-due', async (req, res) => {
  const session = await findSession(req.params.id);
  if (!session) return notFound(res, 'training session');
  if (!sessionIsOpen(req, res, session)) return;
  const warningDays = res.locals.settings.expiry_warning_days;
  const [latest, staff] = await Promise.all([latestTrainingRecords(), activeStaff()]);
  const due = staff
    .filter((e) => {
      const record = latest.get(`${e.id}:${session.course_id}`);
      const status = record ? expiryStatus(record.expires_on, warningDays) : 'missing';
      return status !== 'valid' && status !== 'no-expiry';
    })
    .map((e) => e.id);
  const { added, full } = await addAttendees(session, due);
  await logActivity(req, `Added ${added} attendee(s) to training session #${session.id}`);
  req.flash('success', `${added} people added.`);
  if (full) req.flash('warning', 'The session is now full; not everyone who needs this course could be added.');
  res.redirect(`/training/sessions/${session.id}`);
});

router.post('/sessions/:id/attendees/:employeeId/remove', async (req, res) => {
  const session = await findSession(req.params.id);
  if (!session) return notFound(res, 'training session');
  if (!sessionIsOpen(req, res, session)) return;
  await db.run('DELETE FROM training_attendees WHERE session_id = ? AND employee_id = ?', session.id, req.params.employeeId);
  req.flash('success', 'Attendee removed.');
  res.redirect(`/training/sessions/${session.id}`);
});

// Marks the session done: everyone ticked as "attended" gets a training record.
router.post('/sessions/:id/complete', async (req, res) => {
  const session = await findSession(req.params.id);
  if (!session) return notFound(res, 'training session');
  if (!sessionIsOpen(req, res, session)) return;
  const attended = new Set(asArray(req.body.attended).map(toId).filter(Boolean));
  const completedOn = session.starts_at.slice(0, 10);
  const expiresOn = expiryFor(session, completedOn, null);
  let count = 0;

  await db.transaction(async (tx) => {
    const attendees = await tx.all('SELECT employee_id FROM training_attendees WHERE session_id = ?', session.id);
    for (const { employee_id } of attendees) {
      const wasThere = attended.has(employee_id);
      await tx.run('UPDATE training_attendees SET attended = ? WHERE session_id = ? AND employee_id = ?', wasThere ? 1 : 0, session.id, employee_id);
      if (wasThere) {
        count += 1;
        await tx.run(
          'INSERT INTO training_records (employee_id, course_id, completed_on, expires_on, provider, notes) VALUES (?, ?, ?, ?, ?, ?)',
          employee_id,
          session.course_id,
          completedOn,
          expiresOn,
          session.trainer,
          `Training session #${session.id}`
        );
      }
    }
    await tx.run("UPDATE training_sessions SET status = 'completed' WHERE id = ?", session.id);
  });

  await logActivity(req, `Completed training session #${session.id} (${session.course_name}) – ${count} attended`);
  req.flash('success', `Session completed. ${count} training record(s) created.`);
  res.redirect(`/training/sessions/${session.id}`);
});

module.exports = router;
