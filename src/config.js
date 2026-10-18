// App configuration: where things are stored, which port to use, etc.
// On your computer you can override these with a ".env" file (see .env.example).
// On Netlify they come from the project's environment variables.
const fs = require('fs');
const path = require('path');

// The project folder (the one holding "views"). Netlify may move files around
// when it packages the app, so check the likely places.
const rootDir =
  [path.join(__dirname, '..'), process.env.LAMBDA_TASK_ROOT, process.cwd()]
    .filter(Boolean)
    .find((dir) => fs.existsSync(path.join(dir, 'views'))) || path.join(__dirname, '..');

// Load settings from a .env file if there is one.
const envFile = path.join(rootDir, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// True when the app is running on Netlify (inside a Netlify Function).
const onNetlify = Boolean(globalThis.Netlify || process.env.NETLIFY_BLOBS_CONTEXT || process.env.AWS_LAMBDA_FUNCTION_NAME);

// On your computer, the local database and uploaded files live in this folder.
// (On Netlify they live in Netlify Database and Netlify Blobs instead.)
const dataDir = path.resolve(process.env.DATA_DIR || path.join(rootDir, 'data'));
if (!onNetlify) fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });

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
  // (The key for login cookies and the setup code are in src/secrets.js.)
};
