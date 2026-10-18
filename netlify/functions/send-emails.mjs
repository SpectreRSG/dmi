// Every 10 minutes on the live site: sends any emails still waiting in the
// outbox, for example because email was set up after timesheets were approved,
// or the mail server was down when someone pressed Approve.
// (Netlify only runs scheduled functions on the live site, not on previews.)

// The libraries the outbox uses, listed so Netlify packages them (see app.mjs).
import '@netlify/blobs';
import '@netlify/database';
import 'multer';
import 'nodemailer';
import outbox from '../../src/services/outbox.js';
import settingsStore from '../../src/settings.js';

export default async () => {
  const settings = await settingsStore.getSettings();
  const result = await outbox.sendWaitingEmails(settings, { timeBudgetMs: 20000 });
  if (result.sent || result.failed) console.log(`Emails: ${result.sent} sent, ${result.failed} failed, ${result.waiting} still waiting.`);
  if (result.error) console.log(`Email problem: ${result.error}`);
};

export const config = { schedule: '*/10 * * * *' };
