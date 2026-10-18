// Opens the database file and makes sure all the tables exist.
// Other files use it like: const db = require('./db');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL'); // faster, and safe if the app crashes mid-save
db.pragma('foreign_keys = ON'); // stop records pointing at things that don't exist

db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

module.exports = db;
