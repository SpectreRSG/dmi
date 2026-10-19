// Runs every 5 minutes on the live site (Netlify only runs timed functions on
// the published site, not on previews): records the hours of shifts that have
// ended, tells the next wave of officers about open shifts, and tells the
// office when nobody has claimed one. See src/services/jobs.js.
//
// Like app.mjs, it lists the libraries the code it runs needs, so Netlify
// packages them (tests/netlify-function.test.js checks this).
import '@netlify/database';
import 'web-push';
import jobs from '../../src/services/jobs.js';

export default async () => {
  await jobs.runDueJobs();
  return new Response('ok');
};

export const config = { schedule: '*/5 * * * *' };
