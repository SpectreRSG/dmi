-- Everyone with an account (admins, managers, officers and clients) can write
-- incident reports, not only officers, so a report no longer needs a staff
-- record. The person who wrote it is kept by name and role as well, so it
-- still reads right if their account changes later.
ALTER TABLE incident_reports ALTER COLUMN employee_id DROP NOT NULL;
ALTER TABLE incident_reports ADD COLUMN reporter_name TEXT;
ALTER TABLE incident_reports ADD COLUMN reporter_role TEXT;

-- Reports so far were all written by officers.
UPDATE incident_reports r SET reporter_name = e.first_name || ' ' || e.last_name, reporter_role = 'officer'
  FROM employees e WHERE e.id = r.employee_id;

ALTER TABLE incident_reports ADD CONSTRAINT incident_reports_reporter_check CHECK (employee_id IS NOT NULL OR reporter_name IS NOT NULL);
CREATE INDEX incident_reports_created_by ON incident_reports (created_by, created_at);
