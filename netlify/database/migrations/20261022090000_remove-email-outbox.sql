-- Officers now view and download their approved timesheet in their account,
-- instead of getting it by email, so the email outbox and settings go away.
DROP TABLE IF EXISTS email_outbox;
DELETE FROM settings WHERE key IN ('smtp_host', 'smtp_port', 'smtp_user', 'smtp_password', 'mail_from', 'mail_reply_to');
