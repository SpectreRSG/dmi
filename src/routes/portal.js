// The public schedule portal: officers and clients type a passphrase and see
// a month of shifts. No account needed, and it never shows pay or phone numbers.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const time = require('../time');
const { fingerprint } = require('../passphrase');
const { entryHours, round2 } = require('../services/payroll');
const { TIMEZONES } = require('../settings');

const router = express.Router();

// Schedules are private: don't let the browser keep a copy (e.g. on a shared phone after signing out).
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Officers see colleagues as "Jordan S." rather than full names.
const shortName = (s) => (s.employee_id ? `${s.first_name} ${s.last_name.charAt(0)}.` : null);

function portalKey(req) {
  return `portal|${req.ip}`;
}

// The passphrase this browser signed in with, if it still works.
async function currentAccess(req) {
  const signedIn = req.session.portal;
  if (!signedIn) return null;
  const access = await db.get(
    `SELECT pa.*, e.first_name, e.last_name, e.status AS employee_status, si.name AS site_name, si.client_id AS site_client_id,
            sc.name AS site_client_name, c.name AS client_name
     FROM portal_access pa
     LEFT JOIN employees e ON e.id = pa.employee_id
     LEFT JOIN sites si ON si.id = pa.site_id
     LEFT JOIN clients sc ON sc.id = si.client_id
     LEFT JOIN clients c ON c.id = pa.client_id
     WHERE pa.id = ?`,
    signedIn.id
  );
  // Turned off, replaced with a new passphrase, or past its expiry date: sign out.
  const valid =
    access &&
    access.passphrase_hash === signedIn.hash &&
    (!access.expires_on || access.expires_on >= time.todayStr()) &&
    (access.scope !== 'employee' || access.employee_status === 'active');
  if (!valid) {
    delete req.session.portal;
    return null;
  }
  return access;
}

function renderSignIn(res, error, status = 200) {
  res.status(status).render('portal/sign-in', { title: 'View your schedule', error });
}

router.get('/', async (req, res) => {
  const access = await currentAccess(req);
  if (!access) return renderSignIn(res, null);

  const today = time.todayStr();
  const month = time.isValidMonth(req.query.month) ? req.query.month : today.slice(0, 7);
  const { first, last } = time.monthRange(month);
  const range = [`${first}T00:00`, `${time.addDays(last, 1)}T00:00`];

  const where = { employee: 's.employee_id = ?', site: 's.site_id = ?', client: 'si.client_id = ?' }[access.scope];
  const scopeId = { employee: access.employee_id, site: access.site_id, client: access.client_id }[access.scope];
  const shifts = await db.all(
    `SELECT s.id, s.site_id, s.employee_id, s.start_at, s.end_at, s.break_minutes, s.status, s.notes,
            si.name AS site_name, si.address AS site_address, si.instructions AS site_instructions, c.name AS client_name,
            e.first_name, e.last_name
     FROM shifts s
     JOIN sites si ON si.id = s.site_id
     JOIN clients c ON c.id = si.client_id
     LEFT JOIN employees e ON e.id = s.employee_id
     WHERE ${where} AND s.start_at >= ? AND s.start_at < ?
     ORDER BY s.start_at, si.name, s.id`,
    scopeId,
    ...range
  );

  // Officers also see the training sessions they're booked on.
  const training =
    access.scope === 'employee'
      ? await db.all(
          `SELECT ts.starts_at, ts.duration_minutes, ts.location, c.name AS course_name
           FROM training_attendees ta
           JOIN training_sessions ts ON ts.id = ta.session_id
           JOIN training_courses c ON c.id = ts.course_id
           WHERE ta.employee_id = ? AND ts.status = 'scheduled' AND ts.starts_at >= ? AND ts.starts_at < ?
           ORDER BY ts.starts_at`,
          access.employee_id,
          ...range
        )
      : [];

  const items = [
    ...shifts.map((s) => ({
      kind: 'shift',
      start_at: s.start_at,
      end_at: s.end_at,
      status: s.status,
      site: s.site_name,
      client: s.client_name,
      address: s.site_address,
      instructions: s.site_instructions,
      notes: s.notes,
      guard: shortName(s),
      hours: entryHours(s),
    })),
    ...training.map((t) => ({
      kind: 'training',
      start_at: t.starts_at,
      end_at: new Date(Date.parse(`${t.starts_at}:00Z`) + t.duration_minutes * 60000).toISOString().slice(0, 16),
      course: t.course_name,
      location: t.location,
    })),
  ].sort((a, b) => a.start_at.localeCompare(b.start_at));

  const days = [];
  for (const item of items) {
    const date = item.start_at.slice(0, 10);
    if (days.at(-1)?.date !== date) days.push({ date, items: [] });
    days.at(-1).items.push(item);
  }

  const live = items.filter((i) => i.kind === 'shift' && i.status !== 'cancelled');
  const who = {
    employee: `${access.first_name} ${access.last_name}`,
    site: `${access.site_name} (${access.site_client_name})`,
    client: access.client_name,
  }[access.scope];

  // Each site's details, shown once at the top for site and client views.
  const sites = access.scope === 'employee' ? [] : await db.all(
    `SELECT name, address, instructions FROM sites WHERE ${access.scope === 'site' ? 'id' : 'client_id'} = ? AND active = 1 ORDER BY name`,
    scopeId
  );

  res.render('portal/month', {
    title: `${time.fmtMonth(month)} schedule`,
    access,
    who,
    month,
    prevMonth: time.addMonths(first, -1).slice(0, 7),
    nextMonth: time.addMonths(first, 1).slice(0, 7),
    thisMonth: today.slice(0, 7),
    today,
    days,
    sites,
    zoneName: TIMEZONES.find(([zone]) => zone === res.locals.settings.timezone)?.[1] ?? res.locals.settings.timezone,
    totals: {
      shifts: live.length,
      hours: round2(live.reduce((sum, i) => sum + i.hours, 0)),
      unfilled: live.filter((i) => !i.guard).length,
    },
  });
});

router.post('/', async (req, res, next) => {
  const key = portalKey(req);
  if (await auth.isLockedOut(key)) {
    return renderSignIn(res, 'Too many wrong passphrases. Please wait 15 minutes and try again.', 429);
  }
  const hash = await fingerprint(req.body.passphrase);
  const access = await db.get(
    `SELECT pa.id, pa.scope, pa.expires_on, e.status AS employee_status
     FROM portal_access pa LEFT JOIN employees e ON e.id = pa.employee_id
     WHERE pa.passphrase_hash = ?`,
    hash
  );
  const works = access && (!access.expires_on || access.expires_on >= time.todayStr()) && (access.scope !== 'employee' || access.employee_status === 'active');
  if (!works) {
    await auth.recordFailedLogin(key);
    return renderSignIn(res, 'That passphrase is not right, or it has been turned off. Check with your office.', 400);
  }
  await auth.clearFailedLogins(key);

  // A fresh session (keeping any admin login in this browser) stops "session fixation".
  const { userId } = req.session;
  req.session.regenerate(async (err) => {
    if (err) return next(err);
    try {
      if (userId) req.session.userId = userId;
      req.session.portal = { id: access.id, hash };
      await db.run('UPDATE portal_access SET last_used_at = app_now() WHERE id = ?', access.id);
      res.redirect('/portal');
    } catch (error) {
      next(error);
    }
  });
});

router.post('/sign-out', (req, res) => {
  delete req.session.portal;
  res.redirect('/portal');
});

module.exports = router;
