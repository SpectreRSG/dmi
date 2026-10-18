// App configuration: where things are stored, which port to use, etc.
// On your computer you can override these with a ".env" file (see .env.example).
// On Netlify they come from the project's environment variables.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rootDir = path.join(__dirname, '..');

// Load settings from a .env file if there is one.
const envFile = path.join(rootDir, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// True when the app is running on Netlify (inside a Netlify Function).
const onNetlify = Boolean(globalThis.Netlify || process.env.NETLIFY_BLOBS_CONTEXT || process.env.AWS_LAMBDA_FUNCTION_NAME);

// On your computer, the local database and uploaded files live in this folder.
// (On Netlify they live in Netlify Database and Netlify Blobs instead.)
const dataDir = path.resolve(process.env.DATA_DIR || path.join(rootDir, 'data'));
if (!onNetlify) fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });

// The session secret signs login cookies so nobody can forge one. On Netlify it
// must be set as an environment variable; on your computer one is made for you.
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (onNetlify) throw new Error('Set the SESSION_SECRET environment variable in Netlify.');
  const file = path.join(dataDir, '.session-secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

module.exports = {
  rootDir,
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  onNetlify,
  // On your computer this is set by "npm start". On Netlify it is found automatically.
  databaseUrl: process.env.DATABASE_URL || null,
  port: Number(process.env.PORT) || 3000,
  // Netlify always uses https://. Elsewhere, set HTTPS=true once the site is served over https.
  https: onNetlify || process.env.HTTPS === 'true',
  sessionSecret: loadSessionSecret(),
  // Needed to create the first admin account on Netlify, so a stranger can't claim the new site.
  setupCode: process.env.SETUP_CODE || null,
};
