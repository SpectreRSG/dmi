# DMI Timesheet (dmi.codehound.org)

A one-page tool that fills in the Direct Measures Inc. timesheet PDF.
Type Clock in and Clock out for each shift (hours are calculated from those and
cannot be typed), click **Download PDF**, and get the filled form back.

Everything happens in the browser: the officer's details, hours and drawn
signature are kept in that browser's `localStorage`, and the PDF is built on
the device with [pdf-lib](https://pdf-lib.js.org) (MIT, vendored as
`pdf-lib.min.js`, license in `pdf-lib.LICENSE.md`). No server, no database.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page |
| `style.css` | How it looks (light and dark) |
| `app.js` | Pay periods, totals, signature pad, and PDF filling |
| `dmi-timesheet-template.pdf` | The blank DMI form (no name, hours or signature) |

## Pay periods

Two weeks, Sunday to Saturday, counted from 7/20/2025 (`ANCHOR` in `app.js`).
If DMI's schedule changes, change `ANCHOR` and `PERIOD_DAYS`.

## Where text lands on the form

`LAYOUT` in `app.js` holds the positions in PDF points from the top of the
page. Nudge those numbers if anything prints slightly off.

## Hosting

Served at dmi.codehound.org/timesheet/ as plain files from the `public/`
folder, alongside the admin app. It was the temporary placeholder for the site
while the admin app moved to Netlify. Officers' hours now come from the schedule
in the admin app, but the page stays online for anyone who wants to fill in the
DMI timesheet PDF this way. It is kept separate from the admin app on purpose:
nothing in the app links here, this page doesn't link to the app, and it needs
no account. People get the address directly. Originally copied from the `dmi/` folder of
the SpectreRSG/CodeHound repository (branch `dmi-timesheet`, commit `ec878c1`).
Its security headers are set in the root `netlify.toml`.
