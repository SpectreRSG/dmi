// Saves login sessions in the database so people stay logged in. (On Netlify
// every page view can be handled by a different server, so sessions can't be
// kept in memory.)
const session = require('express-session');

const DAY_MS = 24 * 60 * 60 * 1000;

function expiryOf(sess) {
  return sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + DAY_MS;
}

// Turns an async function into the callback style express-session expects.
function withCallback(promise, callback) {
  promise.then((result) => callback?.(null, result), (err) => callback?.(err));
}

class PgSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
  }

  get(sid, callback) {
    withCallback(
      this.db.get('SELECT data FROM sessions WHERE sid = ? AND expires_at > ?', sid, Date.now()).then((row) => row?.data ?? null),
      callback
    );
  }

  set(sid, sess, callback) {
    withCallback(
      (async () => {
        await this.db.run(
          `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
           ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
          sid,
          JSON.stringify(sess),
          expiryOf(sess)
        );
        // Now and then, tidy up sessions that have expired.
        if (Math.random() < 0.02) await this.db.run('DELETE FROM sessions WHERE expires_at <= ?', Date.now());
      })(),
      callback
    );
  }

  touch(sid, sess, callback) {
    withCallback(this.db.run('UPDATE sessions SET expires_at = ? WHERE sid = ?', expiryOf(sess), sid), callback);
  }

  destroy(sid, callback) {
    withCallback(this.db.run('DELETE FROM sessions WHERE sid = ?', sid), callback);
  }
}

module.exports = PgSessionStore;
