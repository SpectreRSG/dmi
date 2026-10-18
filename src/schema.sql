-- ============================================================================
-- DATABASE TABLES
-- Think of each table as a spreadsheet tab: every row is one record, every
-- column is one piece of information about it.
-- "IF NOT EXISTS" makes this file safe to run every time the app starts.
-- ============================================================================

-- People who can log in to this admin website.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('admin', 'manager')),
  active        INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Login sessions (keeps people signed in between page loads).
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Company-wide settings such as the company name and overtime rules.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Guards and other staff members.
CREATE TABLE IF NOT EXISTS employees (
  id                      INTEGER PRIMARY KEY,
  first_name              TEXT NOT NULL,
  last_name               TEXT NOT NULL,
  email                   TEXT,
  phone                   TEXT,
  address                 TEXT,
  position                TEXT,
  employment_type         TEXT,
  hourly_rate             REAL NOT NULL DEFAULT 0,
  start_date              TEXT,
  end_date                TEXT,
  license_required        INTEGER NOT NULL DEFAULT 1,
  license_number          TEXT,
  license_expiry          TEXT,
  emergency_contact_name  TEXT,
  emergency_contact_phone TEXT,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  notes                   TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Customers who hire the firm.
CREATE TABLE IF NOT EXISTS clients (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  contact_name  TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  address       TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Places where guards work. Each site belongs to one client.
CREATE TABLE IF NOT EXISTS sites (
  id           INTEGER PRIMARY KEY,
  client_id    INTEGER NOT NULL REFERENCES clients(id),
  name         TEXT NOT NULL,
  address      TEXT,
  instructions TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Planned work (the roster). employee_id is empty for an unfilled shift.
-- Dates and times are stored as text like '2026-10-20T22:00'.
CREATE TABLE IF NOT EXISTS shifts (
  id            INTEGER PRIMARY KEY,
  site_id       INTEGER NOT NULL REFERENCES sites(id),
  employee_id   INTEGER REFERENCES employees(id),
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_shifts_start ON shifts(start_at);
CREATE INDEX IF NOT EXISTS idx_shifts_employee ON shifts(employee_id, start_at);

-- A pay period being prepared (draft) or already paid (finalized).
CREATE TABLE IF NOT EXISTS pay_runs (
  id           INTEGER PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized')),
  notes        TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  finalized_at TEXT
);

-- One line per staff member in a pay run (a "copy" of the numbers at the time).
CREATE TABLE IF NOT EXISTS pay_run_items (
  id                  INTEGER PRIMARY KEY,
  pay_run_id          INTEGER NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
  employee_id         INTEGER NOT NULL REFERENCES employees(id),
  regular_hours       REAL NOT NULL DEFAULT 0,
  overtime_hours      REAL NOT NULL DEFAULT 0,
  hourly_rate         REAL NOT NULL DEFAULT 0,
  overtime_multiplier REAL NOT NULL DEFAULT 1.5,
  regular_pay         REAL NOT NULL DEFAULT 0,
  overtime_pay        REAL NOT NULL DEFAULT 0,
  adjustment          REAL NOT NULL DEFAULT 0,
  adjustment_note     TEXT,
  gross_pay           REAL NOT NULL DEFAULT 0
);

-- Hours actually worked (timesheets). They must be approved before they are paid.
CREATE TABLE IF NOT EXISTS time_entries (
  id            INTEGER PRIMARY KEY,
  employee_id   INTEGER NOT NULL REFERENCES employees(id),
  site_id       INTEGER REFERENCES sites(id),
  shift_id      INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  notes         TEXT,
  approved_by   INTEGER REFERENCES users(id),
  approved_at   TEXT,
  pay_run_id    INTEGER REFERENCES pay_runs(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_time_entries_employee ON time_entries(employee_id, start_at);
CREATE INDEX IF NOT EXISTS idx_time_entries_status ON time_entries(status);

-- Contracts and agreements, with clients, staff or anyone else.
CREATE TABLE IF NOT EXISTS contracts (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  contract_type TEXT NOT NULL,
  party_type    TEXT NOT NULL CHECK (party_type IN ('client', 'employee', 'other')),
  client_id     INTEGER REFERENCES clients(id),
  employee_id   INTEGER REFERENCES employees(id),
  other_party   TEXT,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'ended', 'terminated')),
  signed_on     TEXT,
  start_date    TEXT,
  end_date      TEXT,
  value         REAL,
  file_name     TEXT,
  file_original TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Types of training or certification (e.g. First Aid). validity_months is
-- how long a certificate lasts; leave it empty if it never expires.
CREATE TABLE IF NOT EXISTS training_courses (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description     TEXT,
  validity_months INTEGER,
  required        INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Proof that a staff member completed a course.
CREATE TABLE IF NOT EXISTS training_records (
  id                 INTEGER PRIMARY KEY,
  employee_id        INTEGER NOT NULL REFERENCES employees(id),
  course_id          INTEGER NOT NULL REFERENCES training_courses(id),
  completed_on       TEXT NOT NULL,
  expires_on         TEXT,
  provider           TEXT,
  certificate_number TEXT,
  file_name          TEXT,
  file_original      TEXT,
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_training_records_employee ON training_records(employee_id, course_id);

-- Planned training classes.
CREATE TABLE IF NOT EXISTS training_sessions (
  id         INTEGER PRIMARY KEY,
  course_id  INTEGER NOT NULL REFERENCES training_courses(id),
  starts_at  TEXT NOT NULL,
  location   TEXT,
  trainer    TEXT,
  capacity   INTEGER,
  status     TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Who is booked into each training class.
CREATE TABLE IF NOT EXISTS training_attendees (
  session_id  INTEGER NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  attended    INTEGER,
  PRIMARY KEY (session_id, employee_id)
);

-- A history of who did what, for accountability.
CREATE TABLE IF NOT EXISTS activity_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
