// App configuration: where data is stored, which port to use, etc.
// You can override any of these with a ".env" file (see .env.example).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rootDir = path.join(__dirname, '..');

// Load settings from a .env file if there is one.
const envFile = path.join(rootDir, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// Everything the app saves (database + uploaded files) lives in this folder.
// Back up this folder and you have backed up everything.
const dataDir = path.resolve(process.env.DATA_DIR || path.join(rootDir, 'data'));
const uploadsDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

// The session secret signs login cookies so nobody can forge one.
// If you don't set one, we make a random one and save it in the data folder.
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(dataDir, '.session-secret');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

module.exports = {
  rootDir,
  dataDir,
  uploadsDir,
  dbFile: path.join(dataDir, 'dmi.sqlite'),
  port: Number(process.env.PORT) || 3000,
  // Set HTTPS=true once the site is served over https:// (it should be, on the internet).
  https: process.env.HTTPS === 'true',
  sessionSecret: loadSessionSecret(),
};
