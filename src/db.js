import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const path = process.env.DB_PATH || './data/app.db';
mkdirSync(dirname(path), { recursive: true });

export const db = new DatabaseSync(path, { timeout: 5000 });
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
  feed_token TEXT NOT NULL UNIQUE, is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invites(
  token TEXT PRIMARY KEY, created_by INTEGER, is_admin INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE IF NOT EXISTS sessions(
  id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS free_days(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, date TEXT NOT NULL, PRIMARY KEY(user_id, date));
CREATE TABLE IF NOT EXISTS polls(
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id),
  chosen_date TEXT, closed_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS poll_dates(
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE, date TEXT NOT NULL, PRIMARY KEY(poll_id, date));
CREATE TABLE IF NOT EXISTS poll_votes(
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE, date TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answer TEXT NOT NULL CHECK(answer IN ('yes','maybe','no')), PRIMARY KEY(poll_id, date, user_id));
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id),
  poll_id INTEGER UNIQUE REFERENCES polls(id) ON DELETE SET NULL, created_at TEXT NOT NULL);
`);

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);
export const now = () => new Date().toISOString();
export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
