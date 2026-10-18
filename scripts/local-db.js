// Starts a Postgres database on your computer, for running the app and the tests.
// It uses @netlify/database-dev, which behaves like Netlify Database, and applies
// the same migration files Netlify does.
const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'netlify', 'database', 'migrations');

// directory: where to keep the data (leave it out for a throwaway, in-memory database).
async function startLocalDatabase({ directory } = {}) {
  const { NetlifyDB } = await import('@netlify/database-dev');
  if (directory) fs.mkdirSync(directory, { recursive: true });
  const database = new NetlifyDB(directory ? { directory } : {});
  const url = await database.start();
  await database.applyMigrations(MIGRATIONS);
  return { url, stop: () => database.stop() };
}

module.exports = { startLocalDatabase };
