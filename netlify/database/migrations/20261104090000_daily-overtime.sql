-- California daily overtime: hours over 8 in a workday pay the overtime rate,
-- over 12 pay double time (twice the hourly rate), and the 7th day in a row in
-- a workweek has its own rule. Pay lines now keep double time separately.
-- (The rule is switched on and off under Settings; see src/services/payroll.js.)
ALTER TABLE pay_run_items ADD COLUMN double_time_hours DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pay_run_items ADD COLUMN double_time_pay   DOUBLE PRECISION NOT NULL DEFAULT 0;
