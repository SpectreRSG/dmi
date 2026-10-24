-- W-2 payroll: each employee's W-4 and DE 4 answers, and on every pay line the
-- taxes, deductions, California paid sick leave and net pay.

-- A W-2 employee's Form W-4 (federal) and DE 4 (California) answers, used to
-- work out their tax withholding. The Social Security number is stored
-- encrypted; only its last 4 digits are kept readable.
CREATE TABLE withholding_profiles (
  employee_id             INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  legal_name              TEXT NOT NULL,
  address                 TEXT NOT NULL,
  city                    TEXT NOT NULL,
  state                   TEXT NOT NULL,
  zip                     TEXT NOT NULL,
  ssn_encrypted           TEXT NOT NULL,
  ssn_last4               TEXT NOT NULL,
  fed_filing_status       TEXT NOT NULL DEFAULT 'single' CHECK (fed_filing_status IN ('single', 'married', 'head')),
  fed_multiple_jobs       INTEGER NOT NULL DEFAULT 0,            -- W-4 Step 2(c) box
  fed_dependents          DOUBLE PRECISION NOT NULL DEFAULT 0,   -- Step 3, dollars a year
  fed_other_income        DOUBLE PRECISION NOT NULL DEFAULT 0,   -- Step 4(a), a year
  fed_deductions          DOUBLE PRECISION NOT NULL DEFAULT 0,   -- Step 4(b), a year
  fed_extra               DOUBLE PRECISION NOT NULL DEFAULT 0,   -- Step 4(c), each pay period
  fed_exempt              INTEGER NOT NULL DEFAULT 0,
  ca_filing_status        TEXT NOT NULL DEFAULT 'single' CHECK (ca_filing_status IN ('single', 'married', 'head')),
  ca_allowances           INTEGER NOT NULL DEFAULT 0,            -- DE 4 line 1a
  ca_estimated_allowances INTEGER NOT NULL DEFAULT 0,            -- DE 4 line 1b
  ca_extra                DOUBLE PRECISION NOT NULL DEFAULT 0,   -- DE 4 line 2, each pay period
  ca_exempt               INTEGER NOT NULL DEFAULT 0,
  signed_name             TEXT NOT NULL,
  signed_at               TEXT NOT NULL,
  signed_ip               TEXT,
  entered_by              INTEGER REFERENCES users(id) ON DELETE SET NULL, -- the office typed it in from signed paper forms
  updated_at              TEXT NOT NULL DEFAULT app_now()
);

-- Each pay line: paid as W-2 or 1099 at the time, paid sick leave, taxes and net pay.
ALTER TABLE pay_run_items ADD COLUMN tax_form TEXT NOT NULL DEFAULT '1099' CHECK (tax_form IN ('1099', 'W-2'));
UPDATE pay_run_items i SET tax_form = e.tax_form FROM employees e WHERE e.id = i.employee_id;
ALTER TABLE pay_run_items ADD COLUMN sick_hours   DOUBLE PRECISION NOT NULL DEFAULT 0; -- paid sick leave used
ALTER TABLE pay_run_items ADD COLUMN sick_pay     DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pay_run_items ADD COLUMN sick_accrued DOUBLE PRECISION NOT NULL DEFAULT 0; -- hours earned in this pay run
ALTER TABLE pay_run_items ADD COLUMN sick_balance DOUBLE PRECISION NOT NULL DEFAULT 0; -- hours available afterwards
-- Withheld from pay (for 1099 contractors, fed_income_tax is backup withholding).
ALTER TABLE pay_run_items ADD COLUMN fed_income_tax      DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pay_run_items ADD COLUMN social_security     DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pay_run_items ADD COLUMN medicare            DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pay_run_items ADD COLUMN additional_medicare DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pay_run_items ADD COLUMN ca_income_tax       DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pay_run_items ADD COLUMN ca_sdi              DOUBLE PRECISION NOT NULL DEFAULT 0;
-- Other deductions the employee agreed to in writing (e.g. uniform, an advance).
ALTER TABLE pay_run_items ADD COLUMN deduction      DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pay_run_items ADD COLUMN deduction_note TEXT;
ALTER TABLE pay_run_items ADD COLUMN net_pay        DOUBLE PRECISION NOT NULL DEFAULT 0;
UPDATE pay_run_items SET net_pay = gross_pay;
-- The company's own taxes on top of pay.
ALTER TABLE pay_run_items ADD COLUMN employer_social_security DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pay_run_items ADD COLUMN employer_medicare        DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pay_run_items ADD COLUMN futa                     DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pay_run_items ADD COLUMN ca_ui                    DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pay_run_items ADD COLUMN ca_ett                   DOUBLE PRECISION NOT NULL DEFAULT 0;
-- The wages each capped tax was worked out on, for the yearly limits and reports.
ALTER TABLE pay_run_items ADD COLUMN ss_wages   DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pay_run_items ADD COLUMN futa_wages DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE pay_run_items ADD COLUMN ui_wages   DOUBLE PRECISION NOT NULL DEFAULT 0;
