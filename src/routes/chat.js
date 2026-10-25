// Messages: each officer's or client's private conversation with the office
// (/my/chat), and the admins' inbox where any admin can read and answer them
// (/chat). The pages ask for new messages every few seconds while open, and
// app notifications reach whoever the message is for. See services/chat.js.
const express = require('express');
const db = require('../db');
const time = require('../time');
const chat = require('../services/chat');
const { notifyAdmins, notifyUsers } = require('../services/notify');
const { notFound, numericIdParam, toId, logActivity } = require('../helpers');
const { requireRecentCode } = require('../auth');
const { chatLogPdf } = require('../services/chatPdf');
const { ROLE_NAMES } = require('../viewHelpers');

const wantsJson = (req) => (req.get('accept') || '').includes('application/json');
const preview = (body) => (body.length > 140 ? `${body.slice(0, 139)}…` : body);

// New messages since `after`, marked as read for whoever's looking.
async function newMessages(req, thread) {
  const after = Math.max(0, Number(req.query.after) || 0);
  const messages = thread ? await chat.messagesIn(thread.id, { after }) : [];
  if (messages.length) await chat.markRead(db, thread.id, req.user.id, messages.at(-1).id);
  return messages.map((m) => chat.present(m, req.user));
}

async function renderThread(req, res, { thread, messages, base, title, intro, otherName }) {
  if (messages.length) await chat.markRead(db, thread.id, req.user.id, messages.at(-1).id);
  res.render('chat/thread', {
    title,
    thread,
    messages: messages.map((m) => chat.present(m, req.user)),
    base,
    intro,
    otherName,
    maxLength: chat.MAX_LENGTH,
    retainYears: chat.RETAIN_YEARS,
  });
}

// Reads and checks a message from the form. Returns the text, or null after answering.
function readBody(req, res, back) {
  const body = chat.cleanBody(req.body.body);
  if (body) return body;
  if (wantsJson(req)) res.status(400).json({ error: 'Write a message first.' });
  else {
    req.flash('error', 'Write a message first.');
    res.redirect(back);
  }
  return null;
}

// ---- Officers and clients ----------------------------------------------------------------

const mine = express.Router();

mine.use((req, res, next) => {
  if (chat.PEOPLE.includes(req.user.role)) return next();
  if (req.user.role === 'admin') return res.redirect('/chat');
  return res.status(403).render('error', { title: 'Not here', message: 'Messages are between officers or clients and the office admins.' });
});

mine.get('/', async (req, res) => {
  const thread = await chat.threadFor(req.user);
  const messages = thread ? await chat.messagesIn(thread.id) : [];
  await renderThread(req, res, {
    thread,
    messages,
    base: '/my/chat',
    title: 'Messages',
    intro: 'A private conversation with the office. Any admin can read it and answer, and you get a notification when they do.',
    otherName: 'the office',
  });
});

mine.get('/messages', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ messages: await newMessages(req, await chat.threadFor(req.user)) });
});

mine.post('/', async (req, res) => {
  const body = readBody(req, res, '/my/chat');
  if (!body) return;
  const thread = await chat.threadFor(req.user, { create: true });
  await chat.send(thread, req.user, body);
  await notifyAdmins({ title: `Message from ${req.user.name}`, body: preview(body), url: `/chat/${thread.id}`, tag: `chat-${thread.id}` });
  if (wantsJson(req)) return res.json({ ok: true });
  res.redirect('/my/chat#latest');
});

// ---- The admins ------------------------------------------------------------------------

const admin = express.Router();
numericIdParam(admin);

admin.get('/', async (req, res) => {
  res.render('chat/inbox', { title: 'Messages', threads: await chat.inbox(req.user.id), people: await chat.people(), retainYears: chat.RETAIN_YEARS });
});

// Starting (or opening) the conversation with an officer or client.
admin.post('/start', async (req, res) => {
  const user = await db.get('SELECT id, name, role FROM users WHERE id = ? AND role = ANY(?::text[])', toId(req.body.user_id) || 0, chat.PEOPLE);
  if (!user) {
    req.flash('error', 'Choose an officer or client to message.');
    return res.redirect('/chat');
  }
  const thread = await chat.threadFor(user, { create: true });
  res.redirect(`/chat/${thread.id}`);
});

async function adminThread(req, res) {
  const thread = await chat.threadById(req.params.id);
  if (!thread) notFound(res, 'conversation');
  return thread;
}

admin.get('/:id', async (req, res) => {
  const thread = await adminThread(req, res);
  if (!thread) return;
  const messages = await chat.messagesIn(thread.id);
  await renderThread(req, res, {
    thread,
    messages,
    base: `/chat/${thread.id}`,
    title: `Messages – ${thread.name}`,
    intro: `A private conversation between ${thread.name} (${thread.person_role}) and the office. Every admin can read and answer it.`,
    otherName: thread.name.split(' ')[0],
  });
});

admin.get('/:id/messages', async (req, res) => {
  const thread = await adminThread(req, res);
  if (!thread) return;
  res.set('Cache-Control', 'no-store');
  res.json({ messages: await newMessages(req, thread) });
});

admin.post('/:id', async (req, res) => {
  const thread = await adminThread(req, res);
  if (!thread) return;
  const body = readBody(req, res, `/chat/${thread.id}`);
  if (!body) return;
  await chat.send(thread, req.user, body);
  await notifyUsers([thread.user_id], { title: 'New message from the office', body: `${req.user.name.split(' ')[0]}: ${preview(body)}`, url: '/my/chat', tag: 'chat' });
  if (wantsJson(req)) return res.json({ ok: true });
  res.redirect(`/chat/${thread.id}#latest`);
});

// The whole conversation as a PDF that can't be edited (anyone can open and
// print it). Behind a fresh code, and recorded with its verification code.
admin.get('/:id/log.pdf', requireRecentCode, async (req, res) => {
  const thread = await adminThread(req, res);
  if (!thread) return;
  const messages = await chat.messagesIn(thread.id);
  const { bytes, code } = await chatLogPdf({
    thread, messages, downloadedBy: req.user.name, companyName: res.locals.settings.company_name,
    roleName: (ROLE_NAMES[thread.person_role] || thread.person_role).toLowerCase(),
  });
  await logActivity(req, `Downloaded the PDF of messages with ${thread.name} (${messages.length} messages, verification code ${code})`);
  res.set('Cache-Control', 'no-store');
  res.attachment(`Messages_${thread.name.replace(/[^A-Za-z0-9]+/g, '_')}_${time.todayStr()}.pdf`);
  res.type('pdf').send(Buffer.from(bytes));
});

module.exports = { mineRouter: mine, adminRouter: admin };
