# DMI Admin – back office for a private security firm

A private website for running the business side of a security company:

| Area | What it does |
| --- | --- |
| **Dashboard** | One screen with everything that needs attention: unfilled shifts, hours to approve, expired licenses, contracts ending. |
| **Schedule** | A weekly roster. Add shifts (including overnight ones), repeat them weekly, see unfilled shifts in red. It stops you double-booking a guard and warns you if they aren't licensed or trained. |
| **Timesheets** | Hours actually worked. Press "Mark as worked" on a shift, or type hours in. Approve or reject them, one by one or in bulk. |
| **Pay** | Turns approved hours into pay for a period: regular hours, weekly overtime, bonuses or deductions. Printable payslips and a spreadsheet download for your accountant. Admins only. |
| **Staff** | Guard profiles: contact details, pay rate, security license, emergency contact, hours, training and contracts. |
| **Clients & sites** | Your customers and the places your guards work, with site instructions. |
| **Contracts** | Client agreements, employment contracts, NDAs, subcontracts. Upload the signed copy and get warned before they end. |
| **Training** | A table showing who is qualified, who's expiring, and who's missing training. Plan training sessions, book people in, and record attendance. |
| **Admin** | User accounts (admin or manager), company settings, and an activity log of who changed what. |

---

## 1. Run it on your computer

You only need to do steps 1–3 once.

1. **Install Node.js** (version 20 or newer) from <https://nodejs.org>. Pick the "LTS" version.
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

5. Open <http://localhost:3000> in your browser. The first time, it asks you to create the
   **first admin account**. That's you.

To stop the website, go back to the terminal and press `Ctrl + C`.

### Want to explore with pretend data first?

```bash
npm run seed
npm start
```

This fills an **empty** database with demo guards, clients, shifts, hours, a pay run, contracts
and training. It prints a login (`admin@example.com` plus a password). When you're done
exploring, stop the app and **delete the `data` folder** to start fresh with your real data.

---

## 2. A typical week

1. **Set up once:** add your **clients & sites**, your **staff** (with pay rates and license
   details), and your **training courses** (tick "required" for must-haves like First Aid).
2. **Plan:** in **Schedule**, add shifts. Use "Repeat weekly" for regular posts.
   Leave the staff box empty to create an unfilled shift you'll fill later.
3. **After each shift:** press **Mark as worked**. This copies the shift into **Timesheets**.
   If someone worked different hours, edit the entry there.
4. **Approve hours** in Timesheets. Tick the rows, then press "Approve".
5. **Pay day:** in **Pay**, create a pay run for the period. Check it, add any bonuses or
   deductions, then press **Finalize**. Download the spreadsheet for your accountant, or print payslips.
6. **Keep an eye on the dashboard** for expiring licenses, training and contracts.

### Who can do what?

- **Admin**: everything, including pay, pay rates, user accounts and settings.
- **Manager**: schedule, timesheets, staff, clients, contracts and training. Managers never see pay or pay rates.

### Important rules the app follows

- **Overtime** is counted per week (Monday–Sunday). By default, hours over 40 pay 1.5×. Change this in **Settings**.
- **Gross pay only.** The app does not work out tax or other deductions; your accountant or
  payroll provider does that from the spreadsheet.
- Once a pay run is **finalized**, its hours are locked so nobody can be paid twice.
- Times are entered as 24-hour clock. If a shift's end time is earlier than its start time
  (22:00 → 06:00), it finishes the next day.

---

## 3. How it's built (the big picture)

A website like this has a few parts. Here's what each one is and where it lives:

```
Your browser  ──asks for a page──▶  Server (Node.js + Express)  ──reads/writes──▶  Database (SQLite file)
              ◀──sends back HTML──                                   │
                                                          builds the HTML from templates (EJS)
```

- **Server**: a program that waits for your browser to ask for a page, then sends one back.
  We use **Express**, the most popular server library for Node.js.
- **Routes**: the rules for "when someone visits `/staff`, do this". One file per area in `src/routes/`.
- **Database**: where everything is saved. **SQLite** keeps it all in a single file
  (`data/dmi.sqlite`). There's no separate database program to install.
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
  config.js          settings from the .env file
  schema.sql         the database tables (like spreadsheet tabs)
  db.js              opens the database
  auth.js            passwords, login checks, admin-only checks
  csrf.js            protection against forged forms
  uploads.js         file uploads (contracts, certificates)
  time.js            date/time helpers
  viewHelpers.js     formatting helpers used by templates (dates, money, badges, icons)
  services/
    payroll.js       the pay & overtime maths
    compliance.js    "is this guard licensed and trained?"
  routes/            one file per area: staff, schedule, timesheets, pay, contracts, training…
views/               the HTML templates, one folder per area
public/              CSS, browser JavaScript, icon
scripts/seed.js      demo data
tests/               automated tests
data/                YOUR DATA (database + uploaded files). Created automatically. Not on GitHub.
```

### Making changes

- Run `npm run dev` instead of `npm start` and the server restarts by itself every time you save a file.
- Run `npm test` to check nothing is broken. It runs the tests in `tests/`.
- To add a field (say, "uniform size" for staff): add a column in `src/schema.sql`, add it to the
  `FIELDS` list in `src/routes/staff.js`, and add an input to `views/staff/form.ejs`.
  ⚠️ `schema.sql` only creates tables that don't exist yet. To change an existing database, run
  `ALTER TABLE employees ADD COLUMN uniform_size TEXT;` with a SQLite tool, or ask for help.

---

## 4. Security, and putting it online

This app stores personal details and pay information, so treat it carefully.

**Already built in:** scrambled (hashed) passwords; sign-in lockout after 5 wrong tries; automatic
sign-out after 8 idle hours; protection against forged forms (CSRF) and other common attacks
(security headers); uploaded files that only signed-in users can download; managers who can't see
pay; and an activity log.

**When you put it on the internet:**

1. **Use HTTPS** (the padlock). Most hosts do this for you. Then set `HTTPS=true` in `.env`.
2. Copy `.env.example` to `.env` and set your **time zone** (`TZ`).
3. Pick a host that gives you a **persistent disk**, because the database is a file. For example, a
   small virtual server (DigitalOcean, Linode, Lightsail), or Render/Railway/Fly.io with a mounted
   volume pointed to by `DATA_DIR`.
4. Run it with a process manager (such as `pm2`) or your host's "start command" so it restarts if
   the server reboots: `npm install --omit=dev && npm start`.
5. **Give everyone their own account.** Never share logins. Deactivate accounts when people leave.

**Back-ups:** everything is in the `data` folder. Copy that whole folder somewhere safe regularly
(another computer, cloud storage) and keep a few old copies. To restore, stop the app and put the
folder back.

---

## 5. Ideas for later

- A phone page for guards to see their own roster and clock in/out
- Client invoicing (bill rates per site)
- Email reminders for expiring licenses and unfilled shifts
- Incident reports from sites
