-- A test officer account, for trying the officer pages (My schedule,
-- Timesheets, Tax forms). It signs in as test.officer@example.com; the password
-- was given to the site owner separately, and only its scrambled (hashed) form
-- is stored here. Deactivate it under User accounts when it's no longer needed.
-- (Skipped if an account with that email already exists.)
WITH officer AS (
  INSERT INTO employees (first_name, last_name, email, position, license_required, status, notes)
  SELECT 'Test', 'Officer', 'test.officer@example.com', 'Security officer', 0, 'active',
         'Test account for trying the officer pages. Deactivate its sign-in under User accounts when done.'
  WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = 'test.officer@example.com')
  RETURNING id
)
INSERT INTO users (name, email, password_hash, role, employee_id)
SELECT 'Test Officer', 'test.officer@example.com', 'scrypt$f62bed089daaa6099e800a1e4afcb030$424ee5905ba986cf185a0e9a63d674de44bc4ea6c4e8878fff101d54c46cb1582fd1b7083f4147fcdfa3f53e65c038cfae792d4c84d8553a2dd60a66c374434c', 'officer', id FROM officer;
