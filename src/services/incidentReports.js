// Use of force and incident reports.
//
// An officer fills one in on their phone, signs it (types their full legal
// name) and sends it to the admins. The admins review it: they record what
// was reported where (page 7 of the form) and approve it, or ask the officer
// for more information. Once sent, the officer's account is never changed
// (the database refuses to): anything new goes in a dated supplement.
// Reports are kept for 5 years after the incident; see the migration.
//
// The questions are the California PPO incident record in
// assets/incident-report-template.pdf, and each one has the same name as its
// box on that form, so a report can be printed on it (pdfFor below).
const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFTextField, PDFCheckBox, StandardFonts, rgb } = require('pdf-lib');
const config = require('../config');
const db = require('../db');
const time = require('../time');

const RETAIN_YEARS = 5;
const STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Waiting for review',
  info_requested: 'More information asked for',
  approved: 'Approved',
};

// ---- The questions -------------------------------------------------------------------

const check = (name, label) => ({ type: 'check', name, label });
const text = (name, label, extra = {}) => ({ type: 'text', name, label, ...extra });
const long = (name, label, extra = {}) => ({ type: 'textarea', name, label, ...extra });
// A table on the form: boxes named `${prefix}_${row}_${column}`.
const rows = (prefix, count, columns, label) => ({ type: 'rows', prefix, count, columns, label });

const FIREARM_TICKS = ['type_firearm_display', 'type_discharge', 'force_draw', 'force_point', 'force_discharge'];

// What the officer fills in, in order.
const SECTIONS = [
  {
    id: 'type',
    title: 'What happened',
    help: 'Tick everything that applies.',
    fields: [
      { type: 'heading', label: 'Type of incident' },
      check('type_force', 'Physical contact or force'),
      check('type_firearm_display', 'Firearm displayed, drawn or pointed'),
      check('type_discharge', 'Firearm discharged'),
      check('type_other_weapon', 'Other deadly weapon displayed or used'),
      check('type_restraint', 'Restraint, detention or citizen arrest'),
      check('type_injury', 'Injury, first aid or medical care'),
      check('type_complaint', 'Complaint or allegation of force'),
      check('type_damage', 'Property damage'),
      check('type_police', 'Police report or investigation'),
      check('type_other', 'Other'),
      { type: 'heading', label: 'Done straight away' },
      check('immediate_911', 'Emergency services / 911 requested'),
      check('immediate_scene_safe', 'Scene made safe and medical aid arranged'),
      check('immediate_supervisor', 'Supervisor or on-call manager told'),
      check('immediate_client', 'Client or site contact told (as the contract says)'),
      check('immediate_police', 'Police asked to come, or told'),
      check('immediate_preserve', 'Started keeping evidence and recordings'),
    ],
  },
  {
    id: 'when',
    title: 'When and where',
    fields: [
      text('incident_date', 'Date', { input: 'date', required: true }),
      text('incident_start', 'Start time', { input: 'time', required: true }),
      text('incident_end', 'End time', { input: 'time' }),
      text('site_client', 'Site / client'),
      text('post_assignment', 'Post / assignment'),
      text('street_address', 'Street address'),
      text('city_county', 'City / county'),
      text('specific_location', 'Exact spot (e.g. north car park, level 2)'),
      text('site_setting', 'Indoor or outdoor', { choices: ['Indoor', 'Outdoor', 'Both', 'In a vehicle'] }),
      text('site_contact', 'Site contact'),
      text('reported_by', 'Reported by'),
    ],
  },
  {
    id: 'you',
    title: 'About you',
    adminTitle: 'About the person reporting',
    help: "Filled in from your account, staff record and shift where we could. Check it, and fill in the rest. Only the admins see these details.",
    // `staffOnly`: about working as a guard for DMI, so not asked of clients.
    fields: [
      text('guard_name', 'Full legal name', { required: true }),
      text('guard_address', 'Home mailing address'),
      text('guard_dob', 'Date of birth', { input: 'date' }),
      text('guard_registration', 'BSIS guard registration number', { staffOnly: true }),
      text('guard_firearm_permit', 'Firearms permit number / status', { staffOnly: true }),
      text('guard_baton_permit', 'Baton permit number, if you have one', { staffOnly: true }),
      text('guard_employer', 'Employer legal name and PPO license number', { staffOnly: true }),
      text('guard_employer_address', 'Employer business address / phone', { staffOnly: true }),
      text('guard_shift', 'Shift / time on duty', { staffOnly: true }),
      text('guard_client_post', 'Client and post orders / contract reference', { staffOnly: true }),
      text('guard_uniform', 'Uniform / identification you wore', { staffOnly: true }),
      text('guard_camera', 'Body-worn camera ID and whether it was recording', { staffOnly: true }),
    ],
  },
  {
    id: 'people',
    title: 'Other people involved',
    help: 'Other employees, the person affected, whoever reported it, client staff, witnesses and responders. Write "unknown" for anything you don\'t know: don\'t guess.',
    fields: [
      rows('employee', 3, ['Name', 'Registration / role', 'What they did or saw', 'Contact'], 'Other employee'),
      rows('participant', 4, ['Name / description', 'Role (e.g. person stopped, witness, client staff)', 'Contact / address, if known', 'How you know who they are'], 'Other person'),
    ],
  },
  {
    id: 'scene',
    title: 'The scene, and what happened when',
    help: 'Use local times, and say when a time is a guess. Keep what you saw yourself separate from what someone told you or what a recording shows.',
    fields: [
      { type: 'heading', label: 'Before contact or force: what mattered' },
      check('scene_lighting', 'Lighting / visibility'),
      check('scene_weather', 'Weather / noise'),
      check('scene_crowd', 'Crowd / bystanders'),
      check('scene_layout', 'Physical layout / obstacles'),
      check('scene_distance', 'Distance / where people stood'),
      check('scene_weapons', 'Known or visible weapons'),
      check('scene_radio', 'Communications / radio coverage'),
      check('scene_cameras', 'Cameras or recordings in the area'),
      long('scene_vantage', 'Where you were, and what you could see from there'),
      long('scene_other_location', "Where the other person was, and how far away"),
      long('scene_observed_actions', 'What you saw the person do'),
      long('scene_exact_words', 'Exact words you heard (who said them, to whom)'),
      long('scene_knowledge_source', 'What you knew at the time, and how you knew it'),
      rows('chronology', 6, ['Time', 'What happened, or exact words', 'Who saw it / source'], 'Step'),
      { type: 'heading', label: 'Talking and calming things down' },
      long('communication_commands', 'Commands, requests or warnings you gave'),
      long('communication_words', 'Exact words, if you remember them'),
      long('communication_response', 'How the person responded, and when'),
      long('communication_steps', 'What you did to slow things down, separate people or reduce the conflict'),
      long('communication_needs', 'Language or communication needs you noticed or were told about'),
      text('communication_contact', 'When you contacted your supervisor / responders'),
    ],
  },
  {
    id: 'force',
    title: 'Force and weapons',
    help: "Describe each action in order: when it started and ended, what changed, and what made you stop or change. Stick to facts: don't use words like 'appropriate', 'necessary' or 'excessive'.",
    fields: [
      { type: 'heading', label: 'What was used' },
      check('force_verbal', 'Verbal direction / warning only'),
      check('force_control', 'Physical control / restraint'),
      check('force_strike', 'Strike / takedown'),
      check('force_baton', 'Baton / impact weapon'),
      check('force_chemical', 'Chemical agent / other device'),
      check('force_draw', 'Firearm drawn / out of holster'),
      check('force_point', 'Firearm aimed / pointed / displayed'),
      check('force_discharge', 'Firearm discharged'),
      check('force_other', 'Other weapon or force'),
      { type: 'heading', label: 'The action' },
      text('force_employee', 'Employee who used force'),
      text('force_sequence', 'Action number (1, 2, 3…)'),
      text('force_start', 'Started (date / time)'),
      text('force_end', 'Ended (date / time)'),
      text('force_type', 'Type of action / equipment'),
      text('force_duration', 'About how long / how many times'),
      text('force_body_area', 'Part of the body contacted'),
      text('force_resistance', 'Resistance or movement you saw'),
      text('force_stop', 'When it stopped or changed'),
      text('force_outcome', 'Outcome (control / separation)'),
      long('force_before', 'What you saw just before acting'),
      long('force_changed', 'Words or actions that changed the situation'),
      long('force_warnings', 'Warnings, the chance to comply, and the response'),
      long('force_background', 'People nearby / line of sight / what was behind'),
      long('force_others', 'What each other employee did'),
      {
        type: 'group',
        label: 'Firearm details',
        help: 'For a firearm displayed, pointed or discharged.',
        showIfAny: FIREARM_TICKS,
        fields: [
          text('firearm_status', 'Displayed, pointed or discharged?'),
          text('firearm_employee', 'Employee / permit'),
          text('firearm_make', 'Make / model'),
          text('firearm_caliber', 'Caliber'),
          text('firearm_serial', 'Serial number'),
          text('firearm_permit_match', 'Does the permit caliber match?'),
          text('firearm_discharge_type', 'Intentional or unintentional?'),
          text('firearm_rounds', 'Number of rounds'),
          text('firearm_distance', 'About how far / which direction'),
          text('firearm_warning', 'Warning given?'),
          text('firearm_struck', 'Person or object struck'),
          text('firearm_injury', 'Known injury / damage'),
          long('firearm_round_location', 'Where each round went / where it ended up'),
          long('firearm_evidence', 'Casings, bullets, or what happened to the weapon'),
          long('firearm_transfer', 'Who the firearm was secured with or handed to, and when'),
        ],
      },
    ],
  },
  {
    id: 'after',
    title: 'Injuries, police and evidence',
    fields: [
      rows('injury', 3, ['Person', 'Injury or complaint you saw', 'First aid / medical care / transport', 'Refused / unknown'], 'Injury'),
      text('ems_call', '911 / EMS (time / who called / outcome)'),
      text('first_aid', 'First aid (who / when)'),
      text('medical_provider', 'Hospital or provider, if known'),
      text('property_damage', 'Property damage / owner / estimate'),
      { type: 'heading', label: 'Police and others told' },
      text('police_agency', 'Police agency / jurisdiction'),
      text('police_officer', 'Officer / unit'),
      text('police_arrival', 'Arrival time'),
      text('police_case', 'Case / report number'),
      text('police_investigation', 'Police investigation?'),
      text('public_report', 'Did a member of the public file a report?'),
      text('public_medical', 'Did a member of the public need medical care?'),
      text('arrest_custody', 'Arrest / citation / custody'),
      text('supervisor_notified', 'Supervisor told (name / time)'),
      text('client_notified', 'Client told (name / time)'),
      long('police_statements', 'What the responding officers said or asked you to do'),
      long('custody_transfer', 'Who a person or property was handed over to'),
      { type: 'heading', label: 'Evidence and records to keep' },
      check('evidence_bodycam', 'Body-worn camera / audio'),
      check('evidence_cctv', 'Fixed CCTV / access control video'),
      check('evidence_dash', 'Dash camera / vehicle GPS'),
      check('evidence_radio', 'Radio / dispatch / phone logs'),
      check('evidence_photos', 'Photographs / scene diagram'),
      check('evidence_firearm', 'Firearm / magazine / ammo / casings'),
      check('evidence_clothing', 'Clothing / damaged property'),
      check('evidence_statements', 'Witness / participant statements'),
      check('evidence_medical', 'Medical or first-aid records'),
      check('evidence_orders', 'Post orders / contract / training records'),
      rows('evidence_log', 3, ['Item / source', 'Kept by / date and time', 'Where it is stored'], 'Evidence item'),
    ],
  },
  {
    id: 'account',
    title: 'Your account',
    adminTitle: 'Their account',
    help: "In your own words, in the order it happened (\"I saw…\", \"I said…\"). Say what you saw yourself, what others told you, what's a guess, and what you don't know. Include what happened before and after any force, even facts that don't support how you saw it.",
    fields: [
      long('guard_narrative', 'What happened', { required: true, big: true, max: 20000 }),
      long('guard_supplement', 'Anything else you noticed (optional)', { max: 10000 }),
      {
        type: 'group',
        label: 'A witness or other employee statement (if one was taken)',
        fields: [
          text('statement_person', 'Person giving the statement'),
          text('statement_role', 'Their role'),
          text('statement_taker', 'Statement taken by'),
          text('statement_time_place', 'Date / time / place'),
          text('statement_format', 'Written, recorded or a summary?'),
          text('statement_attachment', 'Attached pages / file'),
          text('statement_adopted', 'Did they read it and agree with it?'),
          text('statement_signature', 'Their signature / date, if given'),
        ],
      },
    ],
  },
];

// The admins' review (page 7 of the form).
const DUTIES = [
  {
    title: 'Guard notice to employer: BPC 7583.3(d)',
    when: 'For an on-duty firearm discharge in course and scope, the guard reports the circumstances to the employer within 24 hours.',
  },
  {
    title: 'BSIS report: BPC 7583.2(f)',
    when: 'Firearm discharge or qualifying on-duty physical altercation: report to BSIS within 7 business days. Triggers include arrest, a police report filed by a member of the public, first aid or medical attention to a member of the public, employer discipline, or physical use of force or violence on a person while on duty. A hospital-requested patient-restraint exception may apply.',
  },
  {
    title: 'BSIS and local law enforcement: BPC 7583.4',
    when: 'For any firearm discharge in course and scope, use the prescribed report to BSIS and provide a copy to the local police or sheriff with jurisdiction within 7 days.',
  },
];

const REVIEW_SECTIONS = [
  {
    id: 'reporting',
    title: 'California PPO reporting',
    fields: [
      { type: 'duties' },
      check('immediate_guard_notice', "Guard's firearm-discharge notice to the employer tracked"),
      check('immediate_reporting', 'BSIS / local-agency reporting assigned'),
    ],
  },
  {
    id: 'completeness',
    title: 'Completeness and keeping evidence',
    fields: [
      check('review_accounts', 'Separate accounts obtained / assigned'),
      check('review_participants', 'Participants identified, or unknown noted'),
      check('review_injuries', 'Injuries and damage documented'),
      check('review_police', 'Police agency / case number checked'),
      check('review_recordings', 'Recordings identified and asked to be kept'),
      check('review_evidence', 'Firearm / physical evidence secured and logged'),
      check('review_contract', 'Client / contract notice checked'),
      check('review_supplement', 'Supplement needed, or due date set'),
      text('bsis_version', 'Current BSIS form version checked'),
      text('policy_checked', 'Policy / post orders checked'),
      text('legal_contact', 'Legal / risk contact (name / time)'),
      text('followup_owner', 'Follow-up owner / date'),
      long('open_items', 'Open items'),
    ],
  },
  {
    id: 'filings',
    title: 'Filings made',
    fields: [rows('filing_log', 3, ['Filing / agency', 'Sent by / date and time', 'Method / receipt or case number', 'Copy kept at'], 'Filing')],
  },
];

// Every answer box, flattened: [{ name, type, label, max }]
function boxesOf(sections) {
  const out = [];
  const walk = (fields) => {
    for (const f of fields) {
      if (f.type === 'group') walk(f.fields);
      else if (f.type === 'rows') {
        for (let r = 1; r <= f.count; r += 1) {
          f.columns.forEach((label, c) => out.push({ name: `${f.prefix}_${r}_${c + 1}`, type: 'text', label: `${f.label} ${r}: ${label}`, max: 1000 }));
        }
      } else if (f.type === 'duties') {
        DUTIES.forEach((d, i) => {
          out.push({ name: `report_row_${i + 1}_1`, type: 'text', label: `${d.title}: owner / due`, max: 300 });
          out.push({ name: `report_row_${i + 1}_2`, type: 'text', label: `${d.title}: filed / recipient / receipt`, max: 500 });
        });
      } else if (f.name) out.push({ ...f, max: f.max || (f.type === 'textarea' ? 5000 : 300) });
    }
  };
  for (const s of sections) walk(s.fields);
  return out;
}
const OFFICER_BOXES = boxesOf(SECTIONS);
const REVIEW_BOXES = boxesOf(REVIEW_SECTIONS);
const LABELS = Object.fromEntries([...OFFICER_BOXES, ...REVIEW_BOXES].map((b) => [b.name, b.label]));
const TYPE_BOXES = OFFICER_BOXES.filter((b) => b.name.startsWith('type_'));

// Reads posted answers: only known boxes, trimmed and length-limited.
function readAnswers(body, boxes) {
  const out = {};
  for (const box of boxes) {
    const raw = body?.[box.name];
    if (box.type === 'check') {
      if (raw === '1' || raw === 'on' || (Array.isArray(raw) && raw.includes('1'))) out[box.name] = true;
      continue;
    }
    const value = String(Array.isArray(raw) ? raw[0] : raw ?? '').replace(/\r\n/g, '\n').trim().slice(0, box.max);
    if (value) out[box.name] = value;
  }
  return out;
}

const typeLabels = (data) => TYPE_BOXES.filter((b) => data[b.name]).map((b) => b.label);
const firearmDischarge = (data) => Boolean(data.type_discharge || data.force_discharge);

// A report's answers, ready to show: only what was filled in, section by
// section. Items are { kind: 'checks', label, labels }, { kind: 'fact', label,
// value }, { kind: 'rows', label, columns, rows } or { kind: 'group', label, items }.
// For the admins (`forAdmin`), "About you" reads "About the officer".
function present(sections, data, { forAdmin = false } = {}) {
  const itemsOf = (fields, fallbackLabel) => {
    const items = [];
    let checks = null;
    let heading = fallbackLabel;
    const flush = () => {
      if (checks?.labels.length) items.push(checks);
      checks = null;
    };
    for (const f of fields) {
      if (f.type === 'heading') {
        flush();
        heading = f.label;
      } else if (f.type === 'check') {
        checks ??= { kind: 'checks', label: heading, labels: [] };
        if (data[f.name]) checks.labels.push(f.label);
      } else {
        flush();
        if (f.type === 'group') {
          const inner = itemsOf(f.fields, f.label);
          if (inner.length) items.push({ kind: 'group', label: f.label, items: inner });
        } else if (f.type === 'rows') {
          const filled = [];
          for (let r = 1; r <= f.count; r += 1) {
            const row = f.columns.map((_, c) => data[`${f.prefix}_${r}_${c + 1}`] || '');
            if (row.some(Boolean)) filled.push(row);
          }
          if (filled.length) items.push({ kind: 'rows', label: f.label, columns: f.columns, rows: filled });
        } else if (f.name && data[f.name]) {
          const value = f.input === 'date' && time.isValidDate(data[f.name]) ? time.fmtDate(data[f.name]) : data[f.name];
          items.push({ kind: 'fact', label: f.label, value, long: f.type === 'textarea' });
        }
      }
    }
    flush();
    return items;
  };
  return sections
    .map((s) => ({ id: s.id, title: (forAdmin && s.adminTitle) || s.title, items: itemsOf(s.fields.filter((f) => f.type !== 'duties'), s.title) }))
    .filter((s) => s.items.length);
}

// ---- Starting, saving and sending --------------------------------------------------------

function nextNumber(id, date) {
  return `IR-${date.slice(0, 4)}-${String(id).padStart(4, '0')}`;
}

// Who wrote a report, for lists and notifications.
const reporterOf = (r) => (r.first_name ? `${r.first_name} ${r.last_name}` : r.reporter_name || 'Unknown');

// What we can fill in for the person reporting: their staff record (if they
// have one) or account, the shift, the company (for DMI staff, not clients).
function prefill({ employee, user, shift, site, settings }) {
  const name = employee ? `${employee.first_name} ${employee.last_name}` : user.name;
  const staff = user.role !== 'client';
  const placeName = site ? `${site.name}${site.client_name ? ` (${site.client_name})` : ''}` : '';
  const employer = [settings.payer_name || settings.company_name, settings.ppo_license && `PPO license ${settings.ppo_license}`].filter(Boolean).join(', ');
  const cityLine = [settings.payer_city, [settings.payer_state, settings.payer_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const employerAddress = [settings.payer_address, cityLine, settings.payer_phone].filter(Boolean).join(', ');
  const data = {
    incident_date: shift ? shift.start_at.slice(0, 10) : time.todayStr(),
    site_client: placeName,
    street_address: site?.address || '',
    reported_by: name,
    guard_name: name,
    guard_address: employee?.address || '',
    guard_registration: employee?.license_number || '',
    guard_employer: staff ? employer : '',
    guard_employer_address: staff ? employerAddress : '',
    guard_shift: shift ? `${time.fmtDay(shift.start_at)} ${shift.start_at.slice(0, 4)}, ${time.fmtRange(shift.start_at, shift.end_at)}` : '',
    guard_client_post: staff ? placeName : '',
  };
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v));
}

// `employee`: the writer's staff record, or null (clients, office staff without one).
async function create({ employee, user, shift, site, settings }) {
  return db.transaction(async (tx) => {
    const id = await tx.insert(
      `INSERT INTO incident_reports (employee_id, created_by, reporter_name, reporter_role, shift_id, site_id, data, updated_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      employee?.id || null, user.id, employee ? `${employee.first_name} ${employee.last_name}` : user.name, user.role,
      shift?.id || null, site?.id || null, JSON.stringify(prefill({ employee, user, shift, site, settings })), Date.now()
    );
    await tx.run('UPDATE incident_reports SET number = ? WHERE id = ?', nextNumber(id, time.todayStr()), id);
    return id;
  });
}

function find(id) {
  return db.get(
    `SELECT r.*, e.first_name, e.last_name, si.name AS site_name, c.name AS client_name, a.name AS approved_by_name
     FROM incident_reports r LEFT JOIN employees e ON e.id = r.employee_id
     LEFT JOIN sites si ON si.id = r.site_id LEFT JOIN clients c ON c.id = si.client_id
     LEFT JOIN users a ON a.id = r.approved_by WHERE r.id = ?`,
    id
  );
}

// Saves a draft's answers.
async function saveDraft(report, data) {
  await db.run(
    "UPDATE incident_reports SET data = ?, incident_date = ?, incident_start = ?, types = ?, updated_ms = ? WHERE id = ? AND status = 'draft'",
    JSON.stringify(data), time.isValidDate(data.incident_date) ? data.incident_date : null, data.incident_start || null,
    TYPE_BOXES.filter((b) => data[b.name]).map((b) => b.name).join(',') || null, Date.now(), report.id
  );
}

// What's missing before it can be sent. Returns a message, or null.
function submitProblem(data, { attest, signature }) {
  if (!time.isValidDate(data.incident_date)) return 'Enter the date of the incident (under "When and where").';
  if (data.incident_date > time.todayStr()) return "The incident date can't be in the future.";
  if (!/^\d{2}:\d{2}$/.test(data.incident_start || '')) return 'Enter the time the incident started (under "When and where").';
  if (!typeLabels(data).length) return 'Tick at least one type of incident (under "What happened").';
  if (!data.guard_name) return 'Enter your full legal name (under "About you").';
  if (!data.guard_narrative || data.guard_narrative.length < 20) return 'Write what happened in your own words (under "Your account").';
  if (!attest) return 'Tick the box to confirm you have reviewed your account.';
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!norm(signature) || norm(signature) !== norm(data.guard_name)) {
    return 'To sign, type your full legal name exactly as it is under "About you".';
  }
  return null;
}

// Kept until 5 years after the incident (an incident on 29 February: until 1 March).
function retainUntilFor(date) {
  const year = Number(date.slice(0, 4)) + RETAIN_YEARS;
  return date.slice(5) === '02-29' ? `${year}-03-01` : `${year}${date.slice(4)}`;
}

async function submit(report, data, { signature, user, ip }) {
  const now = time.nowStr();
  const signed = { ...data, guard_signature: signature.trim(), guard_printed_name: data.guard_name, guard_signed: fmtStamp(now) };
  await db.transaction(async (tx) => {
    const done = await tx.run(
      `UPDATE incident_reports SET data = ?, status = 'submitted', submitted_at = ?, signed_name = ?, signed_ip = ?,
         incident_date = ?, incident_start = ?, types = ?, retain_until = ?, updated_ms = ?
       WHERE id = ? AND status = 'draft'`,
      JSON.stringify(signed), now, signature.trim(), ip, data.incident_date, data.incident_start,
      TYPE_BOXES.filter((b) => data[b.name]).map((b) => b.name).join(','), retainUntilFor(data.incident_date),
      Date.now(), report.id
    );
    if (done.changes) await addEvent(tx, report.id, user, 'submitted');
  });
}

function addEvent(tx, reportId, user, kind, note = null) {
  return tx.run(
    'INSERT INTO incident_report_events (report_id, user_id, user_name, kind, note) VALUES (?, ?, ?, ?, ?)',
    reportId, user?.id || null, user?.name || null, kind, note
  );
}

function eventsFor(reportId) {
  return db.all('SELECT * FROM incident_report_events WHERE report_id = ? ORDER BY id', reportId);
}

function filesFor(reportId) {
  return db.all(
    'SELECT f.*, u.name AS uploaded_by_name FROM incident_report_files f LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.report_id = ? ORDER BY f.id',
    reportId
  );
}

// The deadlines on page 7 that may apply, worked out from what was ticked.
// (A reminder of what to check, not a legal finding: see the notes on the form.)
function addBusinessDays(date, days) {
  let d = date;
  for (let added = 0; added < days;) {
    d = time.addDays(d, 1);
    if (time.dayOfWeek(d) < 5) added += 1; // Monday to Friday (public holidays aren't counted here)
  }
  return d;
}

function deadlines(report) {
  const data = report.data || {};
  if (!report.incident_date) return [];
  const discharge = firearmDischarge(data);
  const physical = discharge || ['type_force', 'type_restraint', 'type_injury', 'type_police', 'type_complaint', 'force_control', 'force_strike', 'force_baton', 'force_chemical']
    .some((k) => data[k]);
  const list = [];
  if (discharge) {
    const start = `${report.incident_date}T${report.incident_start || '00:00'}`;
    const due = new Date(Date.parse(`${start}:00Z`) + 24 * 3600000).toISOString().slice(0, 16);
    list.push({ duty: 0, due, dueText: `${time.fmtDay(due)} ${due.slice(11)}`, met: report.submitted_at && report.submitted_at <= due ? 'The officer sent this report in time.' : null });
  }
  if (physical) {
    const due = addBusinessDays(report.incident_date, 7);
    list.push({ duty: 1, due, dueText: time.fmtDate(due) });
  }
  if (discharge) {
    const due = time.addDays(report.incident_date, 7);
    list.push({ duty: 2, due, dueText: time.fmtDate(due) });
  }
  return list;
}

// Can it be deleted now? Returns null if so, or the reason not.
function deleteProblem(report) {
  if (report.status === 'draft') return null;
  if (report.legal_hold) return "It's on legal hold.";
  if (!report.retain_until || report.retain_until > time.todayStr()) return `It must be kept until ${time.fmtDate(report.retain_until)} (5 years after the incident).`;
  return null;
}

// "20 Oct 2026, 22:15"
function fmtStamp(at) {
  return `${time.fmtDate(at.slice(0, 10))}, ${at.slice(11, 16)}`;
}

// ---- The PDF: the model form, filled in --------------------------------------------------

let template = null;
const PAGE_MARGIN = 54;

// The standard PDF font can't show every character (e.g. emoji): swap them for "?".
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
function pdfSafe(value) {
  return String(value)
    .replace(/\t/g, '    ')
    .replace(/[^\n\x20-\x7e\xa0-\xff]/g, (ch) => (WIN_ANSI_EXTRA.includes(ch) ? ch : '?'));
}

function wrap(textValue, font, size, width) {
  const lines = [];
  for (const paragraph of textValue.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      const next = line + word;
      if (font.widthOfTextAtSize(next, size) <= width || !line.trim()) {
        // A single word longer than the line: break it.
        if (font.widthOfTextAtSize(next, size) > width && !line.trim()) {
          let piece = '';
          for (const ch of next) {
            if (font.widthOfTextAtSize(piece + ch, size) > width) {
              lines.push(piece);
              piece = '';
            }
            piece += ch;
          }
          line = piece;
        } else line = next;
      } else {
        lines.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

// The report on the model form. Answers too long for their box, dated
// supplements, the attached files and the report's history go on numbered
// continuation pages at the end, as the form asks.
async function pdfFor(report, { events, files, settings }) {
  template ??= fs.readFileSync(path.join(config.rootDir, 'assets', 'incident-report-template.pdf'));
  const doc = await PDFDocument.load(template);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const form = doc.getForm();
  const supplements = events.filter((e) => e.kind === 'supplement');
  const review = report.review || {};
  const values = {
    ...report.data,
    ...review,
    incident_id: report.number,
    guard_incident_copy: report.number,
    report_version: supplements.length ? `Original + ${supplements.length} supplement${supplements.length === 1 ? '' : 's'}` : 'Original',
    report_status: STATUS_LABELS[report.status],
    incident_zone: settings.timezone,
    report_datetime: report.submitted_at ? fmtStamp(report.submitted_at) : '',
    reviewer_name: review.reviewer_name,
    review_datetime: review.review_datetime,
    closure_date: report.approved_at ? time.fmtDate(report.approved_at.slice(0, 10)) : '',
  };
  if (values.incident_date) values.incident_date = time.fmtDate(values.incident_date);
  if (values.guard_dob && time.isValidDate(values.guard_dob)) values.guard_dob = time.fmtDate(values.guard_dob);
  if (supplements.length) {
    values.guard_supplement = [values.guard_supplement, `${supplements.length} dated supplement${supplements.length === 1 ? '' : 's'} on the continuation pages.`].filter(Boolean).join('\n\n');
  }

  const continuation = [];
  for (const field of form.getFields()) {
    const name = field.getName();
    if (field instanceof PDFCheckBox) {
      if (values[name]) field.check();
      continue;
    }
    if (!(field instanceof PDFTextField)) continue;
    const value = values[name] ? pdfSafe(values[name]) : '';
    if (!value) continue;
    const [widget] = field.acroField.getWidgets();
    const { width, height } = widget.getRectangle();
    const multiline = field.isMultiline();
    let size = 9;
    const fits = (s) => (multiline
      ? wrap(value, font, s, width - 6).length * s * 1.2 <= height - 4
      : !value.includes('\n') && font.widthOfTextAtSize(value, s) <= width - 6);
    while (size > 6.5 && !fits(size)) size -= 0.5;
    if (fits(size)) {
      field.setFontSize(size);
      field.setText(value);
    } else {
      const ref = `C${continuation.length + 1}`;
      continuation.push({ ref, title: LABELS[name] || name, body: value });
      field.setFontSize(multiline ? 9 : 7);
      field.setText(`See continuation ${ref}`);
    }
  }
  for (const s of supplements) {
    continuation.push({ ref: `S${continuation.filter((c) => c.ref.startsWith('S')).length + 1}`, title: `Supplement by ${s.user_name || 'the officer'}, ${fmtStamp(s.created_at.replace(' ', 'T'))}`, body: pdfSafe(s.note || '') });
  }
  if (files.length) {
    continuation.push({ ref: 'F', title: 'Attached photos and files (kept with the report in the app)', body: pdfSafe(files.map((f) => `${f.file_original} (added ${fmtStamp(f.created_at.replace(' ', 'T'))}${f.uploaded_by_name ? ` by ${f.uploaded_by_name}` : ''})`).join('\n')) });
  }
  const history = events.filter((e) => e.kind !== 'supplement');
  if (history.length) {
    continuation.push({ ref: 'H', title: 'Report history', body: pdfSafe(history.map((e) => `${fmtStamp(e.created_at.replace(' ', 'T'))}  ${EVENT_LABELS[e.kind] || e.kind}${e.user_name ? ` (${e.user_name})` : ''}${e.note ? `: ${e.note}` : ''}`).join('\n')) });
  }
  form.updateFieldAppearances(font);
  form.flatten();

  // Continuation pages, the same size as the form's.
  const [first] = doc.getPages();
  const { width: pageW, height: pageH } = first.getSize();
  const lineWidth = pageW - PAGE_MARGIN * 2;
  let page = null;
  let y = 0;
  const newPage = () => {
    page = doc.addPage([pageW, pageH]);
    page.drawText(pdfSafe(`Continuation: incident ${report.number}`), { x: PAGE_MARGIN, y: pageH - PAGE_MARGIN, size: 12, font: bold, color: rgb(0.12, 0.2, 0.3) });
    page.drawText('Sensitive incident record - restrict access under company records procedures', { x: PAGE_MARGIN, y: 30, size: 7, font, color: rgb(0.4, 0.4, 0.4) });
    y = pageH - PAGE_MARGIN - 24;
  };
  for (const item of continuation) {
    if (!page || y < 120) newPage();
    for (const line of wrap(`${item.ref}. ${pdfSafe(item.title)}`, bold, 10, lineWidth)) {
      page.drawText(line, { x: PAGE_MARGIN, y, size: 10, font: bold });
      y -= 14;
    }
    for (const line of wrap(item.body, font, 9.5, lineWidth)) {
      if (y < 50) newPage();
      page.drawText(line, { x: PAGE_MARGIN, y, size: 9.5, font });
      y -= 12.5;
    }
    y -= 10;
  }
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    if (i >= 8) p.drawText(`Page ${i + 1}`, { x: pageW - PAGE_MARGIN - 30, y: 30, size: 7, font, color: rgb(0.4, 0.4, 0.4) });
  });
  doc.setTitle(`Use of Force and Incident Report ${report.number}`);
  return Buffer.from(await doc.save());
}

const EVENT_LABELS = {
  submitted: 'Signed and sent for review',
  info_requested: 'More information asked for',
  supplement: 'Supplement added',
  review_saved: 'Review notes saved',
  approved: 'Approved',
  reopened: 'Back for review (supplement after approval)',
  file: 'File added',
  hold_on: 'Put on legal hold',
  hold_off: 'Legal hold taken off',
};

module.exports = {
  RETAIN_YEARS, STATUS_LABELS, SECTIONS, REVIEW_SECTIONS, DUTIES, FIREARM_TICKS, OFFICER_BOXES, REVIEW_BOXES, LABELS, EVENT_LABELS,
  readAnswers, present, typeLabels, firearmDischarge, prefill, create, find, saveDraft, submitProblem, submit, addEvent, eventsFor, filesFor,
  deadlines, deleteProblem, fmtStamp, pdfFor, addBusinessDays, retainUntilFor, reporterOf,
};
