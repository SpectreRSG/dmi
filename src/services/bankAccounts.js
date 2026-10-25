// Direct deposit accounts: reading the form, saving, and the admin approval
// an officer's own change needs before pay goes to it. (California lets
// people choose a paper check instead, so it's always optional.)
const db = require('../db');
const time = require('../time');
const { encrypt, decrypt } = require('../secureData');
const { routingOk } = require('./nacha');

const TYPES = { checking: 'Checking', savings: 'Savings' };

async function accountsFor(employeeId) {
  const rows = await db.all("SELECT * FROM bank_accounts WHERE employee_id = ? AND status IN ('active', 'pending')", employeeId);
  return { active: rows.find((r) => r.status === 'active') || null, pending: rows.find((r) => r.status === 'pending') || null };
}

// "Checking …6789 at 021000021"
const describe = (a) => (a ? `${TYPES[a.account_type]} …${a.account_last4} at ${a.routing_number}` : '');

function readForm(body) {
  const values = {
    holder_name: String(body.holder_name || '').trim().slice(0, 60),
    account_type: TYPES[body.account_type] ? body.account_type : null,
    routing_number: String(body.routing_number || '').replace(/\D/g, ''),
  };
  const account = String(body.account_number || '').replace(/[\s-]/g, '');
  const confirm = String(body.account_confirm || '').replace(/[\s-]/g, '');
  let error = null;
  if (!values.holder_name) error = 'Enter the name on the account.';
  else if (!values.account_type) error = 'Choose checking or savings.';
  else if (!routingOk(values.routing_number)) error = "That routing number doesn't look right: it's the 9 digits at the bottom left of a check.";
  else if (!/^\d{4,17}$/.test(account)) error = 'The account number is 4 to 17 digits.';
  else if (account !== confirm) error = "The two account numbers don't match.";
  else if (!body.consent) error = 'Tick the box to agree to be paid by direct deposit.';
  return { values, account, error };
}

// Saves an account. The office's entry (from a signed form) is active at once;
// an officer's own waits for approval, and their current account keeps being used until then.
async function saveAccount(employeeId, values, account, { enteredBy = null } = {}) {
  const row = {
    employee_id: employeeId,
    holder_name: values.holder_name,
    account_type: values.account_type,
    routing_number: values.routing_number,
    account_encrypted: await encrypt(account),
    account_last4: account.slice(-4),
    consent_at: time.nowStr(),
    entered_by: enteredBy,
  };
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM bank_accounts WHERE employee_id = ? AND status = 'pending'", employeeId);
    if (enteredBy) await tx.run("UPDATE bank_accounts SET status = 'replaced' WHERE employee_id = ? AND status = 'active'", employeeId);
    await tx.run(
      `INSERT INTO bank_accounts (employee_id, status, holder_name, account_type, routing_number, account_encrypted, account_last4, consent_at, entered_by, approved_by, approved_at)
       VALUES (@employee_id, @status, @holder_name, @account_type, @routing_number, @account_encrypted, @account_last4, @consent_at, @entered_by, @entered_by, @approved_at)`,
      { ...row, status: enteredBy ? 'active' : 'pending', approved_at: enteredBy ? time.nowStr() : null }
    );
  });
}

async function approvePending(employeeId, adminId) {
  return db.transaction(async (tx) => {
    const pending = await tx.get("SELECT id FROM bank_accounts WHERE employee_id = ? AND status = 'pending'", employeeId);
    if (!pending) return false;
    await tx.run("UPDATE bank_accounts SET status = 'replaced' WHERE employee_id = ? AND status = 'active'", employeeId);
    await tx.run("UPDATE bank_accounts SET status = 'active', approved_by = ?, approved_at = app_now() WHERE id = ?", adminId, pending.id);
    return true;
  });
}

function rejectPending(employeeId) {
  return db.run("DELETE FROM bank_accounts WHERE employee_id = ? AND status = 'pending'", employeeId);
}

// Back to paper checks.
async function stopDirectDeposit(employeeId) {
  await db.run("DELETE FROM bank_accounts WHERE employee_id = ? AND status = 'pending'", employeeId);
  await db.run("UPDATE bank_accounts SET status = 'replaced' WHERE employee_id = ? AND status = 'active'", employeeId);
}

// Active accounts for these people, with the account numbers unscrambled (for the bank file only).
async function activeAccounts(employeeIds) {
  if (!employeeIds.length) return new Map();
  const rows = await db.all("SELECT * FROM bank_accounts WHERE status = 'active' AND employee_id = ANY(?::int[])", employeeIds);
  const map = new Map();
  for (const r of rows) map.set(r.employee_id, { ...r, account: await decrypt(r.account_encrypted) });
  return map;
}

module.exports = { TYPES, accountsFor, describe, readForm, saveAccount, approvePending, rejectPending, stopDirectDeposit, activeAccounts };
