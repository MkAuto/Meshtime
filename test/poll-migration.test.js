import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// A DB from before activity polls, opened by today's src/db.js: its polls, dates and answers come through renamed.
// Its own process (each test file runs in one), so db.js opens this DB and no other.
test('poll_dates, poll_votes.date and polls.chosen_date are renamed, rows kept, and new polls work', async () => {
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'meshtime-')), 'app.db');
  const old = new DatabaseSync(process.env.DB_PATH);
  old.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
      feed_token TEXT NOT NULL UNIQUE, is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE polls(id INTEGER PRIMARY KEY, title TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id),
      chosen_date TEXT, closed_at TEXT, created_at TEXT NOT NULL, is_private INTEGER NOT NULL DEFAULT 0, deadline TEXT);
    CREATE TABLE poll_dates(poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE, date TEXT NOT NULL,
      PRIMARY KEY(poll_id, date));
    CREATE TABLE poll_votes(poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE, date TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      answer TEXT NOT NULL CHECK(answer IN ('yes','maybe','no')), PRIMARY KEY(poll_id, date, user_id));
    INSERT INTO users VALUES (1, 'Ada', 'x', 'tok', 0, '2026-01-01');
    INSERT INTO polls(id, title, created_by, chosen_date, created_at) VALUES (1, 'Climb', 1, '2026-10-02', '2026-01-01');
    INSERT INTO poll_dates VALUES (1, '2026-10-01'), (1, '2026-10-02');
    INSERT INTO poll_votes VALUES (1, '2026-10-02', 1, 'yes');`);
  old.close();

  const { all, get, run } = await import('../src/db.js');
  assert.deepEqual(all('SELECT choice FROM poll_choices ORDER BY choice').map(row => row.choice),
    ['2026-10-01', '2026-10-02']);
  assert.deepEqual({ ...get('SELECT choice, answer FROM poll_votes') }, { choice: '2026-10-02', answer: 'yes' });
  assert.deepEqual({ ...get('SELECT chosen, kind, open_choices, from_poll_id FROM polls') },
    { chosen: '2026-10-02', kind: 'date', open_choices: 0, from_poll_id: null });
  assert.equal(get(`SELECT 1 AS gone FROM sqlite_master WHERE name = 'poll_dates'`), undefined);

  run(`INSERT INTO polls(title, created_by, created_at, from_poll_id) VALUES ('B', 1, 'x', 1)`);
  assert.throws(() => run(`INSERT INTO polls(title, created_by, created_at, from_poll_id) VALUES ('C', 1, 'x', 1)`),
    /UNIQUE/, 'one date poll per activity poll');
});
