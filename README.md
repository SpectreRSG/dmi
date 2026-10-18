# DMI Admin – back office for a private security firm

A private website for running the business side of a security company:

| Area | What it does |
| --- | --- |
| **Dashboard** | One screen with everything that needs attention: unfilled shifts, hours to approve, expired licenses, contracts ending. |
| **Schedule** | A weekly roster. Add shifts (including overnight ones), repeat them on chosen days of the week, see unfilled shifts in red. It stops you double-booking a guard and warns you if they aren't licensed or trained. |
| **Conflict checker** | Scans the roster ahead of time for double bookings, too little rest between shifts, overtime, clashes with training, expired licenses and unfilled shifts. "Find cover" lists who is free (best choices first) and assigns them in one click. |
| **Officer & client accounts** | Anyone can sign up at `/register`; an admin approves them and gives them a role. **Officers** see their shifts on a monthly calendar, send in two-week timesheets (the same DMI timesheet PDF as before, now saved in the app), fill in their W-9 details and download their 1099. **Clients** see the monthly schedule for their sites. Neither ever sees pay rates or other people's details. |
| **1099 forms** | Works out what each contractor was paid in a year (from finalized pay runs), makes Form 1099-NEC (Copy B and 2 for the officer, C and 1 for the company), shares it in the officer's account if they agreed, and gives you a filing summary for sending Copy A to the IRS. Admins only. |
| **Timesheets** | Hours actually worked. Press "Mark as worked" on a shift, or type hours in. Approve or reject them, one by one or in bulk. |
| **Pay** | Turns approved hours into pay for a period: regular hours, weekly overtime, bonuses or deductions. Printable payslips and a spreadsheet download for your accountant. Admins only. |
| **Staff** | Guard profiles: contact details, pay rate, security license, emergency contact, hours, training and contracts. |
| **Clients & sites** | Your customers and the places your guards work, with site instructions. |
| **Contracts** | Client agreements, employment contracts, NDAs, subcontracts. Upload the signed copy and get warned before they end. |
| **Training** | A table showing who is qualified, who's expiring, and who's missing training. Plan training sessions, book people in, and record attendance. Type the name of a new training right on the form. |
| **Admin** | User accounts (admin or manager), company settings, and an activity log of who changed what. |

> **Live site:** https://dmi.codehound.org, hosted on Netlify (see section 4). The officers'
> stand-alone timesheet page (https://dmi.codehound.org/timesheet/) still works, but officers with an
> account should send timesheets from **Timesheets** in their account instead: that saves the hours
> in the app for approval, with the same PDF.

---

## 1. Run it on your computer

You only need to do steps 1–3 once.

1. **Install Node.js** (version 22 or newer) from <https://nodejs.org>. Pick the "LTS" version.
   Node.js is the program that runs the website's code.
2. **Get the code**: download this repository (green "Code" button → "Download ZIP") and unzip it,
   or use `git clone`.
3. **Install the building blocks**. Open a terminal in the project folder and type:

   ```bash
   npm install
   ```

   This downloads the libraries listed in `package.json` into a `node_modules` folder.
4. **Start the website**:

   ```bash
   npm start
   ```

   This also starts a small database on your computer (kept in the `data` folder), so there's
   nothing else to install.
5. Open <http://localhost:3000> in your browser. The first time, it asks you to create the
   **first admin account**. That's you.

To stop the website, go back to the terminal and press `Ctrl + C`.

### Want to explore with pretend data first?

```bash
npm run seed
npm start
```

(Stop the app first if it's running.) This fills an **empty** local database with demo guards,
clients, shifts, hours, a pay run, contracts and training. It prints a login (`admin@example.com` plus a password). When you're done
exploring, stop the app and **delete the `data` folder** to start fresh with your real data.

---

## 2. A typical week

1. **Set up once:** add your **clients & sites**, your **staff** (with pay rates and license
   details), and your **training courses** (tick "required" for must-haves like First Aid).
2. **Plan:** in **Schedule**, add shifts. For regular posts, tick the days of the week it repeats
   on and the date to repeat until. Leave the staff box empty to create an unfilled shift you'll fill later.
3. **Check for conflicts:** press the **Check conflicts** button on the Schedule page (it turns
   orange and shows a number when there's a problem that week). Fix each one, or press
   **Find cover** to pick someone who is free, rested and qualified.
4. **Officers and clients sign up** at `https://dmi.codehound.org/register`. Their account waits
   (the dashboard tells you) until you open **User accounts**, press **Approve**, and choose a role:
   for an officer, pick their staff record (or "make a new one"); for a client, pick the client.
5. **Hours come in two ways:** officers send their two-week timesheet from their account (with
   their signature; you get the hours *and* the filled-in DMI PDF), or you press **Mark as worked**
   on a shift. Either way the hours land in **Timesheets** to approve. Officers' PDFs are under
   **Timesheets → Sent by officers (PDF)**.
6. **Approve hours** in Timesheets. Tick the rows, then press "Approve".
7. **Pay day:** in **Pay**, create a pay run for the period. Check it, add any bonuses or
   deductions, then choose the **pay date** and press **Finalize**. Download the spreadsheet for
   your accountant, or print payslips.
8. **Keep an eye on the dashboard** for expiring licenses, training and contracts.
9. **Every January (1099s):** fill in the company's legal name, EIN and address once under
   **Settings → 1099 forms**. Make sure officers have filled in their W-9 details (**Tax forms** in
   their account). Then in **1099 forms**, pick last year, press **Make 1099** for each contractor,
   check the PDFs, and press **Mark as issued**. By **January 31**:
   - give each officer Copy B: share it in their account (if they agreed to get it online) or
     print it and give or mail it to them;
   - file Copy A with the IRS: online through the IRS's free **IRIS** website, or on the official
     red-ink paper forms (a printout from the app isn't accepted for Copy A). The **filing summary**
     page has every number to type in. Filing 10 or more information returns in total means you must
     file online.
   - From 2026 payments on, a 1099-NEC is required for anyone paid **$2,000** or more in the year
     (it was $600 before). Have your accountant check the first batch.

### Who can do what?

- **Admin**: everything, including pay, pay rates, user accounts and settings.
- **Manager**: schedule, timesheets, staff, clients, contracts and training. Managers never see pay, pay rates or tax details.
- **Officer**: their own monthly schedule, timesheets, W-9 details and 1099s. Nothing else.
- **Client**: the monthly schedule for their own sites, with guards shown as "first name + last initial".
- **Waiting for approval**: someone who signed up but hasn't been given a role yet. They see nothing.

### Important rules the app follows

- **Overtime** is counted per week (Monday–Sunday). By default, hours over 40 pay 1.5×. Change this in **Settings**.
- **Rest between shifts:** the conflict checker warns when someone has less than 8 hours between
  shifts. Change the number in **Settings → Scheduling**.
- **Gross pay only.** The app does not work out tax or other deductions; your accountant or
  payroll provider does that from the spreadsheet.
- Once a pay run is **finalized**, its hours are locked so nobody can be paid twice.
- Times are entered as 24-hour clock. If a shift's end time is earlier than its start time
  (22:00 → 06:00), it finishes the next day.

---

## 3. How it's built (the big picture)

A website like this has a few parts. Here's what each one is and where it lives:

```
Your browser  ──asks for a page──▶  Server (Node.js + Express)  ──reads/writes──▶  Database (Postgres)
              ◀──sends back HTML──                                   │
                                                          builds the HTML from templates (EJS)
```

- **Server**: a program that waits for your browser to ask for a page, then sends one back.
  We use **Express**, the most popular server library for Node.js.
- **Routes**: the rules for "when someone visits `/staff`, do this". One file per area in `src/routes/`.
- **Database**: where everything is saved. It's **Postgres**: on the live site Netlify runs it for
  us (Netlify Database); on your computer `npm start` runs a local copy in `data/pg`.
  The tables are described in `netlify/database/migrations/`.
- **Templates (views)**: HTML pages with gaps that get filled in with real data, like
  `<%= employee.first_name %>`. They're in `views/` and use **EJS**.
- **CSS**: makes it look nice. One file: `public/css/style.css`. The colours are at the top.
- **JavaScript in the browser**: small extras like "are you sure?" pop-ups, in `public/js/app.js`.
  The site still works without it.

### Folder map

```
src/
  server.js          starts everything (npm start runs this)
  app.js             security settings + which route file handles which address
  config.js          settings from the .env file (or Netlify's environment variables)
  db.js              talks to the database
  auth.js            passwords, login checks, admin-only checks
  csrf.js            protection against forged forms
  uploads.js         file uploads (contracts, certificates): Netlify Blobs live, data/uploads locally
  secrets.js         the app's own secret keys, kept in the database
  secureData.js      encrypts Social Security / tax ID numbers
  time.js            date/time helpers
  viewHelpers.js     formatting helpers used by templates (dates, money, badges, icons)
  services/
    payroll.js       the pay & overtime maths
    compliance.js    "is this guard licensed and trained?"
    conflicts.js     the schedule conflict checker and "find cover"
    officerTimesheet.js  pay periods + filling in the DMI timesheet PDF
    tax1099.js       who was paid what in a year, W-9 checks, payer details
    form1099Pdf.js   draws Form 1099-NEC (Copies B, 2, C and 1)
  routes/            one file per area: staff, schedule, timesheets, pay, contracts, training, tax…
                     (my.js and myTax.js are the officers' and clients' own pages)
views/               the HTML templates, one folder per area
public/              CSS, browser JavaScript, icon, and the old stand-alone timesheet page (timesheet/)
assets/              the blank DMI timesheet PDF the app fills in
netlify/
  database/migrations/   the database tables (like spreadsheet tabs), applied by Netlify
  functions/app.mjs      runs the whole app on Netlify
netlify.toml         Netlify settings
scripts/
  start.js           "npm start": starts the local database, then the website
  local-db.js        the local database used by npm start and the tests
  seed.js            demo data
tests/               automated tests
data/                YOUR LOCAL DATA (database + uploaded files). Created automatically. Not on GitHub.
```

### Branches: `dev` and `main`

- **`dev`** is where new work goes. Make and test your changes here.
- **`main`** is the finished, trusted version: the one to run for real.
- **Every evening at 21:00 US Pacific time**, GitHub automatically runs the tests on `dev`. If they
  all pass, it copies `dev` into `main`. If they fail, `main` is left alone. You'll see a red ❌
  in the **Actions** tab on GitHub. This is set up in `.github/workflows/nightly-dev-to-main.yml`.
- To copy `dev` to `main` right away instead of waiting, open the **Actions** tab, choose
  **Nightly dev → main**, then **Run workflow**.

### Making changes

- Run `npm run dev` instead of `npm start` and the server restarts by itself every time you save a file.
- Run `npm test` to check nothing is broken. It runs the tests in `tests/`.
- To add a field (say, "uniform size" for staff): add a **new** file in
  `netlify/database/migrations/` with a later number, such as
  `20261101090000_uniform-size.sql`, containing `ALTER TABLE employees ADD COLUMN uniform_size TEXT;`.
  Then add the field to the `FIELDS` list in `src/routes/staff.js` and an input to `views/staff/form.ejs`.
  Netlify applies new migration files when it deploys; `npm start` applies them on your computer.
  ⚠️ Never edit or delete a migration file that has already been used. Always add a new one.

---

## 4. Security, and putting it online

This app stores personal details and pay information, so treat it carefully.

**Already built in:** scrambled (hashed) passwords; sign-in lockout after 5 wrong tries; automatic
sign-out after 8 idle hours; protection against forged forms (CSRF) and other common attacks
(security headers); uploaded files that only signed-in users can download; managers who can't see
pay; and an activity log. New sign-ups can't see anything until an admin approves them (and at most
5 sign-ups per connection every 15 minutes). Officers and clients only ever reach their own pages.

**Tax ID numbers** (from officers' W-9 details) are stored encrypted, and only the last 4 digits are
shown, except on the company's own copies of the 1099 (Copy C and 1) and the admin-only filing
summary (opening it is logged). For stronger protection, set a `TAX_ID_KEY` environment variable in Netlify
(**Project configuration → Environment variables**) to a long random phrase *before* officers enter
their details, and keep a copy of it somewhere safe: without it those numbers can't be read.

**How the live site works (Netlify):**

- Netlify serves `public/` straight from its network, and runs everything else through one
  Netlify Function (`netlify/functions/app.mjs`).
- Data is kept in **Netlify Database** (Postgres). Uploaded files are kept in **Netlify Blobs**
  (private file storage). Netlify creates both automatically.
- Only the `main` branch can update the live site (a lock in `netlify.toml`). Work on the
  `netlify-app` branch is previewed first at https://netlify-app--directmeasures.netlify.app
  (you need to be signed in to Netlify to see it). The preview has its own copy of the database.
- The app looks after its own secrets, so there's nothing to set up by hand:
  - The key that protects login cookies is created automatically and kept in the database.
  - Creating the first admin account on a brand-new database needs a one-time **setup code**,
    so a stranger can't claim the site first. When you open the setup page, the code is written
    to the site's logs, which only you can see: Netlify → **Logs → Functions → app**.
  - To choose your own instead, set `SETUP_CODE` (and/or `SESSION_SECRET`) in
    **Project configuration → Environment variables**.
- **Give everyone their own account.** Never share logins. Deactivate accounts when people leave.

**Running it somewhere else:** any host that can run Node.js and a Postgres database works. Set
`DATABASE_URL` to the database's address, `SESSION_SECRET`, and `HTTPS=true` once it's on https.

**Back-ups:** on your computer, everything is in the `data` folder: copy it somewhere safe while the
app is stopped. On the live site, the data is in Netlify Database; download the pay-run
spreadsheets as you go, and ask for help setting up regular database snapshots.

---

## 5. Ideas for later

- Clock in/out from the officer's phone (live times instead of a two-week sheet)
- Retire the stand-alone /timesheet/ page once every officer has an account
- Client invoicing (bill rates per site)
- Email reminders for expiring licenses and unfilled shifts
- Incident reports from sites
