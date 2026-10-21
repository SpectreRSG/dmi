-- Officers turn on app notifications (shift reminders, open shifts) before
-- they can use their pages. The office can let in an officer whose phone
-- can't get notifications (for example an iPhone too old for them).
ALTER TABLE users ADD COLUMN push_exempt INTEGER NOT NULL DEFAULT 0;
