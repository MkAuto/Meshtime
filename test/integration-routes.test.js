import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The Calendar Integration routes against a throwaway DB (each test file runs in its own process, so this one
// is all ours). A member without a calendar_links row makes syncUser return at once: nothing is fetched.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'meshtime-')), 'app.db');
const { get, run, now } = await import('../src/db.js');
const auth = await import('../src/auth.js');
const { routes } = await import('../src/routes.js');

/** POSTs one form as member `userId`, the way server.js would; returns { status, html, location }. */
async function post(userId, path, body) {
  const out = {};
  const url = new URL(path, 'http://x.test');
  const route = routes.find(r => r.method === 'POST' && r.path.test(url.pathname));
  await route.handler({
    ip: '127.0.0.1', url, params: {}, user: auth.userFromSession(auth.createSession(userId)),
    body: new URLSearchParams(body),
    html: (html, status = 200) => Object.assign(out, { status, html }),
    redirect: location => Object.assign(out, { status: 303, location }),
    fail: (status, html) => Object.assign(out, { status, html }),
  });
  return out;
}

const addUser = name => run(`INSERT INTO users(name, password_hash, feed_token, created_at) VALUES (?, 'x', ?, ?)`,
  name, 'tok-' + name, now()).lastInsertRowid;

test('Rules: saved tidied up, forged slots dropped, an unknown threshold refused without saving anything', async () => {
  const ada = addUser('Ada');
  const rules = () => get('SELECT busy_minutes, busy_slots, ignore_words FROM users WHERE id = ?', ada);
  assert.deepEqual({ ...rules() }, { busy_minutes: 120, busy_slots: '', ignore_words: '' }, 'defaults');

  const saved = await post(ada, '/settings/calendars/rules', [['busy_minutes', '60'], ['ignore_words', ' Gym,, lunch ,'],
    ['busy', '1pm'], ['busy', '1am'], ['busy', '1am'], ['busy', '7am'], ['busy', '1night']]);
  assert.equal(saved.location, '/settings?msg=calendar_rules');
  assert.deepEqual({ ...rules() }, { busy_minutes: 60, busy_slots: '1am 1pm', ignore_words: 'Gym, lunch' });

  // the form (and its error) only shows once a calendar is connected; a refused form returns before any sync
  run(`INSERT INTO calendar_links(user_id, url, created_at) VALUES (?, 'https://x.test/a.ics', ?)`, ada, now());
  const refused = await post(ada, '/settings/calendars/rules', [['busy_minutes', '90'], ['ignore_words', 'x']]);
  assert.equal(refused.status, 400);
  assert.match(refused.html, /Invalid busy threshold\./);
  assert.equal(rules().ignore_words, 'Gym, lunch', 'nothing saved');
});

test('Automatic: the day is no longer set by hand and keeps what it shows until the sync rewrites it', async () => {
  const bob = addUser('Bob');
  const isManual = () => Boolean(get(`SELECT 1 FROM manual_days WHERE user_id = ? AND date = '2026-11-09'`, bob));
  await post(bob, '/free', { date: '2026-11-09', m: '2026-11', g: '', part: 'am' });
  assert.ok(isManual(), 'picked in the menu: set by hand');

  const done = await post(bob, '/free', { date: '2026-11-09', m: '2026-11', g: '', part: 'auto' });
  assert.equal(done.location, '/?m=2026-11&g=');
  assert.ok(!isManual());
  assert.equal(get(`SELECT part FROM free_days WHERE user_id = ? AND date = '2026-11-09'`, bob).part, 'am');
});
