-- A demo client account, for trying the client pages (their sites' schedule,
-- and asking for shifts). It signs in as demo.client@example.com; the password
-- was given to the site owner separately, and only its scrambled (hashed) form
-- is stored here. It belongs to a pretend client, "Demo Client", with two
-- pretend sites, and no shifts. Deactivate the sign-in under User accounts when
-- it's no longer needed. (Skipped if an account with that email already exists.)
WITH client AS (
  INSERT INTO clients (name, contact_name, contact_email, address, notes)
  SELECT 'Demo Client', 'Demo Client', 'demo.client@example.com', '100 Demo Way',
         'Pretend client for trying the client pages. Not a real customer: deactivate its sign-in under User accounts when done.'
  WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = 'demo.client@example.com')
  RETURNING id
),
demo_sites AS (
  INSERT INTO sites (client_id, name, address, instructions)
  SELECT client.id, site.name, site.address, 'Pretend site for testing. Not a real place.'
  FROM client, (VALUES ('Demo Site: Front Gate', '100 Demo Way'), ('Demo Site: Warehouse', '102 Demo Way')) AS site (name, address)
)
INSERT INTO users (name, email, password_hash, role, client_id)
SELECT 'Demo Client', 'demo.client@example.com', 'scrypt$fa5e11db1c48acf1d103b91bacdc4e10$f532fa7e112f82191d3129ed1908046cd7821f767c899090f36a47a34083c9b185a424d9d6b015a60771c050438c7b0af8e82c94d47726aa4f04a7e01db60281', 'client', id FROM client;
