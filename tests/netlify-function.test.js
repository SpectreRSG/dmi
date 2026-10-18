// Tests the Netlify Function that runs the app on Netlify (netlify/functions/app.mjs),
// by handing it requests the way Netlify does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startLocalDatabase } = require('../scripts/local-db');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dmi-fn-test-'));

let localDb;
let db;
let handler;
const context = { ip: '203.0.113.9' };
const site = (url, options) => new Request(`https://dmi.codehound.org${url}`, options);

test.before(async () => {
  localDb = await startLocalDatabase();
  process.env.DATABASE_URL = localDb.url;
  db = require('../src/db');
  const { hashPassword } = require('../src/auth');
  await db.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Alex', 'alex@example.com', ?, 'admin')", hashPassword('correct horse battery'));
  ({ default: handler } = await import('../netlify/functions/app.mjs'));
});

test.after(async () => {
  await db.close();
  await localDb.stop();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('pages, cookies and form posts pass through the function', async () => {
  const page = await handler(site('/login'), context);
  assert.equal(page.status, 200);
  const cookie = page.headers.getSetCookie()[0].split(';')[0];
  const _csrf = (await page.text()).match(/name="_csrf" value="([^"]+)"/)[1];

  const login = await handler(
    site('/login', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf, email: 'ALEX@example.com', password: 'correct horse battery' }),
    }),
    context
  );
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), '/');
  const signedIn = login.headers.getSetCookie()[0].split(';')[0];

  const dashboard = await handler(site('/', { headers: { cookie: signedIn } }), context);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Dashboard/);
});

test('wrong passwords are counted per visitor address', async () => {
  const page = await handler(site('/login'), context);
  const cookie = page.headers.getSetCookie()[0].split(';')[0];
  const _csrf = (await page.text()).match(/name="_csrf" value="([^"]+)"/)[1];
  await handler(
    site('/login', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf, email: 'alex@example.com', password: 'wrong password' }),
    }),
    context
  );
  const row = await db.get('SELECT key FROM login_attempts');
  assert.equal(row.key, '203.0.113.9|alex@example.com');
});

test('every library the app needs is listed in the function, so Netlify packages it', () => {
  const functionFile = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'app.mjs'), 'utf8');
  const { dependencies } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  for (const name of Object.keys(dependencies)) {
    assert.match(functionFile, new RegExp(`^import (.* from )?'${name}';$`, 'm'), `add "import '${name}';" to netlify/functions/app.mjs`);
  }
});

test('the officer timesheet page is still served', async () => {
  const res = await handler(site('/timesheet/'), context);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /DMI Timesheet/);
});
