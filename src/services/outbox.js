// The email outbox. Emails are saved here first, then sent. If the mail server
// is down, or email isn't set up yet, they simply wait and are tried again
// (every 10 minutes on the live site, or with "Send waiting emails").
const db = require('../db');
const { readUpload } = require('../uploads');
const { emailIsSetUp, openMailer } = require('./mailer');

const MAX_AUTOMATIC_TRIES = 3;
const STUCK_AFTER_MS = 10 * 60 * 1000; // a send that never finished (e.g. the server stopped)

// `conn` is the database or a transaction. Returns the new email's id.
function queueEmail(conn, { to, subject, body, attachments = [], submissionId = null }) {
  return conn.insert(
    'INSERT INTO email_outbox (to_address, subject, body, attachments, submission_id) VALUES (?, ?, ?, ?, ?)',
    to,
    subject,
    body,
    JSON.stringify(attachments),
    submissionId
  );
}

// Takes an email for sending, unless another sender already has it.
async function claim(id) {
  const now = Date.now();
  const { changes } = await db.run(
    `UPDATE email_outbox SET status = 'sending', attempts = attempts + 1, claimed_at = ?
     WHERE id = ? AND (status IN ('waiting', 'failed') OR (status = 'sending' AND claimed_at < ?))`,
    now,
    id,
    now - STUCK_AFTER_MS
  );
  return changes === 1;
}

// Sends waiting emails: the ones listed in `ids`, or else everything due.
// Stops starting new ones after `timeBudgetMs`, and stops at the first
// failure (the server is probably down; the rest stay waiting).
// Returns { sent, failed, waiting, error, notSetUp }.
async function sendWaitingEmails(settings, { ids = null, timeBudgetMs = 4000 } = {}) {
  const pending = await db.all(
    `SELECT id FROM email_outbox
     WHERE (status = 'waiting' OR (status = 'failed' AND attempts < ?) OR (status = 'sending' AND claimed_at < ?))
     ${ids ? 'AND id = ANY(?::int[])' : ''} ORDER BY id LIMIT 100`,
    MAX_AUTOMATIC_TRIES,
    Date.now() - STUCK_AFTER_MS,
    ...(ids ? [ids] : [])
  );
  const result = { sent: 0, failed: 0, waiting: pending.length, error: null, notSetUp: !emailIsSetUp(settings) };
  if (result.notSetUp || !pending.length) return result;

  const started = Date.now();
  let mailer = null;
  try {
    for (const { id } of pending) {
      if (Date.now() - started > timeBudgetMs) break;
      if (!(await claim(id))) continue;
      const email = await db.get('SELECT * FROM email_outbox WHERE id = ?', id);
      try {
        const attachments = [];
        for (const a of email.attachments) {
          const content = await readUpload(a.file);
          if (!content) throw new Error(`The attached file ${a.filename} is missing.`);
          attachments.push({ filename: a.filename, content, contentType: 'application/pdf' });
        }
        mailer ??= await openMailer(settings);
        await mailer.send({ to: email.to_address, subject: email.subject, text: email.body, attachments });
        await db.run("UPDATE email_outbox SET status = 'sent', sent_at = app_now(), last_error = NULL WHERE id = ?", id);
        result.sent += 1;
      } catch (err) {
        await db.run("UPDATE email_outbox SET status = 'failed', last_error = ? WHERE id = ?", String(err.message || err).slice(0, 500), id);
        result.failed += 1;
        result.error = err.message || String(err);
        break;
      }
    }
  } finally {
    mailer?.close();
  }
  result.waiting -= result.sent + result.failed;
  return result;
}

// Puts an email back in the queue (for "Send again" after it failed).
function retryEmail(id) {
  return db.run("UPDATE email_outbox SET status = 'waiting', attempts = 0, last_error = NULL WHERE id = ? AND status = 'failed'", id);
}

module.exports = { queueEmail, sendWaitingEmails, retryEmail, MAX_AUTOMATIC_TRIES };
