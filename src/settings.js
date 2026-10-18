// Company-wide settings, editable on the Settings page.
const db = require('./db');

const DEFAULTS = {
  company_name: 'DMI',
  currency_symbol: '$',
  overtime_weekly_hours: '40', // hours per week before overtime starts (0 = no overtime)
  overtime_multiplier: '1.5', // overtime pays this many times the normal rate
  expiry_warning_days: '30', // warn this many days before licenses/training/contracts expire
};

function getSettings() {
  const saved = Object.fromEntries(
    db.prepare('SELECT key, value FROM settings').all().map((row) => [row.key, row.value])
  );
  const s = { ...DEFAULTS, ...saved };
  return {
    company_name: s.company_name,
    currency_symbol: s.currency_symbol,
    overtime_weekly_hours: Number(s.overtime_weekly_hours),
    overtime_multiplier: Number(s.overtime_multiplier),
    expiry_warning_days: Number(s.expiry_warning_days),
  };
}

function saveSettings(values) {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  db.transaction(() => {
    for (const [key, value] of Object.entries(values)) {
      if (key in DEFAULTS) upsert.run(key, String(value));
    }
  })();
}

module.exports = { getSettings, saveSettings };
