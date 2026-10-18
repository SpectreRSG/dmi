// Sends email through your email provider's outgoing mail server (SMTP).
// Works with almost any provider: Google Workspace, Microsoft 365, Resend,
// Postmark, SendGrid, Amazon SES… Set it up under Settings → Email.
const nodemailer = require('nodemailer');
const db = require('../db');
const { decrypt } = require('../secureData');

function emailIsSetUp(settings) {
  return Boolean(settings.smtp_host && settings.mail_from);
}

// One connection, reused for several emails, given up on quickly if the
// server doesn't answer (pages shouldn't hang waiting for email).
async function openMailer(settings) {
  const stored = (await db.get("SELECT value FROM settings WHERE key = 'smtp_password'"))?.value;
  const port = Number(settings.smtp_port) || 587;
  const transport = nodemailer.createTransport({
    host: settings.smtp_host,
    port,
    secure: port === 465, // 465 = encrypted from the start; 587 upgrades to encrypted (STARTTLS)
    auth: settings.smtp_user ? { user: settings.smtp_user, pass: stored ? await decrypt(stored) : '' } : undefined,
    pool: true,
    maxConnections: 1,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
  });
  return {
    send: (message) => transport.sendMail({ from: settings.mail_from, replyTo: settings.mail_reply_to || undefined, ...message }),
    close: () => transport.close(),
  };
}

module.exports = { emailIsSetUp, openMailer };
