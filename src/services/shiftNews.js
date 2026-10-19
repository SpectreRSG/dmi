// Tells officers (by app notification) when the office changes their upcoming
// shifts, so they never have to keep checking the schedule.
const time = require('../time');
const { notifyEmployees } = require('./notify');

const when = (s) => `${time.fmtDay(s.start_at)}, ${time.fmtRange(s.start_at, s.end_at)}`;
const upcoming = (s) => Boolean(s && s.status === 'scheduled' && s.employee_id && s.start_at > time.nowStr());
const calendar = (s) => `/my/schedule?month=${s.start_at.slice(0, 7)}`;

// `before` and `after` are the shift (with site_name) before and after the
// office changed it: null when it was just made, or has been deleted.
async function tellAboutShiftChange(before, after) {
  const was = upcoming(before) ? before : null;
  const now = upcoming(after) ? after : null;
  if (was && now?.employee_id !== was.employee_id) {
    await notifyEmployees([was.employee_id], {
      title: 'Shift removed',
      body: `You're no longer on ${when(was)} at ${was.site_name}.`,
      url: calendar(was),
    });
  }
  if (now && now.employee_id !== was?.employee_id) {
    await notifyEmployees([now.employee_id], { title: 'New shift', body: `${when(now)} at ${now.site_name}.`, url: calendar(now) });
  } else if (now && (now.start_at !== was.start_at || now.end_at !== was.end_at || now.site_id !== was.site_id)) {
    await notifyEmployees([now.employee_id], {
      title: 'Shift changed',
      body: `Now ${when(now)} at ${now.site_name} (was ${when(was)}${now.site_id !== was.site_id ? ` at ${was.site_name}` : ''}).`,
      url: calendar(now),
    });
  }
}

// Several new shifts at once (a repeating shift) make one notification.
async function tellAboutNewShifts(employeeId, shifts) {
  const coming = shifts.filter((s) => s.start_at > time.nowStr());
  if (!employeeId || !coming.length) return;
  const [first] = coming;
  await notifyEmployees([employeeId], {
    title: coming.length === 1 ? 'New shift' : `${coming.length} new shifts`,
    body: coming.length === 1 ? `${when(first)} at ${first.site_name}.` : `At ${first.site_name}, starting ${when(first)}.`,
    url: calendar(first),
  });
}

module.exports = { tellAboutShiftChange, tellAboutNewShifts };
