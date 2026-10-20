-- Shift requests can repeat: the first date, then every ticked weekday up to a
-- last date (like repeating shifts on the schedule). One approval covers them
-- all; the shifts are then offered to officers about two weeks ahead.
ALTER TABLE shift_requests ADD COLUMN repeat_days TEXT;  -- e.g. '0,2,4' (0 = Monday … 6 = Sunday); empty = one date only
ALTER TABLE shift_requests ADD COLUMN repeat_until TEXT; -- the last date it repeats on
ALTER TABLE shift_requests ADD COLUMN last_end_at TEXT;  -- when its last shift ends (splits "current" from "history")
UPDATE shift_requests SET last_end_at = end_at;
ALTER TABLE shift_requests ALTER COLUMN last_end_at SET NOT NULL;
CREATE INDEX shift_requests_client_last ON shift_requests (client_id, last_end_at);

-- Finds a request's shifts that haven't been offered to officers yet.
CREATE INDEX shifts_request ON shifts (request_id) WHERE request_id IS NOT NULL;
