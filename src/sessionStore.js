// Saves login sessions in the database so people stay logged in even if the
// app restarts. (express-session's built-in store forgets everything on restart.)
const session = require('express-session');

const DAY_MS = 24 * 60 * 60 * 1000;

class SqliteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.getStmt = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires_at > ?');
    this.setStmt = db.prepare(
      `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
    );
    this.touchStmt = db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?');
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.cleanupStmt = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

    // Tidy up expired sessions once an hour.
    this.cleanupStmt.run(Date.now());
    setInterval(() => this.cleanupStmt.run(Date.now()), 60 * 60 * 1000).unref();
  }

  expiryOf(sess) {
    return sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + DAY_MS;
  }

  get(sid, callback) {
    try {
      const row = this.getStmt.get(sid, Date.now());
      callback(null, row ? JSON.parse(row.data) : null);
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), this.expiryOf(sess));
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }

  touch(sid, sess, callback) {
    try {
      this.touchStmt.run(this.expiryOf(sess), sid);
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.destroyStmt.run(sid);
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }
}

module.exports = SqliteSessionStore;
