// Tests the Netlify Function that runs the app on Netlify (netlify/functions/app.mjs),
// by handing it requests the way Netlify does, with the app believing it's on Netlify.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startLocalDatabase } = require('../scripts/local-db');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dmi-fn-test-'));
process.env.AWS_LAMBDA_FUNCTION_NAME = 'app'; // makes the app behave as it does on Netlify
delete process.env.SETUP_CODE;
delete process.env.SESSION_SECRET;

let localDb;
let db;
let handler;
const context = { ip: '203.0.113.9' };
const site = (url, options) => new Request(`https://dmi.codehound.org${url}`, options);
const cookieOf = (response) => response.headers.getSetCookie()[0].split(';')[0];
const tokenOf = async (response) => (await response.text()).match(/name="_csrf" value="([^"]+)"/)[1];
const form = (cookie, fields) => ({
  method: 'POST',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields),
});

test.before(async () => {
  localDb = await startLocalDatabase();
  process.env.DATABASE_URL = localDb.url;
  db = require('../src/db');
  ({ default: handler } = await import('../netlify/functions/app.mjs'));
});

test.after(async () => {
  await db.close();
  await localDb.stop();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('with no SETUP_CODE set, the app makes one, and setup needs it', async () => {
  const page = await handler(site('/setup'), context);
  assert.equal(page.status, 200);
  const cookie = cookieOf(page);
  const _csrf = await tokenOf(page);
  const { value: code } = await db.get("SELECT value FROM settings WHERE key = 'setup_code'");
  assert.match(code, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);

  const account = { _csrf, company_name: 'DMI', name: 'Alex', email: 'alex@example.com', password: 'correct horse battery', confirm: 'correct horse battery' };
  const wrong = await handler(site('/setup', form(cookie, { ...account, setup_code: 'aaaa-bbbb-cccc' })), context);
  assert.equal(wrong.status, 400);
  assert.equal((await db.get("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'")).n, 0);

  const right = await handler(site('/setup', form(cookie, { ...account, setup_code: code })), context);
  assert.equal(right.status, 302);
  assert.equal(right.headers.get('location'), '/');
});

test('the login-cookie key is made once and kept in the database', async () => {
  const { getSessionSecret } = require('../src/secrets');
  const first = await getSessionSecret();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(await getSessionSecret(), first);
});

test('pages, cookies and form posts pass through the function', async () => {
  const page = await handler(site('/login'), context);
  assert.equal(page.status, 200);
  const cookie = cookieOf(page);
  const _csrf = await tokenOf(page);

  const login = await handler(site('/login', form(cookie, { _csrf, email: 'ALEX@example.com', password: 'correct horse battery' })), context);
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), '/');
  assert.match(login.headers.get('set-cookie'), /; Secure/i, 'login cookies are https-only on Netlify');

  // Admins must set up two-step sign-in before anything else.
  const dashboard = await handler(site('/', { headers: { cookie: cookieOf(login) } }), context);
  assert.equal(dashboard.status, 302);
  assert.equal(dashboard.headers.get('location'), '/account/two-step');
  const setup = await handler(site('/account/two-step', { headers: { cookie: cookieOf(login) } }), context);
  assert.equal(setup.status, 200);
  assert.match(await setup.text(), /<svg[^>]*viewBox/, 'with a QR code to scan');
  assert.equal(setup.headers.get('cache-control'), 'no-store');
});

test('wrong passwords are counted per visitor address', async () => {
  const page = await handler(site('/login'), context);
  await handler(site('/login', form(cookieOf(page), { _csrf: await tokenOf(page), email: 'alex@example.com', password: 'wrong password' })), context);
  const keys = (await db.all('SELECT key FROM login_attempts ORDER BY key')).map((r) => r.key);
  assert.deepEqual(keys, ['203.0.113.9|alex@example.com', 'ip|203.0.113.9']);
});

test('every library the app needs is listed in the function, so Netlify packages it', () => {
  const functionFile = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'app.mjs'), 'utf8');
  const { dependencies } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  for (const name of Object.keys(dependencies)) {
    assert.match(functionFile, new RegExp(`^import (.* from )?'${name}';$`, 'm'), `add "import '${name}';" to netlify/functions/app.mjs`);
  }
});

test('the 5-minute job lists every library its code needs, and runs', async () => {
  // Follow the require() lines from the job's code to find the libraries it loads.
  const { builtinModules } = require('module');
  const libraries = new Set();
  const seen = new Set();
  (function walk(file) {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, name] of fs.readFileSync(file, 'utf8').matchAll(/require\('([^']+)'\)/g)) {
      if (name.startsWith('.')) walk(require.resolve(path.resolve(path.dirname(file), name)));
      else if (!builtinModules.includes(name)) libraries.add(name);
    }
  })(path.join(__dirname, '..', 'src', 'services', 'jobs.js'));
  const functionFile = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'autopilot.mjs'), 'utf8');
  for (const name of libraries) {
    assert.match(functionFile, new RegExp(`^import (.* from )?'${name}';$`, 'm'), `add "import '${name}';" to netlify/functions/autopilot.mjs`);
  }

  const { default: job, config } = await import('../netlify/functions/autopilot.mjs');
  assert.equal(config.schedule, '*/5 * * * *');
  assert.equal(await (await job()).text(), 'ok');
});

test('the officer timesheet page is still served, and the sign-in page links to it', async () => {
  const res = await handler(site('/timesheet/'), context);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /DMI Timesheet/);
  const login = await handler(site('/login'), context);
  assert.match(await login.text(), /<a class="auth-shortcut" href="\/timesheet\/">[\s\S]*?Fill in your timesheet[\s\S]*?No sign-in needed/);
});
