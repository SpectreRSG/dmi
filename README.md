# DMI Admin – back office for a private security firm

A private website for running the business side of a security company:

| Area | What it does |
| --- | --- |
| **Dashboard** | One screen with everything that needs attention: unfilled shifts, hours to approve, expired licenses, contracts ending. |
| **Schedule** | A weekly roster. Add shifts (including overnight ones), repeat them on chosen days of the week, see unfilled shifts in red. It stops you double-booking a guard and warns you if they aren't licensed or trained. |
| **Conflict checker** | Scans the roster ahead of time for double bookings, too little rest between shifts, overtime, clashes with training, expired licenses and unfilled shifts. "Find cover" lists who is free (best choices first) and assigns them in one click. |
| **Availability** | Officers say when they can't work (one day, a few days, or every week, all day or between times) and when they'd like extra shifts. The conflict checker warns about shifts booked while someone can't work, the office is warned when booking them, "Find cover" and open-shift offers skip them, and officers who said they're available are asked first. See everyone's at **Schedule → Availability**. |
| **Shift requests from sites** | A site representative (client account) asks for a shift: site, date, times, how many officers, and the officers they'd like. It can **repeat** on chosen weekdays for up to 3 months (e.g. every Mon, Wed and Fri, 6 PM–6 AM). The office approves or declines it under **Schedule → Shift requests**, a whole repeating request in one click. Approved: the shifts go on the schedule as open shifts (teal) and are offered to officers, the ones the site asked for first (up to 2 hours to themselves), then everyone else who's free. A repeating request's shifts are offered about two weeks before each date, and an officer offered several at once gets one notification for all of them. The site gets a notification when it's approved and when each shift is covered, with the officer's name, and sees every request it has sent under **History**, with who covered each date. |
| **Call-outs & open shifts** | An officer who can't make a shift presses **I can't make it** (or the office notes it). The shift is offered to the officers who are free, rested, licensed and trained: regulars at that site first, everyone else 10 minutes later. The first to claim it gets it. The office is only told if nobody has claimed it after 30 minutes (15 when the shift is close). |
| **App notifications** | Free alerts on phones and computers, like a text message, with no texting company or phone numbers. Officers hear about open shifts, changes to their shifts and pay day, get a **reminder 24 hours and again 2 hours before each shift**, and a **"time cards are due"** reminder 2 days before each pay period ends. Sites hear when their shift requests are approved and covered. The office hears about call-outs, shifts nobody has claimed, and when time cards are due; admins also hear about shift requests, incident reports, tax payments and new hire reports due. Everyone with **Messages** hears when a new one arrives for them. Each person turns them on once per device. |
| **Side menu alerts** | A count next to each menu item where something needs attention soon: red to act now, amber for what's coming up (hover over it, or a screen reader reads it, to see what it is). The office sees unfilled shifts, site requests, hours to approve, expired or expiring licenses, training and contracts; admins also see incident reports to review, unread messages, new sign-ups, new hire reports, bank accounts to approve and payroll tax payments due within a week. Officers see open shifts they can claim, incident reports to finish or answer, messages, missing tax forms and "time cards are due". Clients see their incident reports and messages. On a phone the menu button shows the total. If someone has no device with notifications on, **My account** says so in red. |
| **Officer & client accounts** | Anyone can sign up at `/register`; while they wait, the page walks them through adding DMI to their phone's Home Screen and turning on notifications, and they're notified when an admin approves them and gives them a role. **Officers** must have notifications on before they can use their pages (incident reports always work). They see their shifts on a monthly calendar and their pay (their own rate or salary, pay stubs and their DMI timesheet for each pay day, and their 1099 or W-2), can report a missed meal or rest break, and keep their contact details and direct deposit up to date. They fill in their W-9 (1099 contractors) or W-4 and DE 4 (W-2 employees) once at the start; there are no timesheets to fill in. **Clients** see the monthly schedule for their sites and ask for shifts. Both can write incident reports and send the office a **message**. Neither ever sees anyone else's pay or private details. |
| **Incident reports** | Use of force and incident reports, with the same questions as the California PPO incident record. **Everyone with an account can write one**: officers (it starts from their shift), clients (for their own sites), managers and admins. They fill it in on their phone one step at a time (Back and Next, saved as they go), and it only asks about what they ticked: the force, firearm, injury, damage and police questions appear only when they apply, and optional details are folded away. They add photos and sign it by typing their legal name. Admins are notified, see the reporting deadlines that may apply (guard notice, BSIS, local police), fill in the review, and approve it or ask for more; the writer answers with a dated supplement. A sent report can't be changed, prints on the model PDF form, and is kept 5 years after the incident (longer on legal hold). Only admins review them; everyone else sees only their own. |
| **Messages** | A private, 1:1 conversation between each officer or client and the office: they open **Messages** in their menu and write to the admins; any admin can read and answer it in **Messages** (or start one, from there or a staff page). New messages appear by themselves while the page is open, an app notification reaches whoever a message is for, and the menu shows how many are unread. Every message is date and time stamped, can't be changed or deleted, and is kept for 2 years (then removed automatically). Admins can download a conversation as a **PDF that can't be edited**: it opens and prints for anyone, with no password, but PDF software won't let it be changed, annotated or copied from, and every page shows who downloaded it, when, and a verification code. Managers don't use it. |
| **Sign-in security** | Two-step sign-in (an authenticator app code) or a passkey (Face ID, Touch ID, screen lock), backup codes, remembered devices, and signing out everywhere. |
| **1099 forms** | Works out what each contractor was paid in a year (from finalized pay runs), makes Form 1099-NEC (Copy B and 2 for the officer, C and 1 for the company), shares it in the officer's account if they agreed, and gives you a filing summary for sending Copy A to the IRS. Admins only. |
| **Timesheets** | Hours actually worked. When a shift ends, its hours are recorded and approved from the schedule by themselves. You only fix the exceptions (edit the shift or the hours, or mark a missed meal or rest break), or type in hours that weren't on the schedule and approve them. |
| **Pay** | Turns approved hours into pay for a period. **W-2 employees**: hourly or **salaried** (paid each pay day, with or without hours), California daily and weekly overtime and double time, **meal and rest break premiums**, then 2026 federal and California tax withholding from their W-4 and DE 4 (income tax, Social Security, Medicare, SDI), the company's own payroll taxes (Social Security, Medicare, FUTA, UI, ETT), **California paid sick leave** (earned and used), deductions and **net pay**, with California-compliant pay stubs (year-to-date totals and sick leave available). **1099 contractors**: their rate for every hour (no overtime), no taxes taken out unless the IRS requires backup withholding. Plus bonuses, a spreadsheet for your accountant, and each person's DMI timesheet PDF, stamped "Approved by" when you finalize. Admins only. |
| **Payroll taxes, W-2s & direct deposit** | What's owed to the IRS and the EDD from each pay run, with due dates and reminders (**Pay → Tax payments**); the numbers for Forms 941 and 940 and the EDD's DE 9 and DE 9C (**Pay → Tax reports**); **W-2 forms** each January; **new hire reports (DE 34)**; and **direct deposit**: officers add their bank account, an admin approves it, and each pay run makes the file to upload to the bank. Admins only (apart from officers' own bank details). |
| **Staff** | Guard profiles: position (Armed Security Officer, Unarmed Security Officer, Supervisor, Manager or Administrator), **employment type** (Full Time, Part Time Regular, Part Time Hourly or Contractor, which decides how they're paid and taxed), pay rate or salary, **Employee since** (for the new hire report), meal break agreements, pay history, security license, emergency contact, direct deposit, whether their app notifications are on, hours, training and contracts. Their page has a **Message** button for anyone with an officer account. |
| **Clients & sites** | Your customers and the places your guards work, with site instructions. |
| **Contracts** | Client agreements, employment contracts, NDAs, subcontracts. Upload the signed copy and get warned before they end. |
| **Training** | A table showing who is qualified, who's expiring, and who's missing training. Plan training sessions, book people in, and record attendance. Type the name of a new training right on the form. |
| **Admin** | User accounts (approving sign-ups and giving each person a role: admin, manager, officer or client), company settings, and an activity log of who changed what. |

> **Live site:** https://dmi.codehound.org, hosted on Netlify (see section 4). Officers' hours now
> come from the schedule, so they don't need to send timesheets. The original stand-alone timesheet
> form, which fills in the DMI timesheet PDF in the browser, is at
> https://dmi.codehound.org/timesheet/ for anyone who wants it. It needs no account and is kept
> separate from the app on purpose: nothing in the app links to it, and it doesn't link to the app.
> Share the address directly.

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
clients, shifts, hours, a pay run, contracts and training. It prints four logins (`admin@`,
`manager@`, `officer@` and `client@example.com`, all with the same password). When you're done
exploring, stop the app and **delete the `data` folder** to start fresh with your real data.

---

## 2. A typical week

1. **Set up once:** add your **clients & sites**, your **staff** (with their employment type, pay
   rate or salary, and license details), and your **training courses** (tick "required" for
   must-haves like First Aid).
2. **Plan:** in **Schedule**, add shifts. For regular posts, tick the days of the week it repeats
   on and the date to repeat until. Leave the staff box empty to create an unfilled shift you'll fill later.
3. **Check for conflicts:** press the **Check conflicts** button on the Schedule page (it turns
   orange and shows a number when there's a problem that week). Fix each one, or press
   **Find cover** to pick someone who is free, rested and qualified.
4. **Officers and clients sign up** at `https://dmi.codehound.org/register`. Their account waits
   (the dashboard tells you) until you open **User accounts**, press **Approve**, and choose a role:
   for an officer, pick their staff record (or "make a new one"); for a client, pick the client.
   While they wait, the page walks them through adding DMI to their phone's Home Screen and turning
   on notifications, and they get a notification the moment you approve them. **Officers must turn
   on notifications before they can use their pages** (so they get shift reminders and open shifts);
   until then DMI shows them the setup steps. Incident reports and My account always work. If an
   officer's phone can't get notifications (an iPhone older than iOS 16.4, for example), open their
   staff page and press **Their phone can't: let them in without**.
5. **Call-outs fill themselves:** when an officer presses **I can't make it** (or you open the shift
   and press **Note call-out and offer it** after they phone in), the shift is offered to the officers
   who could take it, and the first to claim it gets it. You get a notification when it's covered, or
   if nobody has claimed it in time (then press **Find cover**). Open shifts are listed on the
   dashboard. You can also **Offer to officers** any unfilled shift.
   **Site requests:** when a site asks for a shift, you get a notification and a note on the
   dashboard. Open **Schedule → Shift requests** and press **Approve and offer to officers** (or
   **Decline**, with a reason the site sees). For a repeating request, **Approve all … shifts**
   puts every date on the schedule; each one is offered to officers about two weeks ahead. If
   nobody is free for one, you get a notification to find cover. Everything else happens by itself.
6. **Hours record themselves:** when a shift ends, its hours go into **Timesheets**, already
   approved (marked "from the schedule"). Nobody fills in a timesheet. You only fix the exceptions,
   before the pay run is finalized:
   - **left early, stayed late, or someone else covered:** change the shift's times or officer and
     save. The hours follow.
   - **didn't come:** set the shift to **Cancelled** (its hours go), or reject the hours in Timesheets.
   - **worked something that wasn't on the schedule:** **Add hours** in Timesheets and approve them.
   Hours are only recorded for shifts from the pay period this was switched on in onwards, so
   older shifts don't suddenly turn into hours. (Timesheets officers sent themselves before this
   are still under **Timesheets → Sent by officers (PDF)**, and in the officer's **My pay**.)
7. **Approve hours you typed in** (they're the only ones waiting): tick the rows, then press "Approve".
8. **Pay day:** in **Pay**, create a pay run for the period. Check it, add any bonuses, paid sick
   leave taken or deductions (open **Details** on a person's line), then choose the **pay date** and
   press **Finalize**. Download the spreadsheet for your accountant, or print pay stubs. Each officer
   then sees their pay stub and their **DMI
   timesheet** (filled in from their hours, with your name and the date after "APPROVED BY") under
   **My pay** in their account. You can open the same timesheets from the pay run.
9. **Keep an eye on the dashboard** for expiring licenses, training and contracts.
10. **Incident reports (use of force and other incidents):** anyone with an account can write one.
    An officer opens **Incident reports** on their phone and starts a report from their shift (the
    site, address and their details fill themselves in); a client picks one of their own sites (they
    aren't asked the questions about working as a guard); managers use **Incident reports** in their
    menu, and admins press **Write a report** on the review page. It goes one step at a time and
    only asks about what they ticked (a simple incident is 7 short steps). They answer what applies, add
    photos, then sign it by typing their full legal name and send it. Every admin gets a notification (titled "Firearm discharge" if a gun was fired),
    and the dashboard shows it. Open **Incident reports**, read it, and:
    - see **Reporting that may be required**: the California deadlines worked out from what was
      ticked (the guard's 24-hour notice, BSIS within 7 business days, local police within 7 days).
      It's a reminder of what to check, not legal advice.
    - fill in the **Review** (page 7 of the form: who files what, by when, and what was filed), and
      press **Save review**. You can come back to it.
    - press **Approve**, or **Send** a question to whoever wrote it. They answer with a dated
      **supplement**; it comes back to you to review.
    - press **PDF** for the report on the official-looking form (the same form you gave us), with
      extra pages for long answers, supplements, files and history.
    Put your **PPO license number** under **Settings → Incident reports** so it's on every report.
11. **Messages:** when an officer or client writes to the office, every admin gets a notification
    and **Messages** in the menu shows a number. Open it, pick the conversation and answer; they get
    a notification. To write to someone first, choose them at the top of **Messages**, or press
    **Message** on their staff page. Press **Download PDF** on a conversation to keep a copy that
    can't be edited (for a dispute, say).
12. **Every January (1099s):** fill in the company's legal name, EIN and address once under
    **Settings → Company tax details**. Make sure officers have filled in their W-9 details (their
    account asks them to when they first sign in; it's under **My pay → Tax forms**). Then in
    **1099 forms**, pick last year, press **Make 1099** for each contractor, check the PDFs, and
    press **Mark as issued**. By **January 31**:
    - give each officer Copy B: share it in their account (if they agreed to get it online) or
      print it and give or mail it to them;
    - file Copy A with the IRS: online through the IRS's free **IRIS** website, or on the official
      red-ink paper forms (a printout from the app isn't accepted for Copy A). The **filing summary**
      page has every number to type in. Filing 10 or more information returns in total means you
      must file online.
    - From 2026 payments on, a 1099-NEC is required for anyone paid **$2,000** or more in the year
      (it was $600 before). Have your accountant check the first batch.
    - W-2 employees get a W-2 instead, by the same date: see **W-2 forms** below.

### Who can do what?

- **Admin**: everything, including pay, pay rates, taxes, user accounts, settings, reviewing incident reports and answering **Messages**.
- **Manager**: schedule, timesheets, staff, clients, contracts and training, and writing their own incident reports. Managers never see pay, pay rates, tax details, messages or other people's incident reports.
- **Officer**: their own monthly schedule (including "I can't make it" and claiming open shifts), their availability, their pay (their rate, pay stubs and DMI timesheets, reporting a missed break, direct deposit), their contact details, their W-9 and 1099s (contractors) or W-4, DE 4 and W-2s (employees), **Incident reports** (writing their own, and seeing the ones they sent) and **Messages** with the office. Nothing else.
- **Client** (site representative): the monthly schedule for their own sites, with guards shown as "first name + last initial", and **Shift requests** to ask for officers (once, or repeating), with a **History** of every request and who covered each date, **Incident reports** for their own sites (writing their own, and seeing the ones they sent) and **Messages** with the office.
- **Waiting for approval**: someone who signed up but hasn't been given a role yet. They see nothing, and can't write incident reports until they're approved.

A **test officer account** (`test.officer@example.com`, staff record "Test Officer") is created
automatically with the database, for trying the officer pages. Its password was given to the site
owner; it can't be used until the first admin account exists. Deactivate it under **User accounts**
when you no longer need it.

A **demo client account** (`demo.client@example.com`) is created the same way, for trying the client
pages. It belongs to a pretend client, **Demo Client**, with two pretend sites ("Demo Site: Front
Gate" and "Demo Site: Warehouse") and no shifts. Its password was given to the site owner.
- A site can only ask for officers by name once they've worked there, so to try that, first put the
  Test Officer on any shift at a demo site.
- Approving a demo request offers the shifts to officers like any real request. On the live site,
  ask for 1 officer and name the Test Officer (they get first choice, and nobody else hears about
  it if they claim it straight away), or decline the request instead.
- Deactivate it under **User accounts** when you're done.

Both demo accounts sign in with **just their password**: no two-step code and no passkey, so
they're quick to test with. If either is made a manager or admin, it needs two-step sign-in like
everyone else. Every other account is unchanged. The Demo Client only sees its pretend sites, but
the Test Officer is treated like any officer: it can be offered real open shifts and see those
sites' details. So keep its password private, and deactivate it when you're not testing.

### Important rules the app follows

- **Overtime follows California's rules** (Labor Code 510), set under **Settings → Overtime**:
  - hours over 8 in a workday pay 1.5×, and hours over 12 pay 2× ("double time");
  - working all 7 days of a week (Monday–Sunday), the 7th day's first 8 hours pay 1.5× and the rest 2×;
  - hours over 40 in a week pay 1.5× (counting only the hours that weren't already overtime that day).
  A workday is the 24 hours from **Each workday starts at** (06:00 by default, so a 6 PM–6 AM night shift
  is one 12-hour workday). Pick it once and keep it. A pay run that starts mid-week (pay periods run
  Sunday to Saturday) counts the hours earlier that week, so nothing is missed between pay runs, and
  nothing is paid twice. Choose **Weekly only** to go back to just hours over 40 a week. Pay runs that
  were already finalized keep the numbers they had. Overtime is for **W-2 employees**: 1099
  contractors aren't covered by overtime law, so they get their rate for every hour. Have your
  accountant confirm the setup the first time.
- **Employment types decide how people are paid** (Staff → Edit → Pay and taxes, admins only).
  Change someone's type whenever their job changes, and everything that goes with it switches too:

  | Type | Tax form | Paid | Overtime | Sick leave, breaks | Fills in |
  |---|---|---|---|---|---|
  | Full Time | W-2 | by the hour, or a yearly salary | yes, unless "exempt" | yes (exempt: sick leave only) | W-4 and DE 4 |
  | Part Time Regular | W-2 | a set salary for a regular schedule (e.g. 24 hours a week) | yes | yes | W-4 and DE 4 |
  | Part Time Hourly | W-2 | by the hour | yes | yes | W-4 and DE 4 |
  | Contractor | 1099 | the agreed rate for every hour | no | no | W-9 |

  - A **salary** is paid in equal parts each pay day (yearly salary ÷ pay days), and a share of it
    for a first or last paycheck (by weekdays). Its hourly rate (weekly salary ÷ the hours it's for,
    40 for full time, Labor Code 515(d)) pays overtime, break premiums and, for Part Time Regular,
    hours past their schedule. Sick days come off the balance; the salary already pays for them.
  - **Exempt from overtime** is only for Full Time salaried staff whose duties qualify (managers,
    office staff), with a salary of at least twice the state minimum wage for full time ($70,304 in
    2026; the minimum wage is in `taxTables.js`). They get no overtime or break premiums, and earn
    sick leave as if working 40 hours a week. Guards are not exempt.
  - Hourly employees must be paid at least the state minimum wage ($16.90 in 2026; some cities are higher).
  - Every change is kept in the staff page's **Pay history**, and the person gets a notification
    (California wants employees told of pay changes within 7 days). A contractor who becomes an
    employee is a new hire from that day (new hire report, sick leave waiting period). Pay runs use
    the details at the time they're calculated: press **Recalculate** on any draft after a change.
- **Meal and rest breaks (W-2 employees who aren't exempt, Labor Code 512 and 226.7):** a 30-minute
  unpaid meal break before the end of the 5th hour worked and a second before the end of the 10th;
  a paid 10-minute rest break for every 4 hours (or more than half of that). Each workday with a
  missed, short or late meal break adds **one hour's pay**, and so does a missed rest break (at most
  one of each a day). DMI counts a meal break as missed when a day over 5 hours has less unpaid break
  time on record than needed (time off the clock between two shifts that day counts), or when it's
  marked as missed on the hours (Timesheets) or reported by the employee under **My pay → Missed a
  break?**. Rest breaks are paid, so they only count when marked or reported. On the staff record:
  - **On-duty meal agreement signed**: for posts where the guard can't be relieved, they eat at the
    post (paid), so no meal break needs to be recorded. It must be in writing, and they can cancel it.
  - **Meal break waiver signed**: they can skip the meal break on days of 6 hours or less, and the
    second one on days of 12 hours or less (so a 12-hour shift needs only one meal break).
  The pay run warns who has premiums, and each line's **Details** lists the days and why.
- **Rest between shifts:** the conflict checker warns when someone has less than 8 hours between
  shifts. Change the number in **Settings → Scheduling**.
- **Only what's still to come is flagged:** once a shift's start time has passed, it no longer shows
  as unfilled or as a conflict (on the dashboard, in the side menu, on Schedule or in the conflict
  checker), and a site request whose dates have all passed no longer counts as waiting (decline it
  so the site knows). On the schedule, a past shift nobody covered shows in grey as **Not covered**.
- **Payroll taxes (W-2 employees).** Each paycheck's withholding follows IRS Publication 15-T
  (Worksheet 1A, W-4 from 2020 or later) and the EDD's Method B, using the tax year of the **pay
  date**. Social Security stops at the year's wage base ($184,500 in 2026); FUTA, UI and ETT apply to
  each person's first $7,000 a year. Someone with no W-4 or DE 4 yet is withheld as single with no
  adjustments, as the rules require. All the rates are in one place
  (`src/services/taxTables.js`) and shown under **Pay → Tax rates**: **each December, add the next
  year's rates there** and have your accountant check the page against the IRS and EDD
  publications; pay runs with W-2 employees can't be finalized until an admin confirms that year's
  rates. Set how often people are paid and your California UI rate (the EDD mails it each December)
  under **Settings → Payroll**. The company's legal name, EIN and address must be filled in, as
  they go on every pay stub.
- **New hire reports (DE 34):** every new W-2 employee must be reported to the EDD within 20 days
  of their start date (e-Services for Business). The dashboard lists who's due, admins get a
  reminder 5 days before, and **Report details** on the staff page has everything to type in (full
  SSN, behind a fresh two-step code); then mark it as reported. Someone moving from Contractor to an
  employee type counts as a new hire from the day the type was changed: DMI puts that day in
  **Employee since** on their record. If they were really an employee all along (DMI just had them
  as a contractor), clear it, and their start date counts instead.
- **Paid sick leave (W-2 employees, California):** 1 hour earned for every 30 worked, earning stops
  while 80 hours are banked, up to 40 hours used a year, usable from the 90th day of employment
  (start date on the staff record, or the day a contractor became an employee).
- **Paying the payroll taxes (Pay → Tax payments):** lists what's owed to the IRS (federal income
  tax, Social Security and Medicare, FUTA) and the EDD (California income tax and SDI, UI and ETT)
  from finalized W-2 pay, with due dates from the schedule in **Settings → Payroll** (monthly for
  most new employers, or semiweekly), moved past weekends and federal holidays. Pay each one through
  EFTPS or EDD e-Services, then **record it** with its confirmation number. Admins get a reminder
  3 days before each due date, and once if a payment is late.
- **Tax reports (Pay → Tax reports):** the numbers for **Form 941** and the EDD's **DE 9** and
  **DE 9C** each quarter, and **Form 940** each year, by line number, ready to type in. The DE 9C
  download has full Social Security numbers, so it asks for a fresh two-step code.
- **W-2 forms (W-2 forms, in the admin menu):** each January, make a W-2 for everyone paid as a W-2
  employee (from finalized pay by pay date: wages, federal tax, Social Security, Medicare, California
  SDI in box 14, state wages and tax), check it, and **Mark as issued**. The employee's copies (B, C
  and 2) show only the last 4 of the SSN; the company's copy (D) and the **filing summary** show the
  full number and ask for a fresh two-step code. File with Social Security online through **W-2
  Online** (Business Services Online), which makes the W-3; the summary has every box to type in.
  Employees who agree (under Tax forms) download their W-2 in their account once you share it. A
  mistake after issuing needs a Form W-2c (not in DMI).
- **Direct deposit:** officers enter their bank account under **My pay → Direct deposit** (it's
  optional: California lets people choose a check). A new or changed account **waits for an admin
  to approve it** on the staff page, so a stolen login can't send someone's pay elsewhere; the
  officer and the admins are notified of every change. The office can also type in an account from
  a signed direct deposit form (in use at once). Once the bank has set up payroll uploads ("ACH"),
  fill in its details under **Settings → Direct deposit**; then each finalized pay run has
  **Download the direct deposit file** (a standard NACHA file of everyone's net pay, for the day you
  choose) to upload to the bank, and lists who to pay by check. The file has account numbers, so it
  asks for a fresh two-step code. Account numbers are stored encrypted.
- Once a pay run is **finalized**, its hours are locked so nobody can be paid twice.
- Times are entered as 24-hour clock. If a shift's end time is earlier than its start time
  (22:00 → 06:00), it finishes the next day.
- **Files in the installed app:** an app added to the Home Screen has no browser toolbar, so a PDF opened
  the usual way would fill the screen with no way back (on iPhones especially). There, PDFs, photos and
  other files open in a viewer inside DMI with **Back** and **Share** (Save to Files, Print, AirDrop) or
  **Download**. The phone's back gesture closes it too. In a browser tab, files open as before. PDFs are
  drawn by Mozilla's pdf.js, kept in `public/vendor/pdfjs/`.
- **Messages are kept for 2 years.** Nobody can change or delete one before then (the database
  itself refuses); after 2 years the timed jobs remove it. If a conversation is needed for
  longer (for example a dispute), download it first with **Download PDF** on its page (it asks
  for a fresh two-step code). The PDF opens without a password and can be printed, but it's locked
  against changes: PDF software (Adobe, Preview, Chrome, Edge) won't edit, annotate or copy from
  it. Every page shows who downloaded it, when, and a **verification code** worked out from the
  messages; the activity log records each download with its code, so a copy can be checked later
  (any change to the messages gives a different code).
- **Incident reports are kept for 5 years** after the incident. Until then nobody can delete one,
  not even an admin (the database itself refuses). After 5 years they're listed under
  **Incident reports → Past 5 years**, and an admin can delete them; nothing is deleted
  automatically. **Legal hold** keeps one longer (for a claim or lawsuit).
- **A sent incident report is never changed.** Not by whoever wrote it, and not by the office:
  anything new is a dated supplement, and the original stays as it was signed. A draft is only seen
  by the person writing it, and their phone keeps a copy as they type, in case the signal drops.

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
- **CSS**: makes it look nice. One file: `public/css/style.css`. The colors are at the top.
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
    employment.js    employment types: what each one means for pay and taxes, salary maths, the staff form's pay fields
    breaks.js        California meal and rest break rules and premiums
    taxTables.js     the payroll tax rates for each year (check and add a year each December)
    withholding.js   the tax maths: federal and California withholding, Social Security, Medicare, SDI, FUTA, UI, ETT
    paycheck.js      one pay line from hours to net: overtime and salary by type, break premiums, taxes, sick leave, deductions, what blocks finalizing
    sickLeave.js     California paid sick leave rules
    payslip.js       what a pay stub shows, with year-to-date totals
    taxDeposits.js   payroll tax payments: what's owed, due dates, what's paid, reminders
    taxReports.js    the numbers for Forms 941 and 940, and the EDD's DE 9 and DE 9C
    w2.js            year-end W-2s: the boxes from the year's pay, details, W-3 totals
    formW2Pdf.js     draws Form W-2 (Copies B, C, 2 and D)
    bankAccounts.js  direct deposit accounts: the form, approval of officers' changes, paper checks
    nacha.js         the direct deposit (NACHA/ACH) file for the bank, and routing number checks
    newHires.js      California new hire reports (DE 34): who's due, reminders
    businessDays.js  federal holidays and business days, for due dates
    withholdingProfile.js  W-4 and DE 4 answers: the form, checks, saving (SSN encrypted)
    compliance.js    "is this guard licensed and trained?"
    conflicts.js     the schedule conflict checker and "find cover"
    hoursFromSchedule.js  records the hours of shifts that have ended (and keeps them in step with the shift)
    officerTimesheet.js  pay periods + filling in the DMI timesheet PDF
    payTimesheet.js  each person's DMI timesheet for a finalized pay run
    openShifts.js    call-outs, offering open shifts in waves, first-to-claim, telling the office
    notify.js        app notifications (web push)
    shiftNews.js     tells officers when the office changes their upcoming shifts
    reminders.js     shift reminders (24 h and 2 h before) and "time cards are due" (2 days before a period ends)
    availability.js  officers' "can't work" / "available" times, and who's free when
    shiftRequests.js shift requests from sites: repeating dates, approving, declining, first choice,
                     offering a repeating request's shifts two weeks ahead
    jobs.js          the timed jobs (finished shifts, open-shift waves, reminders, clearing out old messages)
    alerts.js        the side menu's alert counts for each kind of account
    totp.js          the 6-digit authenticator-app codes (the TOTP standard) and the setup QR code
    twoStep.js       two-step sign-in: who needs it, checking codes, backup codes, remembered devices
    passkeys.js      passkeys (Face ID, Touch ID, screen lock): adding them, and checking a sign-in
    tax1099.js       who was paid what in a year, W-9 checks, payer details
    form1099Pdf.js   draws Form 1099-NEC (Copies B, 2, C and 1)
    timesheetApproval.js  the approved copy of an officer's timesheet ("APPROVED BY" filled in)
    incidentReports.js    incident reports: the questions (named like the boxes on the model form),
                     sending, deadlines, the 5-year keep date, and the filled-in PDF
    chat.js          messages between each officer or client and the office: unread counts, the 2-year clean-up
    chatPdf.js       a conversation as a PDF that can't be edited, with the verification code
    pdfSecurity.js   locks a PDF against changes (AES-256): opens and prints for anyone, no editing or copying
  routes/            one file per area: staff, schedule, timesheets, pay, contracts, training, tax…
                     (my.js and myTax.js are the officers' and clients' own pages; incidents.js
                     has both /my/incidents, where everyone writes their own, and the admins' /incidents;
                     chat.js has /my/chat for officers and clients and the admins' /chat)
views/               the HTML templates, one folder per area
public/              CSS, browser JavaScript, the logo (img/) and app icons (icons/), pdf.js for the
                     app's file viewer (vendor/pdfjs/), and the stand-alone timesheet form (timesheet/)
brand/               the original logo images (rectangle and square) the logo and icons were made from
assets/              the blank DMI timesheet and incident report PDFs the app fills in
netlify/
  database/migrations/   the database tables (like spreadsheet tabs), applied by Netlify
  functions/app.mjs      runs the whole app on Netlify
  functions/autopilot.mjs  the timed jobs, every 5 minutes on the live site
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
- **Every evening at 21:07 US Pacific time** (a few minutes after the hour, when GitHub is less busy), GitHub automatically runs the tests on `dev`. If they
  all pass, it copies `dev` into `main`. If they fail, `main` is left alone. You'll see a red ❌
  in the **Actions** tab on GitHub. This is set up in `.github/workflows/nightly-dev-to-main.yml`.
- To copy `dev` to `main` right away instead of waiting, open the **Actions** tab, choose
  **Nightly dev → main**, then **Run workflow**. Do the same if a night's copy hasn't happened:
  when GitHub is busy it can start the job hours late, or skip a night.

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

**Two-step sign-in (MFA):** a stolen or guessed password alone gets nobody in. Everyone picks one
(or both) of two ways:
- **A passkey (easiest, especially on iPhone):** the phone or computer remembers them, and they sign
  in with **Face ID, Touch ID** or its screen lock: no password and no code to type. Tap **Sign in
  with a passkey** on the sign-in page (iPhones also offer it right in the email box). On iPhone,
  iPad and Mac, passkeys are kept in iCloud Keychain, so one passkey works on all their Apple devices
  and moves to a new iPhone by itself. A passkey only works on this website, so a fake look-alike
  site can't use it. Add or remove them under **My account → Passkeys**.
- **An authenticator app:** after their password, they type a 6-digit code from an app on their
  phone (Google Authenticator, Microsoft Authenticator, 1Password...).
- **Setting it up:** the first time someone signs in, the site offers both: **Add a passkey**, or a
  QR code to scan with the app. Then 10 one-time **backup codes** to keep safe (for when they don't
  have their phone).
- **Remember this device:** ticking it at sign-in skips the code (never the password) on that phone
  or computer for 30 days.
- **Lost phone:** an admin opens **User accounts → the person → Reset two-step sign-in** (check it's
  really them first). That also removes their passkeys. They set it up again at their next sign-in.
- **Who needs it:** everyone by default. **Settings → Sign-in security** can limit it to the office;
  admins and managers always need it.
- **Extra check:** these ask for a fresh code (or passkey) if the last one was more than 15 minutes
  ago: pages and downloads with full Social Security, tax ID or bank account numbers (the 1099 and
  W-2 filing summaries and company copies, the DE 9C, new hire report details, the direct deposit
  file), adding or approving a bank account, changes to user accounts or settings, changing your own
  two-step sign-in or passkeys, and downloading a conversation's PDF.
- **Free:** passkeys and codes come from the phone itself, so there's no texting or email service to pay for.
- **Good to know:** a passkey belongs to one web address. Passkeys made on the live site
  (dmi.codehound.org) don't work on a preview address, and the other way round.

**Signing out:** **Sign out** is at the bottom of the side menu, at the top right on phones, and on
**My account**. My account also lists where you're signed in, with **Sign out everywhere else**,
and your recent sign-ins.

**Also built in:** scrambled (hashed) passwords; very common passwords, and ones that are mostly
your own name or email, are refused; sign-in lockout after 5 wrong passwords (or 30 from one
connection, across all accounts) and after 5 wrong codes (or 20 failed passkey tries from one
connection); everyone signs in again after 12 hours, and after 8 idle hours; an app notification when someone signs in to your account, or gets your password
right but the code wrong; changing your password signs you out everywhere else; signed-in pages
are never kept by the browser (so the back button can't show them after signing out); protection
against forged forms (CSRF) and other common attacks (security headers); uploaded files that only
signed-in users can download; managers who can't see pay; and an activity log. New sign-ups can't
see anything until an admin approves them (and at most 5 sign-ups per connection every 15 minutes).
Officers and clients only ever reach their own pages.

**Tax ID numbers** (from officers' W-9, W-4 and DE 4 details) are stored encrypted, and only the
last 4 digits are shown, except on the company's own copies of the 1099 (Copy C and 1) and W-2
(Copy D), the admin-only filing summaries, the DE 9C download and new hire report details (opening
any of them is logged). For stronger protection, set a `TAX_ID_KEY` environment variable in Netlify
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

**App notifications** need nothing set up: the site makes its own key pair the first time (kept
in the database). Each person turns them on under **My details** (officers) or **My account**
(the office and clients), once per phone or computer. Officers are shown **Set up the DMI app** (`/my/setup`) after
signing up and can't use their pages until they're on. A phone only has one person's notifications:
whoever signed in on it last. Phones don't let a website add itself to the Home Screen or turn on its
own notifications: the person taps **Add** and **Allow** themselves, and the setup page shows how
(on Android, a button opens the phone's own install box). On an **iPhone or iPad** (iOS 16.4 or newer), they first add
the site to the Home Screen (Safari → Share → **Add to Home Screen**) and open it from there; the
page shows these steps. Notifications are free: they go through Apple's, Google's or Mozilla's own
push services.

**Reminders** go out by themselves, as app notifications (no email):
- **Shifts:** each officer gets one 24 hours before each shift ("Shift tomorrow at 06:00"), and
  another 2 hours before ("Your shift starts at 06:00"). If an officer is given a shift, or its time
  changes, after a reminder would have gone out, they're told about the change straight away
  instead, so they don't get two messages at once.
- **Time cards due:** 2 days before a pay period ends (Thursday, from 9 am), officers who have
  shifts or hours in it are asked to check their hours in **My pay** and tell the office about
  anything missing or wrong. Admins and managers are asked to fix any hours before the pay run.
- An officer only gets them if they've turned on notifications. Their staff page shows
  **App notifications: On** or **Off**.
- They're sent by the timed jobs below, so on the live site they arrive within 5 minutes of the
  time. On a preview site they only go out when someone is using it.

**Timed jobs:** every 5 minutes the live site records the hours of shifts that have ended, offers
a repeating request's shifts as they come within two weeks, moves open-shift offers along, sends
reminders (shifts, time cards, tax payments, new hire reports), and removes messages older than
2 years (`netlify/functions/autopilot.mjs`). Netlify only runs timed jobs on the
live site, so on the preview (and on your computer) the same jobs run when someone loads a page,
at most once a minute. That's about 8,600 short runs a month, a few of Netlify's credits.

**Running it somewhere else:** any host that can run Node.js and a Postgres database works. Set
`DATABASE_URL` to the database's address, `SESSION_SECRET`, and `HTTPS=true` once it's on https.

**Back-ups:** on your computer, everything is in the `data` folder: copy it somewhere safe while the
app is stopped. On the live site, the data is in Netlify Database, and Netlify takes a snapshot
of it each time a new version of the site goes live. Download the pay-run spreadsheets as you go,
and ask for help setting up regular database snapshots too.

---

## 5. Ideas for later

- Clock in/out from the officer's phone, to catch late starts automatically
- Client invoicing (bill rates per site)
- Email reminders for expiring licenses and unfilled shifts
