-- California's new-hire report (DE 34): the day the office reported each new
-- W-2 employee to the EDD (due within 20 days of their first day of work).
ALTER TABLE employees ADD COLUMN new_hire_reported_on TEXT;
