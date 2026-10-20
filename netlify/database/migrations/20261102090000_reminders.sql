-- Reminders by app notification: each officer is reminded of a shift 24 hours
-- and 2 hours before it starts, and 2 days before a pay period ends officers
-- and the office are reminded that time cards are due. This remembers which
-- reminders went out, so none is ever sent twice.
CREATE TABLE reminders_sent (
  kind    TEXT NOT NULL, -- 'shift_day', 'shift_soon', 'period_officers', 'period_office'
  ref     TEXT NOT NULL, -- what it was about: '<shift>:<officer>:<start>' or the pay period's first day
  sent_at TEXT NOT NULL DEFAULT app_now(),
  PRIMARY KEY (kind, ref)
);

-- When the shift's officer, or its start time, last changed (like '2026-10-20T14:30').
-- The officer is told about that straight away, so a reminder that was due
-- before then isn't sent as well.
ALTER TABLE shifts ADD COLUMN assigned_at TEXT;
UPDATE shifts SET assigned_at = replace(left(created_at, 16), ' ', 'T');

CREATE FUNCTION shifts_assigned_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.start_at IS DISTINCT FROM OLD.start_at THEN
    NEW.assigned_at := replace(left(app_now(), 16), ' ', 'T');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shifts_assigned_at BEFORE INSERT OR UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION shifts_assigned_at();
