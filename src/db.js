import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { COLORS } from './lib.js';

const dbPath = process.env.DB_PATH || './data/app.db';
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath, { timeout: 5000 });

// Schema. CREATE IF NOT EXISTS, so this runs on every start and is a no-op once created.
// All timestamps are ISO strings (see now() below); all dates are 'YYYY-MM-DD'.
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

-- members. feed_token is the credential in the ICS feed URLs; color indexes the .cN palette.
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  feed_token TEXT NOT NULL UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  color INTEGER NOT NULL DEFAULT 0);

-- single-use links. user_id set => password reset for that user, otherwise a new-account invite.
CREATE TABLE IF NOT EXISTS invites(
  token TEXT PRIMARY KEY,
  created_by INTEGER,
  is_admin INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT);

-- login sessions. id_hash is the sha256 of the cookie value, never the value itself.
CREATE TABLE IF NOT EXISTS sessions(
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL);

-- "I am free that day". One row per user per day; its absence means nothing was said.
CREATE TABLE IF NOT EXISTS free_days(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  PRIMARY KEY(user_id, date));

-- date polls. chosen_date is set when the winning date becomes an event.
CREATE TABLE IF NOT EXISTS polls(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  chosen_date TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS poll_dates(
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  PRIMARY KEY(poll_id, date));

CREATE TABLE IF NOT EXISTS poll_votes(
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answer TEXT NOT NULL CHECK(answer IN ('yes','maybe','no')),
  PRIMARY KEY(poll_id, date, user_id));

-- group events. poll_id is UNIQUE, so confirming a poll twice cannot create two events.
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  poll_id INTEGER UNIQUE REFERENCES polls(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL);
`);

// ---- migrations: also run on every start, so each one has to be safe to repeat ----

// DBs created before user colors existed: add the column and hand out random colors.
const userColumns = db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
if (!userColumns.includes('color'))
  db.exec(`ALTER TABLE users ADD COLUMN color INTEGER NOT NULL DEFAULT 0;
           UPDATE users SET color = abs(random()) % ${COLORS}`);

// Pull colors back into range in case the palette shrank.
db.exec(`UPDATE users SET color = color % ${COLORS} WHERE color >= ${COLORS}`);

// ---- query helpers. Always pass values as parameters, never interpolate them into the SQL. ----

/** All matching rows. */
export const all = (sql, ...params) => db.prepare(sql).all(...params);
/** The first matching row, or undefined. */
export const get = (sql, ...params) => db.prepare(sql).get(...params);
/** Writes; returns { changes, lastInsertRowid }. */
export const run = (sql, ...params) => db.prepare(sql).run(...params);

export const now = () => new Date().toISOString();

/** Runs fn in a transaction: commits its return value, rolls back if it throws. */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
