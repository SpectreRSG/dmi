// In-app messages between each officer or client and the office (the admins):
// one private conversation per person, which every admin can read and answer.
// Messages are date and time stamped, can't be changed, and are kept for 2
// years (the database won't delete newer ones); purgeOld removes older ones.
const db = require('../db');
const time = require('../time');

const RETAIN_YEARS = 2;
const MAX_LENGTH = 2000;
const PEOPLE = ['officer', 'client']; // who has a conversation with the office

const THREAD_SELECT = `
  SELECT t.*, COALESCE(u.name, t.person_name) AS name, u.role AS role, u.active AS active
  FROM chat_threads t LEFT JOIN users u ON u.id = t.user_id`;

function threadById(id) {
  return db.get(`${THREAD_SELECT} WHERE t.id = ?`, id);
}

// The person's conversation with the office (made the first time it's needed if `create`).
async function threadFor(user, { create = false } = {}) {
  const found = await db.get(`${THREAD_SELECT} WHERE t.user_id = ?`, user.id);
  if (found || !create) return found || null;
  await db.run(
    'INSERT INTO chat_threads (user_id, person_name, person_role) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING',
    user.id, user.name, user.role
  );
  return db.get(`${THREAD_SELECT} WHERE t.user_id = ?`, user.id);
}

// Cleans up what someone typed: no empty messages, a sensible length.
function cleanBody(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, MAX_LENGTH);
}

async function send(thread, sender, body) {
  return db.transaction(async (tx) => {
    const id = await tx.insert(
      'INSERT INTO chat_messages (thread_id, sender_id, sender_name, sender_role, body) VALUES (?, ?, ?, ?, ?)',
      thread.id, sender.id, sender.name, sender.role, body
    );
    const { created_at: at } = await tx.get('SELECT created_at FROM chat_messages WHERE id = ?', id);
    await tx.run('UPDATE chat_threads SET last_message_at = ? WHERE id = ?', at, thread.id);
    await markRead(tx, thread.id, sender.id, id);
    return id;
  });
}

function messagesIn(threadId, { after = 0 } = {}) {
  return db.all('SELECT * FROM chat_messages WHERE thread_id = ? AND id > ? ORDER BY id', threadId, after);
}

// Up to the newest message, never backwards.
function markRead(q, threadId, userId, lastId) {
  if (!lastId) return null;
  return q.run(
    `INSERT INTO chat_reads (thread_id, user_id, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_id = GREATEST(chat_reads.last_read_id, EXCLUDED.last_read_id)`,
    threadId, userId, lastId
  );
}

// Messages someone hasn't read yet: for an admin, from officers and clients in
// any conversation; for an officer or client, from the office in theirs.
async function unreadFor(user) {
  if (user.role === 'admin') {
    const row = await db.get(
      `SELECT COUNT(*)::int AS n FROM chat_messages m
       LEFT JOIN chat_reads r ON r.thread_id = m.thread_id AND r.user_id = ?
       WHERE m.sender_role <> 'admin' AND m.id > COALESCE(r.last_read_id, 0)`,
      user.id
    );
    return row.n;
  }
  if (!PEOPLE.includes(user.role)) return 0;
  const row = await db.get(
    `SELECT COUNT(*)::int AS n FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
     LEFT JOIN chat_reads r ON r.thread_id = m.thread_id AND r.user_id = ?
     WHERE t.user_id = ? AND m.sender_role = 'admin' AND m.id > COALESCE(r.last_read_id, 0)`,
    user.id, user.id
  );
  return row.n;
}

// Every conversation for the admins, newest first, with what this admin hasn't read.
function inbox(adminId) {
  return db.all(
    `SELECT t.*, COALESCE(u.name, t.person_name) AS name, u.role AS role, u.active AS active,
       (SELECT COUNT(*)::int FROM chat_messages m WHERE m.thread_id = t.id AND m.sender_role <> 'admin'
          AND m.id > COALESCE(r.last_read_id, 0)) AS unread,
       last.body AS last_body, last.sender_name AS last_sender
     FROM chat_threads t LEFT JOIN users u ON u.id = t.user_id
     LEFT JOIN chat_reads r ON r.thread_id = t.id AND r.user_id = ?
     LEFT JOIN LATERAL (SELECT body, sender_name FROM chat_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) last ON true
     WHERE t.last_message_at IS NOT NULL ORDER BY t.last_message_at DESC, t.id DESC LIMIT 500`,
    adminId
  );
}

// The officers and clients an admin can start a conversation with.
function people() {
  return db.all("SELECT id, name, role FROM users WHERE role = ANY(?::text[]) AND active = 1 ORDER BY name", PEOPLE);
}

// For the page and the live updates: each message with its day and time.
function present(message, viewer) {
  const at = message.created_at;
  const mine = message.sender_id === viewer.id;
  const fromOffice = message.sender_role === 'admin';
  return {
    id: message.id,
    // The viewer's side of the conversation is on the right: the office's for admins, their own otherwise.
    right: viewer.role === 'admin' ? fromOffice : mine,
    label: mine ? 'You' : `${message.sender_name}${fromOffice && viewer.role !== 'admin' ? ' (office)' : ''}`,
    day: `${time.fmtDay(at.slice(0, 10))} ${at.slice(0, 4)}`,
    time: time.fmtTime(at),
    at,
    body: message.body,
  };
}

// The whole conversation as plain text, for keeping or sending on.
function logText(thread, messages, companyName) {
  const lines = [
    `${companyName}: messages with ${thread.name} (${thread.person_role})`,
    `Downloaded ${time.nowStr().replace('T', ' ')}. Times are company time. Messages are kept for ${RETAIN_YEARS} years.`,
    '',
  ];
  for (const m of messages) lines.push(`[${m.created_at}] ${m.sender_name}${m.sender_role === 'admin' ? ' (office)' : ''}:`, ...m.body.split('\n').map((l) => `  ${l}`), '');
  return `${lines.join('\r\n')}\r\n`;
}

// Removes messages (and conversations left empty) older than 2 years. Run by the jobs.
async function purgeOld() {
  const cutoff = `${time.addMonths(time.todayStr(), -12 * RETAIN_YEARS)} 00:00:00`;
  await db.run('DELETE FROM chat_messages WHERE created_at < ?', cutoff);
  await db.run(
    'DELETE FROM chat_threads t WHERE COALESCE(t.last_message_at, t.created_at) < ? AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.thread_id = t.id)',
    cutoff
  );
}

module.exports = {
  RETAIN_YEARS, MAX_LENGTH, PEOPLE, threadById, threadFor, cleanBody, send, messagesIn, markRead, unreadFor, inbox, people, present, logText, purgeOld,
};
