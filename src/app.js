// Builds the web app: security settings, logins, and which code handles which page.
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');

const config = require('./config');
const db = require('./db');
const time = require('./time');
const PgSessionStore = require('./sessionStore');
const csrfProtection = require('./csrf');
const { upload, MAX_FILE_MB } = require('./uploads');
const { loadUser, requireLogin, requireAdmin, requireBackOffice, requireTwoStep, requireNotifications, homeFor } = require('./auth');
const { getSettings } = require('./settings');
const { getSessionSecret } = require('./secrets');
const viewHelpers = require('./viewHelpers');
const { catchUp } = require('./services/jobs');
const { isExempt: isTwoStepExempt } = require('./services/twoStep');

const app = express();

// Pages are built from the templates in the "views" folder.
// (Registering EJS by name, rather than letting Express find it, makes sure
// Netlify packages it with the function.)
app.engine('ejs', require('ejs').__express);
app.set('view engine', 'ejs');
app.set('views', path.join(config.rootDir, 'views'));
Object.assign(app.locals, viewHelpers, { maxFileMb: MAX_FILE_MB, homeFor, isTwoStepExempt });

// Behind Netlify (or another HTTPS proxy), trust its headers for the visitor's
// address and for knowing the connection is secure.
if (config.onNetlify) app.set('trust proxy', 'loopback');
else if (config.https) app.set('trust proxy', 1);

// Security headers: tell browsers to block common attacks.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: { upgradeInsecureRequests: config.https ? [] : null },
    },
    strictTransportSecurity: config.https,
    // Send the "page you came from" only within this site (used to return you there after actions).
    referrerPolicy: { policy: 'same-origin' },
  })
);

// Files in "public" (CSS, JavaScript, images) are sent as-is.
// (On Netlify these are served straight from its CDN instead.)
app.use(express.static(path.join(config.rootDir, 'public'), { maxAge: '1h' }));

// Sessions remember who is logged in. Idle for 8 hours = logged out.
// (Set up on the first request, because the cookie key is read from the database.)
let sessions = null;
app.use(async (req, res, next) => {
  sessions ??= session({
    name: 'dmi.sid',
    secret: await getSessionSecret(),
    store: new PgSessionStore(db),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.https, maxAge: 8 * 60 * 60 * 1000 },
  });
  sessions(req, res, next);
});

// Read submitted form data into req.body. (1 MB: a fully filled-in incident report is up to ~300 KB.)
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(loadUser);

// Signed-in pages are never kept by the browser, so after signing out the
// back button can't show them to the next person at a shared computer.
// And no page may use the camera, microphone or location.
app.use((req, res, next) => {
  if (req.user) res.set('Cache-Control', 'no-store');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

// Values every page needs.
app.use(async (req, res, next) => {
  const settings = await getSettings();
  time.setTimeZone(settings.timezone);
  res.locals.settings = settings;
  res.locals.currentPath = req.path;
  res.locals.title = '';
  res.locals.money = (amount) => viewHelpers.formatMoney(amount, settings.currency_symbol);
  next();
});

// "Flash" messages: a one-time note shown on the next page, like "Shift saved".
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || [];
  if (req.session.flash) delete req.session.flash;
  req.flash = (type, message) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, message });
  };
  next();
});

// Forms with a file attached are read here (only for logged-in users).
app.use((req, res, next) => (req.user ? upload(req, res, next) : next()));
app.use(csrfProtection);

// ---- Pages ------------------------------------------------------------------
app.use(require('./routes/auth')); // /setup, /login, /register, /logout (no login needed)
app.use(requireLogin); // everything below needs a login
app.use(requireTwoStep); // ...and two-step sign-in, where it's required
app.use(async (req, res, next) => {
  await catchUp(); // record finished shifts and move open-shift offers along (at most once a minute)
  next();
});

// Unread messages, for the menu (admins, officers and clients).
app.use(async (req, res, next) => {
  if (['admin', 'officer', 'client'].includes(req.user.role)) {
    try {
      res.locals.unreadMessages = await require('./services/chat').unreadFor(req.user);
    } catch (err) {
      console.error('Unread messages failed:', err);
    }
  }
  next();
});

app.use('/account', require('./routes/account')); // every kind of account
app.use('/my/incidents', require('./routes/incidents').officerRouter); // officers' incident reports (always open)
app.use('/my', requireNotifications); // officers: notifications on first
app.use('/my/chat', require('./routes/chat').mineRouter); // officers' and clients' messages with the office
app.use('/my', require('./routes/my')); // officers' and clients' own pages
app.use(requireBackOffice); // everything below is for admins and managers

app.use('/', require('./routes/dashboard'));
app.use('/schedule', require('./routes/schedule'));
app.use('/timesheets', require('./routes/timesheets'));
app.use('/pay', requireAdmin, require('./routes/pay'));
app.use('/staff', require('./routes/staff'));
app.use('/clients', require('./routes/clients').clientsRouter);
app.use('/sites', require('./routes/clients').sitesRouter);
app.use('/contracts', require('./routes/contracts'));
app.use('/training', require('./routes/training'));
app.use('/incidents', requireAdmin, require('./routes/incidents').adminRouter);
app.use('/chat', requireAdmin, require('./routes/chat').adminRouter);
app.use('/users', requireAdmin, require('./routes/users'));
app.use('/tax', requireAdmin, require('./routes/tax'));
app.use('/w2', requireAdmin, require('./routes/w2'));
app.use('/settings', requireAdmin, require('./routes/settings'));
app.use('/activity', requireAdmin, require('./routes/activity'));

// No page matched.
app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'Sorry, that page could not be found.' });
});

// Something went wrong.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `That file is too big. The limit is ${MAX_FILE_MB} MB.`
        : 'There was a problem with the uploaded file.';
    return res.status(400).render('error', { title: 'Upload problem', message });
  }
  console.error(err);
  res.status(500).render('error', {
    title: 'Something went wrong',
    message: 'An unexpected error happened. It has been logged. Please try again.',
  });
});

module.exports = app;
