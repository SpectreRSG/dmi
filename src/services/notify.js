// App notifications: free "push" messages that pop up on someone's phone or
// computer like a text, even when the site isn't open. They work once a person
// presses "Turn on notifications" on that device (on an iPhone, after adding
// the site to the Home Screen). No phone numbers, no texting company, no cost.
//
// How it works: the browser gives us an address for that device, and we send
// a scrambled message to it, signed with the site's own key pair ("VAPID"
// keys, made once and kept in the database like the other secrets).
const webpush = require('web-push');
const db = require('../db');
const { storedSecret } = require('../secrets');

// Who the push services can contact about our messages (they require one).
const CONTACT = process.env.URL || 'https://dmi.codehound.org';

let keys = null;
async function vapidKeys() {
  keys ??= JSON.parse(await storedSecret('vapid_keys', () => JSON.stringify(webpush.generateVAPIDKeys())));
  return keys;
}

async function publicKey() {
  return (await vapidKeys()).publicKey;
}

// Sends one message to one device. Tests swap this for a fake (see setSender).
async function webPushSender(subscription, payload) {
  const { publicKey: pub, privateKey } = await vapidKeys();
  await webpush.sendNotification(subscription, payload, {
    TTL: 6 * 60 * 60, // if the phone is off, keep trying for 6 hours
    urgency: 'high',
    vapidDetails: { subject: CONTACT, publicKey: pub, privateKey },
  });
}
let sender = webPushSender;
function setSender(fn) {
  sender = fn || webPushSender;
}

// Saves (or refreshes) a device for an account.
async function saveSubscription(userId, { endpoint, p256dh, auth, device }) {
  await db.run(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, device = EXCLUDED.device`,
    userId, endpoint, p256dh, auth, device || null
  );
}

async function removeSubscription(userId, endpoint) {
  await db.run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', userId, endpoint);
}

// Sends a message to every device of these accounts (a list of ids, or a
// database query that finds them). `message` = { title, body, url (the page
// to open when tapped), tag (a newer message with the same tag replaces the
// older one) }. Returns how many devices got it. Never throws: a notification
// failing must not stop what the person was doing.
async function notifyUsers(userIds, message) {
  try {
    return await sendToUsers(userIds, message);
  } catch (err) {
    console.error('Notifications failed:', err);
    return 0;
  }
}

async function sendToUsers(who, message) {
  // `who` is a list of account ids, or a database query that finds them.
  const userIds = Array.isArray(who) ? who : (await who).map((u) => u.id);
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return 0;
  const subscriptions = await db.all('SELECT * FROM push_subscriptions WHERE user_id = ANY(?::int[])', ids);
  const payload = JSON.stringify({ title: message.title, body: message.body, url: message.url || '/', tag: message.tag });
  const results = await Promise.allSettled(
    subscriptions.map(async (s) => {
      try {
        await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        await db.run('UPDATE push_subscriptions SET last_sent_at = app_now() WHERE id = ?', s.id);
      } catch (err) {
        // 404/410: the device turned notifications off or the app was removed.
        if (err.statusCode === 404 || err.statusCode === 410) await db.run('DELETE FROM push_subscriptions WHERE id = ?', s.id);
        else console.error('Notification failed:', err.statusCode || '', err.body || err.message);
        throw err;
      }
    })
  );
  return results.filter((r) => r.status === 'fulfilled').length;
}

// The accounts of these staff members (officers who can sign in).
async function notifyEmployees(employeeIds, message) {
  const ids = [...new Set(employeeIds.filter(Boolean))];
  if (!ids.length) return 0;
  return notifyUsers(
    db.all("SELECT id FROM users WHERE employee_id = ANY(?::int[]) AND active = 1 AND role = 'officer'", ids),
    message
  );
}

// Everyone in the office (admins and managers).
async function notifyOffice(message) {
  return notifyUsers(db.all("SELECT id FROM users WHERE role IN ('admin', 'manager') AND active = 1"), message);
}

// Just the admins (e.g. incident reports, which managers don't see).
async function notifyAdmins(message) {
  return notifyUsers(db.all("SELECT id FROM users WHERE role = 'admin' AND active = 1"), message);
}

// Everyone with an account for this client (their site representatives).
async function notifyClient(clientId, message) {
  return notifyUsers(db.all("SELECT id FROM users WHERE role = 'client' AND client_id = ? AND active = 1", clientId), message);
}

module.exports = { publicKey, setSender, saveSubscription, removeSubscription, notifyUsers, notifyEmployees, notifyOffice, notifyAdmins, notifyClient };
