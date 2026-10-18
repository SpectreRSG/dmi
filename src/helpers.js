// Small helpers shared by the route files.
const db = require('./db');

// Tidies form input: trims spaces and turns empty boxes into null (empty).
function clean(body, fields) {
  const out = {};
  for (const field of fields) {
    let value = body?.[field];
    if (Array.isArray(value)) value = value[0];
    if (typeof value === 'string') value = value.trim();
    out[field] = value === '' || value === undefined ? null : value;
  }
  return out;
}

// Turns "12.50" into 12.5. Empty -> fallback. Not a number -> NaN.
function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

// Turns a form value into a database id (a whole number above 0) or null.
function toId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Always returns an array, even if the form sent one value or none.
function asArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

// Records "who did what" in the activity log.
function logActivity(req, action) {
  db.prepare('INSERT INTO activity_log (user_id, action) VALUES (?, ?)').run(req.user?.id ?? null, action);
}

function notFound(res, what = 'page') {
  res.status(404).render('error', { title: 'Not found', message: `Sorry, that ${what} could not be found.` });
}

// Express route parameters like ":id" should be numbers; anything else is a 404.
function numericIdParam(router) {
  router.param('id', (req, res, next, id) => (/^\d+$/.test(id) ? next() : next('route')));
}

// Sends the user back to the page they came from (or a fallback).
function goBack(req, res, fallback) {
  const referer = req.get('Referer');
  try {
    const url = new URL(referer);
    if (url.host === req.get('host')) return res.redirect(url.pathname + url.search);
  } catch {
    // no or bad Referer header – use the fallback
  }
  res.redirect(fallback);
}

// True if the database error means "other records still point at this one".
function isInUseError(err) {
  return err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY';
}

function employeeName(e) {
  return e ? `${e.first_name} ${e.last_name}` : '';
}

module.exports = {
  clean,
  toNumber,
  toId,
  asArray,
  logActivity,
  notFound,
  numericIdParam,
  goBack,
  isInUseError,
  employeeName,
};
