import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The Calendar Integration routes against a throwaway DB (each test file runs in its own process, so this one
// is all ours). A member without a calendar_links row makes syncUser return at once: nothing is fetched.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'meshtime-')), 'app.db');
const { all, get, run, now } = await import('../src/db.js');
const { addDays, today } = await import('../src/lib.js');
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
  const rules = () => get('SELECT busy_minutes, busy_slots, ignore_words, sync_days FROM users WHERE id = ?', ada);
  assert.deepEqual({ ...rules() }, { busy_minutes: 120, busy_slots: '', ignore_words: '', sync_days: 30 }, 'defaults');

  const saved = await post(ada, '/settings/calendars/rules', [['busy_minutes', '60'], ['ignore_words', ' Gym,, lunch ,'],
    ['busy', '1pm'], ['busy', '1am'], ['busy', '1am'], ['busy', '7am'], ['busy', '1night'], ['sync_days', '14']]);
  assert.equal(saved.location, '/settings?msg=calendar_rules');
  assert.deepEqual({ ...rules() }, { busy_minutes: 60, busy_slots: '1am 1pm', ignore_words: 'Gym, lunch', sync_days: 14 });

  // the form (and its error) only shows once a calendar is connected; a refused form returns before any sync
  run(`INSERT INTO calendar_links(user_id, url, created_at) VALUES (?, 'https://x.test/a.ics', ?)`, ada, now());
  const refused = await post(ada, '/settings/calendars/rules', [['busy_minutes', '90'], ['ignore_words', 'x']]);
  assert.equal(refused.status, 400);
  assert.match(refused.html, /Invalid busy threshold\./);
  const badDays = await post(ada, '/settings/calendars/rules', [['busy_minutes', '60'], ['sync_days', '90']]);
  assert.equal(badDays.status, 400);
  assert.match(badDays.html, /Invalid number of days to fill\./);
  assert.deepEqual([rules().ignore_words, rules().sync_days], ['Gym, lunch', 14], 'nothing saved');
});

test('Fill ahead: the sync fills sync_days days from today, and lets go of the days past them', async () => {
  const fay = addUser('Fay');
  run(`INSERT INTO calendar_links(user_id, url, created_at) VALUES (?, 'https://x.test/fay.ics', ?)`, fay, now());
  const day = offset => addDays(today(), offset);
  // filled by an earlier, longer sync; and one set by hand
  run(`INSERT INTO free_days(user_id, date, part) VALUES (?, ?, 'am'), (?, ?, 'pm')`, fay, day(20), fay, day(25));
  run('INSERT INTO manual_days(user_id, date) VALUES (?, ?)', fay, day(25));

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n');
  try {
    await post(fay, '/settings/calendars/rules', [['busy_minutes', '120'], ['sync_days', '7']]);
  } finally {
    globalThis.fetch = realFetch;
  }
  const parts = all('SELECT date, part FROM free_days WHERE user_id = ? ORDER BY date', fay);
  assert.deepEqual(parts.map(row => [row.date, row.part]), [
    ...[0, 1, 2, 3, 4, 5, 6].map(offset => [day(offset), 'all']), // no event: free all day, today included
    [day(25), 'pm'], // set by hand: kept
  ], 'day 7 on not filled, day 20 cleared');
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

test('Birthdays feed: my own and my groups\' members\' only, everyone\'s while groups are off', async () => {
  const [cy, dee, eve] = ['Cy', 'Dee', 'Eve'].map(addUser);
  run(`UPDATE users SET birthday = '1990-05-17', is_private = 0 WHERE id IN (?, ?, ?)`, cy, dee, eve);
  const group = run(`INSERT INTO member_groups(name, created_at) VALUES ('Friends', ?)`, now()).lastInsertRowid;
  for (const member of [cy, dee]) {
    run('INSERT INTO group_members(group_id, user_id, joined_at) VALUES (?, ?, ?)', group, member, now());
  }
  const feed = async token => {
    const url = new URL(`http://x.test/feed/${token}/birthdays.ics`);
    const route = routes.find(r => r.method === 'GET' && r.path.test(url.pathname));
    let text = '';
    await route.handler({ url, params: url.pathname.match(route.path).groups, text: body => { text = body; } });
    return text;
  };

  assert.match(await feed('tok-Cy'), /Dee's birthday/, 'in my group');
  assert.doesNotMatch(await feed('tok-Cy'), /Eve's birthday/, 'public but in none of my groups');
  assert.match(await feed('tok-Eve'), /Eve's birthday/, 'my own, with no group');
  assert.doesNotMatch(await feed('tok-Eve'), /Cy's birthday/);

  run('UPDATE app_settings SET groups_enabled = 0');
  assert.match(await feed('tok-Cy'), /Eve's birthday/, 'groups off: everyone');
  run('UPDATE app_settings SET groups_enabled = 1');
});
