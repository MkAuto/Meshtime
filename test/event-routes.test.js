import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Event locations and repeating events through the routes, against a throwaway DB (each test file runs in its
// own process, so this one is all ours).
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'meshtime-')), 'app.db');
const { all, get, run, now } = await import('../src/db.js');
const auth = await import('../src/auth.js');
const { routes } = await import('../src/routes.js');
const { addDays, formatDate, today } = await import('../src/lib.js');

const addUser = name => run(`INSERT INTO users(name, password_hash, feed_token, created_at, is_private)
  VALUES (?, 'x', ?, ?, 0)`, name, 'tok-' + name, now()).lastInsertRowid;

/**
 * Runs one route the way server.js would, as member `userId` (null for a feed); returns what it answered. A field
 * given a list is posted once per value, like ticked checkboxes.
 */
async function request(method, path, userId, body = {}) {
  const out = {};
  const url = new URL(path, 'http://x.test');
  const route = routes.find(r => r.method === method && r.path.test(url.pathname));
  await route.handler({
    ip: '127.0.0.1', url, params: url.pathname.match(route.path).groups || {},
    user: userId && auth.userFromSession(auth.createSession(userId)),
    body: new URLSearchParams(Object.entries(body).flatMap(([name, value]) => [value].flat().map(one => [name, one]))),
    html: (html, status = 200) => Object.assign(out, { status, html }),
    text: (text, status = 200) => Object.assign(out, { status, text }),
    json: (json, status = 200) => Object.assign(out, { status, json }),
    redirect: location => Object.assign(out, { status: 303, location }),
    fail: (status, message) => Object.assign(out, { status, message }),
  });
  return out;
}

const ada = addUser('Ada');
const climb = { title: 'Climb', date: '2026-10-05', all_day: '1', location: ' Gym ', repeats: 'weekly', ends: 'on',
  ends_on: '2026-10-19', visibility: 'public' };
const gymLink =
  '<a href="https://www.google.com/maps/search/?api=1&amp;query=Gym" target="_blank" rel="noopener">Gym</a>';

/** This month's list under the calendar, as "date · details — title" for each time shown. */
const listed = async (yearMonth = '2026-10') => [...(await request('GET', `/?m=${yearMonth}`, ada)).html
  .matchAll(/<li class="[^"]*">\s*(.+?) — <b>(.+?)<\/b>/g)].map(([, when, title]) => `${when} — ${title}`);
/** A new event from the event form (`fields` over climb's); its row. */
const addEvent = async fields => {
  await request('POST', '/events', ada, { ...climb, ...fields });
  return get('SELECT * FROM events ORDER BY id DESC LIMIT 1');
};
const changesOf = id => Object.fromEntries(all('SELECT on_date, changes FROM event_changes WHERE event_id = ?', id)
  .map(row => [row.on_date, JSON.parse(row.changes)]));

test('a weekly event with a location: saved, and on the calendar each week until its last date', async () => {
  assert.equal((await request('POST', '/events', ada, climb)).location, '/?m=2026-10');
  const saved = get("SELECT * FROM events WHERE title = 'Climb'");
  assert.deepEqual([saved.location, saved.rrule], ['Gym', 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261019']);

  const { html } = await request('GET', '/?m=2026-10', ada);
  assert.deepEqual(await listed(), ['5 Oct 2026', '12 Oct 2026', '19 Oct 2026']
    .map(date => `${date} · Weekly on Monday, until 19 Oct 2026 · ${gymLink} — Climb`));
  assert.match(html, /title="Climb, 5 Oct 2026 · Weekly on Monday, until 19 Oct 2026 · Gym \(by Ada\)"/,
    'tooltip: as text');
  assert.match(html, new RegExp(`href="/events/${saved.id}\\?on=2026-10-12">edit</a>`), 'each Edit for its time');

  assert.equal((await addEvent({ title: 'Once', repeats: '' })).rrule, null);
  run("DELETE FROM events WHERE title IN ('Climb', 'Once')");
});

test('refused: a repeat that comes back before it ends, or ends before it starts', async () => {
  const long = await request('POST', '/events', ada, { ...climb, end_date: '2026-10-14' });
  assert.equal(long.status, 400);
  assert.match(long.html, /A repeating event must end before it comes back\./);
  const backwards = await request('POST', '/events', ada, { ...climb, ends_on: '2026-10-01' });
  assert.match(backwards.html, /The repeats must end on or after the start date\./);
  const never = await request('POST', '/events', ada, { ...climb, date: '2026-10-06', repeats: 'custom',
    repeat_every: '1', repeat_unit: 'WEEKLY', repeat_days: ['MO'], ends_on: '2026-10-11' });
  assert.match(never.html, /The repeats must end on or after the start date\./, 'no Monday before it ends');
  assert.match(never.html, /<option value="custom" selected>/, 'the form comes back as it was posted');
});

test('Custom: Mondays and Wednesdays from a Tuesday start on the Wednesday; "After 3" ends it', async () => {
  const event = await addEvent({ title: 'Swim', date: '2026-10-06', end_date: '2026-10-06', repeats: 'custom',
    repeat_every: '1', repeat_unit: 'WEEKLY', repeat_days: ['WE', 'MO'], ends: 'after', ends_after: '3' });
  assert.deepEqual([event.date, event.end_date, event.rrule], ['2026-10-07', '2026-10-07',
    'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3']);
  assert.deepEqual((await listed()).filter(line => line.endsWith('Swim')).map(line => line.split(' · ')[0]),
    ['7 Oct 2026', '12 Oct 2026', '14 Oct 2026']);
  assert.match((await listed())[0], /Weekly on Monday, Wednesday, 3 times · /);
  run('DELETE FROM events WHERE id = ?', event.id);
});

test('This event: only what differs from the series is kept; deleting it skips that time', async () => {
  const event = await addEvent({ ends: 'never' });
  const edit = (fields, on = '2026-10-12') => request('POST', `/events/${event.id}`, ada,
    { ...climb, ends: 'never', date: on, scope: 'one', on, ...fields });
  assert.equal((await edit({ title: 'Climb (Tuesday)', date: '2026-10-13' })).location, '/?m=2026-10');
  assert.deepEqual(changesOf(event.id), { '2026-10-12': { title: 'Climb (Tuesday)', date: '2026-10-13',
    end_date: '2026-10-13' } });
  assert.equal(get('SELECT title FROM events WHERE id = ?', event.id).title, 'Climb', 'the series stays');
  assert.deepEqual((await listed()).map(line => line.split(' · ')[0] + ' ' + line.split(' — ')[1]).slice(0, 3),
    ['5 Oct 2026 Climb', '13 Oct 2026 Climb (Tuesday)', '19 Oct 2026 Climb']);
  const page = (await request('GET', `/events/${event.id}?on=2026-10-12`, ada)).html;
  assert.match(page, /value="Climb \(Tuesday\)"/, 'its edit page shows it as it is');
  assert.match(page, /name="date" required value="2026-10-13"/);

  await edit({ date: '2026-10-12' }, '2026-10-12');
  assert.deepEqual(changesOf(event.id), {}, 'the same as the series again: it follows the series again');

  assert.equal((await request('POST', `/events/${event.id}/delete`, ada, { scope: 'one', on: '2026-10-19',
    m: '2026-10' })).status, 303);
  assert.deepEqual(changesOf(event.id), { '2026-10-19': null });
  assert.deepEqual((await listed()).map(line => line.split(' · ')[0]), ['5 Oct 2026', '12 Oct 2026', '26 Oct 2026']);
  run('DELETE FROM events WHERE id = ?', event.id);
});

test('This and following: the series ends before it and a new one starts from it, with what is left', async () => {
  const event = await addEvent({ ends: 'after', ends_after: '6' }); // Mondays, 5 Oct to 9 Nov
  await request('POST', `/events/${event.id}/delete`, ada, { scope: 'one', on: '2026-10-26', m: '2026-10' });
  await request('POST', `/events/${event.id}`, ada, { ...climb, title: 'Bouldering', date: '2026-10-19',
    ends: 'after', ends_after: '6', scope: 'following', on: '2026-10-19' });
  const next = get('SELECT * FROM events ORDER BY id DESC LIMIT 1');
  assert.equal(get('SELECT rrule FROM events WHERE id = ?', event.id).rrule, 'FREQ=WEEKLY;BYDAY=MO;COUNT=2');
  assert.deepEqual([next.title, next.date, next.rrule], ['Bouldering', '2026-10-19', 'FREQ=WEEKLY;BYDAY=MO;COUNT=4']);
  assert.deepEqual([changesOf(event.id), changesOf(next.id)], [{}, { '2026-10-26': null }],
    'the skipped 26th goes with the following ones');
  assert.deepEqual((await listed('2026-11')).map(line => line.split(' · ')[0] + ' ' + line.split(' — ')[1]),
    ['2 Nov 2026 Bouldering', '9 Nov 2026 Bouldering'], '6 times in all');

  await request('POST', `/events/${next.id}/delete`, ada, { scope: 'following', on: '2026-11-02', m: '2026-11' });
  assert.equal(get('SELECT rrule FROM events WHERE id = ?', next.id).rrule, 'FREQ=WEEKLY;BYDAY=MO;COUNT=2');
  assert.deepEqual(changesOf(next.id), { '2026-10-26': null });
  run('DELETE FROM events WHERE id IN (?, ?)', event.id, next.id);
});

test('All events: moved as much as the time shown; changed times stay, unless the date or rule changed', async () => {
  const event = await addEvent({ ends: 'never' });
  await request('POST', `/events/${event.id}/delete`, ada, { scope: 'one', on: '2026-10-26', m: '2026-10' });
  const all = fields => request('POST', `/events/${event.id}`, ada,
    { ...climb, ends: 'never', date: '2026-10-19', scope: 'all', on: '2026-10-19', ...fields });
  await all({ title: 'Climbing', location: 'Bloc Shop' });
  const renamed = get('SELECT * FROM events WHERE id = ?', event.id);
  assert.deepEqual([renamed.title, renamed.location, renamed.date], ['Climbing', 'Bloc Shop', '2026-10-05']);
  assert.deepEqual(changesOf(event.id), { '2026-10-26': null }, 'same date and rule: kept');

  await all({ title: 'Climbing', date: '2026-10-20' }); // the 19th to the 20th: every Monday a Tuesday
  const moved = get('SELECT * FROM events WHERE id = ?', event.id);
  assert.deepEqual([moved.date, moved.rrule], ['2026-10-06', 'FREQ=WEEKLY;BYDAY=TU']);
  assert.deepEqual(changesOf(event.id), {}, 'moved: they might not line up any more');

  assert.equal((await request('POST', `/events/${event.id}/delete`, ada, { scope: 'all', m: '2026-10' })).status, 303);
  assert.equal(get('SELECT id FROM events WHERE id = ?', event.id), undefined);
});

test('a group\'s next event is a repeating one\'s next time; its feed has RRULE, LOCATION, its changes', async () => {
  const group = run(`INSERT INTO member_groups(name, created_by, created_at) VALUES ('Climbers', ?, ?)`, ada, now())
    .lastInsertRowid;
  run('INSERT INTO group_members(group_id, user_id, joined_at) VALUES (?, ?, ?)', group, ada, now());
  const event = await addEvent({ title: 'Board games', date: addDays(today(), -14), ends: 'never',
    visibility: 'private', group_ids: String(group) });

  const { html } = await request('GET', '/groups', ada);
  assert.match(html, new RegExp(`<b>Board games</b> — ${formatDate(today(), 'd-mon-y', 'en')} · Weekly on \\w+ · `
    + '<a href="https://www.google.com/maps/search/\\?api=1&amp;query=Gym" target="_blank" rel="noopener">Gym</a>'),
  'started two weeks ago: next time is today, at its map-linked place');

  await request('POST', `/events/${event.id}/delete`, ada, { scope: 'one', on: addDays(today(), -7), m: '2026-10' });
  await request('POST', `/events/${event.id}`, ada, { ...climb, title: 'Board games', date: today(), all_day: '',
    start_time: '19:00', ends: 'never', visibility: 'private', group_ids: String(group), scope: 'one', on: today() });
  const feed = (await request('GET', `/feed/tok-Ada/groups/${group}.ics`, null)).text;
  const day = date => date.replaceAll('-', '');
  assert.match(feed, new RegExp(`RRULE:FREQ=WEEKLY;BYDAY=\\w\\w\r\nEXDATE;VALUE=DATE:${day(addDays(today(), -7))}\r\n`
    + 'LOCATION:Gym\r\nSUMMARY:Board games'));
  assert.match(feed, new RegExp(`RECURRENCE-ID;VALUE=DATE:${day(today())}\r\nDTSTART:${day(today())}T190000\r\n`),
    'today\'s, at 19:00 instead of all day');
});
