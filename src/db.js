import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  COLORS, DEFAULT_WEEK_START, WEEK_START_CHOICES, DATE_FORMATS, DEFAULT_DATE_FORMAT, DAY_PARTS, SLOTS,
} from './lib.js';

const dbPath = process.env.DB_PATH || './data/app.db';
/** Where everything persistent lives: the DB and meshtime.log. A volume in Docker. */
export const DATA_DIR = dirname(dbPath);
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(dbPath, { timeout: 5000 });

// free_days is written from here twice (the CREATE below, and the rebuild when DAY_PARTS changes),
// so its definition lives in one place. DAY_PARTS are constants, safe to inline.
const sqlList = values => values.map(value => `'${value}'`).join(',');
const PART_CHECK = `CHECK(part IN (${sqlList(DAY_PARTS)}))`;
const PART2_CHECK = `CHECK(part2 IN (${sqlList(SLOTS)}))`;
const freeDaysTable = name => `CREATE TABLE IF NOT EXISTS ${name}(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  part TEXT NOT NULL DEFAULT 'all' ${PART_CHECK},
  part2 TEXT ${PART2_CHECK},
  PRIMARY KEY(user_id, date))`;

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
  color INTEGER NOT NULL DEFAULT 0,
  week_start INTEGER NOT NULL DEFAULT 0, -- first day of the week in the calendar grid, 0 = Sunday
  date_format TEXT NOT NULL DEFAULT '${DEFAULT_DATE_FORMAT}', -- a DATE_FORMATS key in src/lib.js
  birthday TEXT, -- 'YYYY-MM-DD', NULL = not given
  show_birthdays INTEGER NOT NULL DEFAULT 1, -- 0 hides everyone's birthdays from this member's calendar
  is_private INTEGER NOT NULL DEFAULT 1, -- 1: only people sharing a group see my free days, 0: everyone does
  -- the group the calendar opens on; NULL = everyone I can see. Ignored while I am not in that group.
  default_group_id INTEGER REFERENCES member_groups(id) ON DELETE SET NULL);

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
-- part: free all day, or only the morning (am) / afternoon (pm) / evening (eve). DAY_PARTS in src/lib.js.
-- part2: a second slot that same day (always after part in DAY_PARTS order), NULL when there is one.
${freeDaysTable('free_days')};

-- groups of members: sharing one is what lets a private member's free days be seen.
-- Not called "groups": GROUPS is an SQL keyword (window frames). created_by goes NULL when that account
-- is removed; admins in the group can still manage it.
CREATE TABLE IF NOT EXISTS member_groups(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  color INTEGER NOT NULL DEFAULT 0); -- a .cN palette index like users.color, picked at random on creation

CREATE TABLE IF NOT EXISTS group_members(
  group_id INTEGER NOT NULL REFERENCES member_groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  PRIMARY KEY(group_id, user_id));

-- pending invitations to join a group: the invited member accepts (becomes a group_members row) or declines.
-- The primary key keeps it to one pending invite per person per group.
CREATE TABLE IF NOT EXISTS group_invites(
  group_id INTEGER NOT NULL REFERENCES member_groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(group_id, user_id));

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
-- date..end_date is inclusive (equal for a one-day event). No start_time means all day. Times are 'HH:MM'.
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  end_date TEXT,
  start_time TEXT,
  end_time TEXT,
  color INTEGER, -- bar color, a .cN palette index like users.color; NULL = the default event look
  created_by INTEGER NOT NULL REFERENCES users(id),
  poll_id INTEGER UNIQUE REFERENCES polls(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  -- 0: public, 1: private
  is_private INTEGER NOT NULL DEFAULT 0);

-- the groups a private event is shared with (none for a public event). Groups its creator is in.
CREATE TABLE IF NOT EXISTS event_groups(
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES member_groups(id) ON DELETE CASCADE,
  PRIMARY KEY(event_id, group_id));

-- passkeys. public_key is SPKI DER (base64url), exactly as the browser's getPublicKey() gave it.
CREATE TABLE IF NOT EXISTS credentials(
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  alg INTEGER NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL);

-- outstanding WebAuthn challenges. Single-use and short-lived, so a captured login cannot be replayed.
CREATE TABLE IF NOT EXISTS challenges(
  challenge TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL);
`);

// ---- migrations: also run on every start, so each one has to be safe to repeat ----

// DBs created before user colors existed: add the column and hand out random colors.
const userColumns = db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
if (!userColumns.includes('color')) {
  db.exec(`ALTER TABLE users ADD COLUMN color INTEGER NOT NULL DEFAULT 0;
           UPDATE users SET color = abs(random()) % ${COLORS}`);
}

// DBs created before the week-start setting existed: everyone gets the Sunday default.
if (!userColumns.includes('week_start')) {
  db.exec('ALTER TABLE users ADD COLUMN week_start INTEGER NOT NULL DEFAULT 0');
}

// DBs created before morning/afternoon existed: every free day already marked was a whole day.
const freeDayColumns = db.prepare('PRAGMA table_info(free_days)').all().map(column => column.name);
if (!freeDayColumns.includes('part')) {
  db.exec(`ALTER TABLE free_days ADD COLUMN part TEXT NOT NULL DEFAULT 'all' ${PART_CHECK}`);
}

// DBs created before a second slot per day existed: nobody has one yet.
if (!freeDayColumns.includes('part2')) {
  db.exec(`ALTER TABLE free_days ADD COLUMN part2 TEXT ${PART2_CHECK}`);
}

// DAY_PARTS changed (evening was added after am/pm): SQLite cannot alter a CHECK, so the table is
// rebuilt with the current one. A part that is no longer offered becomes a whole day, a second one is dropped.
const freeDaysSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'free_days'`).get().sql;
if (!freeDaysSql.includes(PART_CHECK) || !freeDaysSql.includes(PART2_CHECK)) {
  db.exec(`BEGIN;
    DROP TABLE IF EXISTS free_days_new;
    ${freeDaysTable('free_days_new')};
    INSERT INTO free_days_new(user_id, date, part, part2)
      SELECT user_id, date,
        CASE WHEN part IN (${sqlList(DAY_PARTS)}) THEN part ELSE 'all' END,
        CASE WHEN part IN (${sqlList(SLOTS)}) AND part2 IN (${sqlList(SLOTS)}) THEN part2 END
      FROM free_days;
    DROP TABLE free_days;
    ALTER TABLE free_days_new RENAME TO free_days;
    COMMIT;`);
}

// DBs created before the date-format setting existed: everyone gets the default.
if (!userColumns.includes('date_format')) {
  db.exec(`ALTER TABLE users ADD COLUMN date_format TEXT NOT NULL DEFAULT '${DEFAULT_DATE_FORMAT}'`);
}

// DBs created before the profile page existed: nobody has given a birthday yet.
if (!userColumns.includes('birthday')) {
  db.exec('ALTER TABLE users ADD COLUMN birthday TEXT');
}
if (!userColumns.includes('show_birthdays')) {
  db.exec('ALTER TABLE users ADD COLUMN show_birthdays INTEGER NOT NULL DEFAULT 1');
}

// DBs created before groups existed: everyone starts private, so free days are only shared through groups.
if (!userColumns.includes('is_private')) {
  db.exec('ALTER TABLE users ADD COLUMN is_private INTEGER NOT NULL DEFAULT 1');
}
// DBs created before the calendar's default group existed: everyone opens on "everyone I can see".
if (!userColumns.includes('default_group_id')) {
  db.exec('ALTER TABLE users ADD COLUMN default_group_id INTEGER REFERENCES member_groups(id) ON DELETE SET NULL');
}

// DBs created before times and multi-day events existed: every event was one whole day.
const eventColumns = db.prepare('PRAGMA table_info(events)').all().map(column => column.name);
for (const column of ['end_date', 'start_time', 'end_time']) {
  if (!eventColumns.includes(column)) {
    db.exec(`ALTER TABLE events ADD COLUMN ${column} TEXT`);
  }
}
db.exec('UPDATE events SET end_date = date WHERE end_date IS NULL');

// DBs created before event colors existed: every event keeps the default look.
if (!eventColumns.includes('color')) {
  db.exec('ALTER TABLE events ADD COLUMN color INTEGER');
}

// DBs created before private events existed: every event stays public.
if (!eventColumns.includes('is_private')) {
  db.exec('ALTER TABLE events ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0');
}

// A format that is no longer offered goes back to the default.
db.prepare(`UPDATE users SET date_format = ? WHERE date_format NOT IN (${Object.keys(DATE_FORMATS).map(() => '?')})`)
  .run(DEFAULT_DATE_FORMAT, ...Object.keys(DATE_FORMATS));

// Members who picked a first day that is no longer offered go back to the Sunday default.
db.exec(`UPDATE users SET week_start = ${DEFAULT_WEEK_START} WHERE week_start NOT IN (${WEEK_START_CHOICES})`);

// DBs created before group colors existed: hand out random ones, as for users.
const groupColumns = db.prepare('PRAGMA table_info(member_groups)').all().map(column => column.name);
if (!groupColumns.includes('color')) {
  db.exec(`ALTER TABLE member_groups ADD COLUMN color INTEGER NOT NULL DEFAULT 0;
           UPDATE member_groups SET color = abs(random()) % ${COLORS}`);
}

// Group rules the routes keep (afterLeavingGroup in src/routes.js), applied to data from before they existed:
// a private event is only shared with groups its creator is in; a group is owned by one of its members
// (the longest-standing one takes over); a group nobody is in is gone.
db.exec(`DELETE FROM event_groups WHERE NOT EXISTS (
           SELECT 1 FROM events e JOIN group_members m ON m.user_id = e.created_by
           WHERE e.id = event_groups.event_id AND m.group_id = event_groups.group_id)`);
db.exec(`UPDATE member_groups SET created_by = (
           SELECT user_id FROM group_members WHERE group_id = member_groups.id ORDER BY joined_at, user_id LIMIT 1)
         WHERE created_by IS NULL
            OR created_by NOT IN (SELECT user_id FROM group_members WHERE group_id = member_groups.id)`);
db.exec('DELETE FROM member_groups WHERE id NOT IN (SELECT group_id FROM group_members)');

// Pull colors back into range in case the palette shrank.
db.exec(`UPDATE users SET color = color % ${COLORS} WHERE color >= ${COLORS}`);
db.exec(`UPDATE member_groups SET color = color % ${COLORS} WHERE color >= ${COLORS}`);
db.exec(`UPDATE events SET color = NULL WHERE color >= ${COLORS}`);

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
