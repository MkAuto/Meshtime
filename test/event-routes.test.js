import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Event locations and repeating events through the routes, against a throwaway DB (each test file runs in its
// own process, so this one is all ours).
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'meshtime-')), 'app.db');
const { get, run, now } = await import('../src/db.js');
const auth = await import('../src/auth.js');
const { routes } = await import('../src/routes.js');
const { addDays, formatDate, today } = await import('../src/lib.js');

const addUser = name => run(`INSERT INTO users(name, password_hash, feed_token, created_at, is_private)
  VALUES (?, 'x', ?, ?, 0)`, name, 'tok-' + name, now()).lastInsertRowid;

/** Runs one route the way server.js would, as member `userId` (null for a feed); returns what it answered. */
async function request(method, path, userId, body = {}) {
  const out = {};
  const url = new URL(path, 'http://x.test');
  const route = routes.find(r => r.method === method && r.path.test(url.pathname));
  await route.handler({
    ip: '127.0.0.1', url, params: url.pathname.match(route.path).groups || {},
    user: userId && auth.userFromSession(auth.createSession(userId)), body: new URLSearchParams(body),
    html: (html, status = 200) => Object.assign(out, { status, html }),
    text: (text, status = 200) => Object.assign(out, { status, text }),
    json: (json, status = 200) => Object.assign(out, { status, json }),
    redirect: location => Object.assign(out, { status: 303, location }),
    fail: (status, message) => Object.assign(out, { status, message }),
  });
  return out;
}

const ada = addUser('Ada');
const climb = { title: 'Climb', date: '2026-10-05', all_day: '1', location: ' Gym ', repeats: 'weekly',
  repeat_until: '2026-10-19', visibility: 'public' };

test('a weekly event with a location: saved, and on the calendar each week until its last date', async () => {
  assert.equal((await request('POST', '/events', ada, climb)).location, '/?m=2026-10');
  const saved = get("SELECT * FROM events WHERE title = 'Climb'");
  assert.deepEqual([saved.location, saved.repeats, saved.repeat_until], ['Gym', 'weekly', '2026-10-19']);

  const { html } = await request('GET', '/?m=2026-10', ada);
  const listed = [...html.matchAll(/<li class="[^"]*">\s*(.+?) — <b>Climb<\/b>/g)].map(match => match[1]);
  const gym = '<a href="https://www.google.com/maps/search/?api=1&amp;query=Gym" target="_blank" rel="noopener">Gym</a>';
  assert.deepEqual(listed, ['5 Oct 2026', '12 Oct 2026', '19 Oct 2026']
    .map(date => `${date} · Every week until 19 Oct 2026 · ${gym}`));
  assert.match(html, /title="Climb, 5 Oct 2026 · Every week until 19 Oct 2026 · Gym \(by Ada\)"/, 'tooltip: as text');

  await request('POST', '/events', ada, { ...climb, title: 'Once', repeats: '' });
  assert.equal(get("SELECT repeat_until FROM events WHERE title = 'Once'").repeat_until, null,
    'the hidden until is dropped when it does not repeat');
});

test('refused: a repeat that comes back before it ends, or ends before it starts', async () => {
  const long = await request('POST', '/events', ada, { ...climb, end_date: '2026-10-14' });
  assert.equal(long.status, 400);
  assert.match(long.html, /A repeating event must end before it comes back\./);
  const backwards = await request('POST', '/events', ada, { ...climb, repeat_until: '2026-10-01' });
  assert.match(backwards.html, /The repeats must end on or after the start date\./);
});

test('a group\'s next event is a repeating one\'s next time; its feed gets RRULE and LOCATION', async () => {
  const group = run(`INSERT INTO member_groups(name, created_by, created_at) VALUES ('Climbers', ?, ?)`, ada, now())
    .lastInsertRowid;
  run('INSERT INTO group_members(group_id, user_id, joined_at) VALUES (?, ?, ?)', group, ada, now());
  await request('POST', '/events', ada, { ...climb, title: 'Board games', date: addDays(today(), -14),
    repeat_until: '', visibility: 'private', group_ids: String(group) });

  const { html } = await request('GET', '/groups', ada);
  assert.match(html, new RegExp(`<b>Board games</b> — ${formatDate(today(), 'd-mon-y', 'en')} · Every week · `
    + '<a href="https://www.google.com/maps/search/\\?api=1&amp;query=Gym" target="_blank" rel="noopener">Gym</a>'),
  'started two weeks ago: next time is today, at its map-linked place');

  const feed = (await request('GET', `/feed/tok-Ada/groups/${group}.ics`, null)).text;
  assert.match(feed, /RRULE:FREQ=WEEKLY\r\nLOCATION:Gym\r\nSUMMARY:Board games/);
});
