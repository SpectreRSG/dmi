-- Hours come from the schedule: when a shift ends, its hours are recorded and
-- approved by themselves, so officers no longer fill in timesheets. The office
-- only fixes the exceptions.

-- Where each piece of hours came from: the schedule (automatic), the office,
-- or an officer's timesheet (from before hours came from the schedule).
ALTER TABLE time_entries ADD COLUMN source TEXT NOT NULL DEFAULT 'office' CHECK (source IN ('schedule', 'office', 'officer'));
UPDATE time_entries SET source = 'officer' WHERE submission_id IS NOT NULL;

-- Shifts are recorded from this date on: the start of the two-week pay period
-- this was switched on in (periods are counted from Sunday 20 July 2025).
-- Older shifts don't suddenly turn into hours.
INSERT INTO settings (key, value)
VALUES ('hours_from_schedule_since', to_char(DATE '2025-07-20' + ((CURRENT_DATE - DATE '2025-07-20') / 14) * 14, 'YYYY-MM-DD'))
ON CONFLICT (key) DO NOTHING;

-- Finds shifts that have ended but aren't recorded yet, quickly.
CREATE INDEX shifts_status_end ON shifts (status, end_at);

-- Who finalized each pay run. Their name goes in "Approved by" on the DMI timesheets.
ALTER TABLE pay_runs ADD COLUMN finalized_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Each person's DMI timesheet PDF for a finalized pay run (in the uploads
-- storage). It's made the first time someone opens it, then kept.
ALTER TABLE pay_run_items ADD COLUMN timesheet_file TEXT;
