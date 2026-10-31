// Looks every 5 minutes on the live site (Netlify only runs timed functions on
// the published site, not on previews): records the hours of shifts that have
// ended, tells the next wave of officers about open shifts, tells the office
// when nobody has claimed one, and sends reminders (shifts coming up, time
// cards due, payroll tax payments due). It only touches the database when
// something is due, so the database can sleep in between. See src/services/jobs.js.
//
// Like app.mjs, it lists the libraries the code it runs needs, so Netlify
// packages them (tests/netlify-function.test.js checks this). (pdf-lib: the
// pay periods for the time-card reminders live next to the timesheet PDF.)
import '@netlify/blobs';
import '@netlify/database';
import 'web-push';
import 'pdf-lib';
import jobs from '../../src/services/jobs.js';

export default async (req, context) => {
  // A new deploy may have new rules for when things are due, so it looks straight away.
  const { ran, reason, due } = await jobs.runIfDue({ version: context?.deploy?.id });
  // One line in the function's log each time, to see what it did.
  const next = due ? ` Next due ${due}.` : '';
  console.log(ran ? `Ran the background jobs (${reason}).${next}` : `Nothing due, so the database wasn't opened.${next}`);
  return new Response('ok');
};

export const config = { schedule: '*/5 * * * *' };
