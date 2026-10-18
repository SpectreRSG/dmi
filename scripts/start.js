// "npm start": starts a database on your computer (kept in data/pg), then the website.
// (On Netlify none of this runs: Netlify provides the database and runs the app itself.)
const fs = require('fs');
const path = require('path');
const { startLocalDatabase } = require('./local-db');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

(async () => {
  if (!process.env.DATABASE_URL) {
    const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
    try {
      const { url } = await startLocalDatabase({ directory: path.join(dataDir, 'pg') });
      process.env.DATABASE_URL = url;
    } catch (err) {
      console.error('Could not start the local database. Is the app already running in another window?');
      console.error(err.message);
      process.exit(1);
    }
  }
  require('../src/server');
})();
