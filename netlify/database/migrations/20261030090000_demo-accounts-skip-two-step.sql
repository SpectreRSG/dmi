-- The two demo accounts (the Test Officer and the Demo Client) sign in with
-- just their password: no authenticator-app code and no passkey. That only
-- counts while they're officer or client accounts (see twoStep.isExempt), so
-- making either one a manager or admin brings two-step sign-in back.
-- Nothing else can turn this on; every other account works as before.
ALTER TABLE users ADD COLUMN two_step_exempt INTEGER NOT NULL DEFAULT 0;

UPDATE users SET two_step_exempt = 1
WHERE lower(email) IN ('test.officer@example.com', 'demo.client@example.com');

-- Clear any two-step sign-in they already set up, so nothing asks for it.
UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE two_step_exempt = 1;
DELETE FROM recovery_codes WHERE user_id IN (SELECT id FROM users WHERE two_step_exempt = 1);
DELETE FROM trusted_devices WHERE user_id IN (SELECT id FROM users WHERE two_step_exempt = 1);
DELETE FROM passkeys WHERE user_id IN (SELECT id FROM users WHERE two_step_exempt = 1);
