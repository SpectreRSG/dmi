// Training: courses, who has completed them, and upcoming training sessions.
const express = require('express');
const db = require('../db');
const { clean, toId, toNumber, asArray, notFound, numericIdParam, logActivity, isInUseError, employeeName } = require('../helpers');
const time = require('../time');
const { complianceFor, expiryStatus, latestTrainingRecords } = require('../services/compliance');
const { saveUpload, deleteUpload, sendUpload, UploadError } = require('../uploads');

const router = express.Router();
numericIdParam(router);
router.param('employeeId', (req, res, next, id) => (/^\d+$/.test(id) ? next() : next('route')));

function activeStaff(includeId) {
  return db
    .prepare("SELECT * FROM employees WHERE status = 'active' OR id = ? ORDER BY last_name, first_name")
    .all(includeId || 0);
}

function courseOptions(includeId) {
  return db.prepare('SELECT * FROM training_courses WHERE active = 1 OR id = ? ORDER BY name').all(includeId || 0);
}

function findCourse(id) {
  return db.prepare('SELECT * FROM training_courses WHERE id = ?').get(id);
}

// If no expiry date was typed, work it out from the course's validity period.
function expiryFor(course, completedOn, typedExpiry) {
  if (typedExpiry) return typedExpiry;
  if (course?.validity_months && completedOn) return time.addMonths(completedOn, course.validity_months);
  return null;
}

// ---- Overview ---------------------------------------------------------------------

router.get('/', (req, res) => {
  const warningDays = res.locals.settings.expiry_warning_days;
  const employees = activeStaff();
  const { courses, byEmployee } = complianceFor(employees, warningDays);

  // Everything expired, expiring or missing, soonest first.
  const attention = [];
  for (const employee of employees) {
    for (const item of byEmployee.get(employee.id).items) {
      if (['expired', 'expiring', 'missing'].includes(item.status)) attention.push({ employee, ...item });
    }
  }
  const order = { expired: 0, missing: 1, expiring: 2 };
  attention.sort((a, b) => order[a.status] - order[b.status] || String(a.expires_on).localeCompare(String(b.expires_on)));

  const sessions = db
    .prepare(
      `SELECT ts.*, c.name AS course_name,
         (SELECT COUNT(*) FROM training_attendees a WHERE a.session_id = ts.id) AS attendee_count
       FROM training_sessions ts JOIN training_courses c ON c.id = ts.course_id
       WHERE ts.status = 'scheduled' ORDER BY ts.starts_at`
    )
    .all();

  res.render('training/index', {
    title: 'Training',
    employees,
    courses,
    byEmployee,
    attention,
    sessions,
    courseCount: db.prepare('SELECT COUNT(*) AS n FROM training_courses').get().n,
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

function saveCourse(req, res, course) {
  const { values, error } = readCourseForm(req.body);
  if (error) return renderCourseForm(res, { ...values, id: course?.id }, error, 400);
  try {
    if (course) {
      db.prepare(
        'UPDATE training_courses SET name = @name, description = @description, validity_months = @validity_months, required = @required, active = @active WHERE id = @id'
      ).run({ ...values, id: course.id });
    } else {
      db.prepare(
        'INSERT INTO training_courses (name, description, validity_months, required, active) VALUES (@name, @description, @validity_months, @required, @active)'
      ).run(values);
    }
  } catch (err) {
    if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
    return renderCourseForm(res, { ...values, id: course?.id }, 'A course with that name already exists.', 400);
  }
  logActivity(req, `${course ? 'Updated' : 'Added'} training course ${values.name}`);
  req.flash('success', 'Course saved.');
  res.redirect('/training/courses');
}

router.get('/courses', (req, res) => {
  const courses = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM training_records r WHERE r.course_id = c.id) AS record_count
       FROM training_courses c ORDER BY c.active DESC, c.name`
    )
    .all();
  res.render('training/courses', { title: 'Training courses', courses });
});

router.get('/courses/new', (req, res) => renderCourseForm(res, { active: 1, required: 0 }, null));
router.post('/courses', (req, res) => saveCourse(req, res, null));

router.get('/courses/:id/edit', (req, res) => {
  const course = findCourse(req.params.id);
  if (!course) return notFound(res, 'course');
  renderCourseForm(res, course, null);
});

router.post('/courses/:id', (req, res) => {
  const course = findCourse(req.params.id);
  if (!course) return notFound(res, 'course');
  saveCourse(req, res, course);
});

router.post('/courses/:id/delete', (req, res) => {
  const course = findCourse(req.params.id);
  if (!course) return notFound(res, 'course');
  try {
    db.prepare('DELETE FROM training_courses WHERE id = ?').run(course.id);
  } catch (err) {
    if (!isInUseError(err)) throw err;
    req.flash('error', `"${course.name}" has training records or sessions, so it can't be deleted. Untick "Active" instead.`);
    return res.redirect(`/training/courses/${course.id}/edit`);
  }
  logActivity(req, `Deleted training course ${course.name}`);
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
  return db.prepare(`${RECORD_SELECT} WHERE r.id = ?`).get(id);
}

function readRecordForm(body) {
  const v = clean(body, ['employee_id', 'course_id', 'completed_on', 'expires_on', 'provider', 'certificate_number', 'notes']);
  v.employee_id = toId(v.employee_id);
  v.course_id = toId(v.course_id);
  let error = null;
  const course = v.course_id ? findCourse(v.course_id) : null;
  if (!v.employee_id || !db.prepare('SELECT 1 FROM employees WHERE id = ?').get(v.employee_id)) {
    error = 'Please choose a staff member.';
  } else if (!course) error = 'Please choose a course.';
  else if (!time.isValidDate(v.completed_on)) error = 'Please enter the date the course was completed.';
  else if (v.expires_on && !time.isValidDate(v.expires_on)) error = 'Please use the date picker for the expiry date.';
  if (!error) v.expires_on = expiryFor(course, v.completed_on, v.expires_on);
  return { values: v, error };
}

function renderRecordForm(res, record, error, status = 200) {
  res.status(status).render('training/record-form', {
    title: record.id ? 'Edit training record' : 'Add training record',
    record,
    error,
    staff: activeStaff(record.employee_id),
    courses: courseOptions(record.course_id),
  });
}

router.get('/records', (req, res) => {
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
  const records = db.prepare(`${RECORD_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.completed_on DESC LIMIT 500`).all(...params);
  // Mark older certificates that have been replaced by a newer one.
  const latest = latestTrainingRecords();
  for (const r of records) r.superseded = latest.get(`${r.employee_id}:${r.course_id}`)?.id !== r.id;
  res.render('training/records', {
    title: 'Training records',
    records,
    employeeId,
    courseId,
    staff: activeStaff(),
    courses: courseOptions(),
  });
});

router.get('/records/new', (req, res) => {
  renderRecordForm(res, { employee_id: toId(req.query.employee), course_id: toId(req.query.course), completed_on: time.todayStr() }, null);
});

router.post('/records', (req, res) => {
  const { values, error } = readRecordForm(req.body);
  if (error) return renderRecordForm(res, values, error, 400);
  let file = null;
  try {
    file = saveUpload(req.file);
  } catch (err) {
    if (err instanceof UploadError) return renderRecordForm(res, values, err.message, 400);
    throw err;
  }
  db.prepare(
    `INSERT INTO training_records (employee_id, course_id, completed_on, expires_on, provider, certificate_number, notes, file_name, file_original)
     VALUES (@employee_id, @course_id, @completed_on, @expires_on, @provider, @certificate_number, @notes, @file_name, @file_original)`
  ).run({ ...values, file_name: file?.file_name ?? null, file_original: file?.file_original ?? null });
  const record = { ...values, ...findCourseAndEmployee(values) };
  logActivity(req, `Recorded ${record.course_name} for ${employeeName(record)}`);
  req.flash('success', `Training record added for ${employeeName(record)}.`);
  res.redirect(`/staff/${values.employee_id}`);
});

function findCourseAndEmployee({ employee_id, course_id }) {
  return {
    ...db.prepare('SELECT first_name, last_name FROM employees WHERE id = ?').get(employee_id),
    course_name: findCourse(course_id).name,
  };
}

router.get('/records/:id/file', (req, res) => {
  const record = findRecord(req.params.id);
  if (!record?.file_name) return notFound(res, 'file');
  sendUpload(res, record.file_name, record.file_original);
});

router.get('/records/:id/edit', (req, res) => {
  const record = findRecord(req.params.id);
  if (!record) return notFound(res, 'training record');
  renderRecordForm(res, record, null);
});

router.post('/records/:id', (req, res) => {
  const record = findRecord(req.params.id);
  if (!record) return notFound(res, 'training record');
  const { values, error } = readRecordForm(req.body);
  const formValues = { ...values, id: record.id, file_name: record.file_name, file_original: record.file_original };
  if (error) return renderRecordForm(res, formValues, error, 400);
  let file = null;
  try {
    file = saveUpload(req.file);
  } catch (err) {
    if (err instanceof UploadError) return renderRecordForm(res, formValues, err.message, 400);
    throw err;
  }
  let { file_name, file_original } = record;
  if (file || req.body.remove_file) {
    deleteUpload(record.file_name);
    file_name = file?.file_name ?? null;
    file_original = file?.file_original ?? null;
  }
  db.prepare(
    `UPDATE training_records SET employee_id = @employee_id, course_id = @course_id, completed_on = @completed_on,
     expires_on = @expires_on, provider = @provider, certificate_number = @certificate_number, notes = @notes,
     file_name = @file_name, file_original = @file_original WHERE id = @id`
  ).run({ ...values, file_name, file_original, id: record.id });
  logActivity(req, `Updated training record #${record.id} (${record.course_name}, ${employeeName(record)})`);
  req.flash('success', 'Training record saved.');
  res.redirect(`/staff/${values.employee_id}`);
});

router.post('/records/:id/delete', (req, res) => {
  const record = findRecord(req.params.id);
  if (!record) return notFound(res, 'training record');
  db.prepare('DELETE FROM training_records WHERE id = ?').run(record.id);
  deleteUpload(record.file_name);
  logActivity(req, `Deleted training record #${record.id} (${record.course_name}, ${employeeName(record)})`);
  req.flash('success', 'Training record deleted.');
  res.redirect(`/staff/${record.employee_id}`);
});

// ---- Training sessions (classes) ----------------------------------------------------

const SESSION_SELECT = `
  SELECT ts.*, c.name AS course_name, c.validity_months
  FROM training_sessions ts JOIN training_courses c ON c.id = ts.course_id`;

function findSession(id) {
  return db.prepare(`${SESSION_SELECT} WHERE ts.id = ?`).get(id);
}

function readSessionForm(body) {
  const v = clean(body, ['course_id', 'date', 'start_time', 'location', 'trainer', 'capacity', 'notes', 'status']);
  const values = {
    course_id: toId(v.course_id),
    date: v.date,
    start_time: v.start_time,
    location: v.location,
    trainer: v.trainer,
    capacity: toNumber(v.capacity, null),
    notes: v.notes,
    status: ['scheduled', 'completed', 'cancelled'].includes(v.status) ? v.status : 'scheduled',
  };
  let error = null;
  if (!values.course_id || !findCourse(values.course_id)) error = 'Please choose a course.';
  else if (!time.isValidDate(values.date)) error = 'Please choose a date.';
  else if (!time.isValidTime(values.start_time)) error = 'Please enter a start time.';
  else if (values.capacity !== null && (!Number.isInteger(values.capacity) || values.capacity < 1)) {
    error = 'Capacity must be a whole number, or left empty.';
  }
  values.starts_at = `${values.date}T${values.start_time}`;
  return { values, error };
}

function renderSessionForm(res, session, error, status = 200) {
  res.status(status).render('training/session-form', {
    title: session.id ? 'Edit training session' : 'Schedule training session',
    session,
    error,
    courses: courseOptions(session.course_id),
  });
}

router.get('/sessions', (req, res) => {
  const sessions = db
    .prepare(
      `SELECT ts.*, c.name AS course_name,
         (SELECT COUNT(*) FROM training_attendees a WHERE a.session_id = ts.id) AS attendee_count
       FROM training_sessions ts JOIN training_courses c ON c.id = ts.course_id
       ORDER BY ts.starts_at DESC LIMIT 300`
    )
    .all();
  res.render('training/sessions', { title: 'Training sessions', sessions });
});

router.get('/sessions/new', (req, res) => {
  renderSessionForm(res, { course_id: toId(req.query.course), date: time.addDays(time.todayStr(), 7), start_time: '09:00' }, null);
});

router.post('/sessions', (req, res) => {
  const { values, error } = readSessionForm(req.body);
  if (error) return renderSessionForm(res, values, error, 400);
  const info = db
    .prepare(
      'INSERT INTO training_sessions (course_id, starts_at, location, trainer, capacity, notes) VALUES (@course_id, @starts_at, @location, @trainer, @capacity, @notes)'
    )
    .run(values);
  logActivity(req, `Scheduled training session #${info.lastInsertRowid} on ${values.date}`);
  req.flash('success', 'Training session scheduled. Now add the people attending.');
  res.redirect(`/training/sessions/${info.lastInsertRowid}`);
});

router.get('/sessions/:id', (req, res) => {
  const session = findSession(req.params.id);
  if (!session) return notFound(res, 'training session');
  const warningDays = res.locals.settings.expiry_warning_days;
  const latest = latestTrainingRecords();
  const attendees = db
    .prepare(
      `SELECT a.attended, e.* FROM training_attendees a JOIN employees e ON e.id = a.employee_id
       WHERE a.session_id = ? ORDER BY e.last_name, e.first_name`
    )
    .all(session.id);
  // Show each person's current status for this course.
  const withStatus = (e) => {
    const record = latest.get(`${e.id}:${session.course_id}`);
    return { ...e, current: record ? expiryStatus(record.expires_on, warningDays) : 'missing', current_expiry: record?.expires_on };
  };
  const bookedIds = new Set(attendees.map((a) => a.id));
  const available = activeStaff().filter((e) => !bookedIds.has(e.id)).map(withStatus);
  res.render('training/session', {
    title: `${session.course_name} – ${time.fmtDate(session.starts_at)}`,
    session,
    attendees: attendees.map(withStatus),
    available,
    dueCount: available.filter((e) => e.current !== 'valid' && e.current !== 'no-expiry').length,
  });
});

router.get('/sessions/:id/edit', (req, res) => {
  const session = findSession(req.params.id);
  if (!session) return notFound(res, 'training session');
  renderSessionForm(res, { ...session, date: session.starts_at.slice(0, 10), start_time: time.fmtTime(session.starts_at) }, null);
});

router.post('/sessions/:id', (req, res) => {
  const session = findSession(req.params.id);
  if (!session) return notFound(res, 'training session');
  const { values, error } = readSessionForm(req.body);
  if (error) return renderSessionForm(res, { ...values, id: session.id }, error, 400);
  db.prepare(
    `UPDATE training_sessions SET course_id = @course_id, starts_at = @starts_at, location = @location, trainer = @trainer,
     capacity = @capacity, notes = @notes, status = @status WHERE id = @id`
  ).run({ ...values, id: session.id });
  logActivity(req, `Updated training session #${session.id}`);
  req.flash('success', 'Training session saved.');
  res.redirect(`/training/sessions/${session.id}`);
});

router.post('/sessions/:id/delete', (req, res) => {
  const session = findSession(req.params.id);
  if (!session) return notFound(res, 'training session');
  db.prepare('DELETE FROM training_sessions WHERE id = ?').run(session.id);
  logActivity(req, `Deleted training session #${session.id} (${session.course_name})`);
  req.flash('success', 'Training session deleted.');
  res.redirect('/training');
});

function sessionIsOpen(req, res, session) {
  if (session.status === 'scheduled') return true;
  req.flash('error', `This session is ${session.status}, so attendees can't be changed.`);
  res.redirect(`/training/sessions/${session.id}`);
  return false;
}

function addAttendees(session, employeeIds) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM training_attendees WHERE session_id = ?').get(session.id).n;
  const room = session.capacity ? Math.max(session.capacity - count, 0) : Infinity;
  const insert = db.prepare('INSERT OR IGNORE INTO training_attendees (session_id, employee_id) VALUES (?, ?)');
  let added = 0;
  db.transaction(() => {
    for (const id of employeeIds) {
      if (added >= room) break;
      added += insert.run(session.id, id).changes;
    }
  })();
  return { added, full: added < employeeIds.length && added >= room };
}

router.post('/sessions/:id/attendees', (req, res) => {
  const session = findSession(req.params.id);
  if (!session) return notFound(res, 'training session');
  if (!sessionIsOpen(req, res, session)) return;
  const employeeId = toId(req.body.employee_id);
  if (!employeeId || !db.prepare('SELECT 1 FROM employees WHERE id = ?').get(employeeId)) {
    req.flash('error', 'Please choose someone to add.');
  } else {
    const { added } = addAttendees(session, [employeeId]);
    req.flash(added ? 'success' : 'error', added ? 'Attendee added.' : 'This session is full.');
  }
  res.redirect(`/training/sessions/${session.id}`);
});

// Adds everyone whose certificate for this course is missing, expired or expiring.
router.post('/sessions/:id/add-due', (req, res) => {
  const session = findSession(req.params.id);
  if (!session) return notFound(res, 'training session');
  if (!sessionIsOpen(req, res, session)) return;
  const warningDays = res.locals.settings.expiry_warning_days;
  const latest = latestTrainingRecords();
  const due = activeStaff()
    .filter((e) => {
      const record = latest.get(`${e.id}:${session.course_id}`);
      const status = record ? expiryStatus(record.expires_on, warningDays) : 'missing';
      return status !== 'valid' && status !== 'no-expiry';
    })
    .map((e) => e.id);
  const { added, full } = addAttendees(session, due);
  logActivity(req, `Added ${added} attendee(s) to training session #${session.id}`);
  req.flash('success', `${added} people added.`);
  if (full) req.flash('warning', 'The session is now full; not everyone who needs this course could be added.');
  res.redirect(`/training/sessions/${session.id}`);
});

router.post('/sessions/:id/attendees/:employeeId/remove', (req, res) => {
  const session = findSession(req.params.id);
  if (!session) return notFound(res, 'training session');
  if (!sessionIsOpen(req, res, session)) return;
  db.prepare('DELETE FROM training_attendees WHERE session_id = ? AND employee_id = ?').run(session.id, req.params.employeeId);
  req.flash('success', 'Attendee removed.');
  res.redirect(`/training/sessions/${session.id}`);
});

// Marks the session done: everyone ticked as "attended" gets a training record.
router.post('/sessions/:id/complete', (req, res) => {
  const session = findSession(req.params.id);
  if (!session) return notFound(res, 'training session');
  if (!sessionIsOpen(req, res, session)) return;
  const attended = new Set(asArray(req.body.attended).map(toId).filter(Boolean));
  const attendees = db.prepare('SELECT employee_id FROM training_attendees WHERE session_id = ?').all(session.id);
  const completedOn = session.starts_at.slice(0, 10);
  const expiresOn = expiryFor(session, completedOn, null);

  db.transaction(() => {
    const mark = db.prepare('UPDATE training_attendees SET attended = ? WHERE session_id = ? AND employee_id = ?');
    const addRecord = db.prepare(
      'INSERT INTO training_records (employee_id, course_id, completed_on, expires_on, provider, notes) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const { employee_id } of attendees) {
      const wasThere = attended.has(employee_id);
      mark.run(wasThere ? 1 : 0, session.id, employee_id);
      if (wasThere) {
        addRecord.run(employee_id, session.course_id, completedOn, expiresOn, session.trainer, `Training session #${session.id}`);
      }
    }
    db.prepare("UPDATE training_sessions SET status = 'completed' WHERE id = ?").run(session.id);
  })();

  const count = attendees.filter((a) => attended.has(a.employee_id)).length;
  logActivity(req, `Completed training session #${session.id} (${session.course_name}) – ${count} attended`);
  req.flash('success', `Session completed. ${count} training record(s) created.`);
  res.redirect(`/training/sessions/${session.id}`);
});

module.exports = router;
