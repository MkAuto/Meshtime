import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Poll deadlines and the count of polls waiting for me, against a throwaway DB (each test file runs in its own
// process, so this one is all ours).
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'meshtime-')), 'app.db');
const { all, get, run, now } = await import('../src/db.js');
const auth = await import('../src/auth.js');
const { routes, pendingPolls } = await import('../src/routes.js');
const { pollsPage, pollPage } = await import('../src/views.js');
const { addDays, today } = await import('../src/lib.js');

const addUser = (name, isAdmin = 0) => run(`INSERT INTO users(name, password_hash, feed_token, created_at, is_private,
  is_admin) VALUES (?, 'x', ?, ?, 0, ?)`, name, 'tok-' + name, now(), isAdmin).lastInsertRowid;

/** Runs one route the way server.js would, as member `userId`; returns what it answered. */
async function request(method, path, userId, body = []) {
  const out = {};
  const url = new URL(path, 'http://x.test');
  const route = routes.find(r => r.method === method && r.path.test(url.pathname));
  await route.handler({
    ip: '127.0.0.1', url, params: url.pathname.match(route.path).groups || {},
    user: auth.userFromSession(auth.createSession(userId)), body: new URLSearchParams(body),
    html: (html, status = 200) => Object.assign(out, { status, html }),
    redirect: location => Object.assign(out, { status: 303, location }),
    fail: (status, message) => Object.assign(out, { status, message }),
  });
  return out;
}

const [ada, bob, cy] = ['Ada', 'Bob', 'Cy'].map(name => addUser(name));
const day = offset => addDays(today(), offset);
const newPoll = (userId, deadline) => request('POST', '/polls/new', userId,
  [['title', 'Climb'], ['dates', day(10)], ['dates', day(11)], ['deadline', deadline], ['visibility', 'public']]);

test('a deadline from today on, or none; a poll past it closes and stops taking answers', async () => {
  const refused = await newPoll(ada, day(-1));
  assert.equal(refused.status, 400);
  assert.match(refused.html, /The deadline must be a date from today on\./);
  assert.match(refused.html, new RegExp(`name="deadline" min="${today()}" value="${day(-1)}"`), 'kept as posted');

  const none = Number((await newPoll(ada, '')).location.split('/').pop());
  assert.equal(get('SELECT deadline FROM polls WHERE id = ?', none).deadline, null);
  const poll = Number((await newPoll(ada, today())).location.split('/').pop());
  assert.equal(get('SELECT deadline FROM polls WHERE id = ?', poll).deadline, today(), 'today: answers until tonight');
  assert.match((await request('GET', `/polls/${poll}`, bob)).html, /Answers until/);

  run('UPDATE polls SET deadline = ? WHERE id = ?', day(-1), poll); // a day later
  const late = await request('POST', `/polls/${poll}`, bob, [[`v_${day(10)}`, 'yes']]);
  assert.equal(late.status, 409);
  assert.ok(get('SELECT closed_at FROM polls WHERE id = ?', poll).closed_at, 'closed');
  assert.equal(get('SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = ?', poll).n, 0);
  assert.equal(get('SELECT closed_at FROM polls WHERE id = ?', none).closed_at, null, 'no deadline: still open');
});

test('only its creator or an admin moves or removes the deadline, of an open poll', async () => {
  const poll = Number((await newPoll(ada, day(5))).location.split('/').pop());
  assert.equal((await request('POST', `/polls/${poll}/deadline`, bob, [['deadline', day(9)]])).status, 403);
  assert.equal((await request('POST', `/polls/${poll}/deadline`, ada, [['deadline', 'soon']])).status, 400);
  assert.equal((await request('POST', `/polls/${poll}/deadline`, ada, [['deadline', day(9)]])).status, 303);
  assert.equal(get('SELECT deadline FROM polls WHERE id = ?', poll).deadline, day(9));
  const admin = addUser('Root', 1);
  await request('POST', `/polls/${poll}/deadline`, admin, [['deadline', '']]);
  assert.equal(get('SELECT deadline FROM polls WHERE id = ?', poll).deadline, null, 'removed');

  await request('POST', `/polls/${poll}/close`, ada);
  assert.equal((await request('POST', `/polls/${poll}/deadline`, ada, [['deadline', day(9)]])).status, 409);
});

test('pendingPolls: open polls I can see with a date I have not answered', async () => {
  run('DELETE FROM polls');
  const poll = Number((await newPoll(ada, day(3))).location.split('/').pop());
  assert.equal(pendingPolls(cy), 1);
  await request('POST', `/polls/${poll}`, cy, [[`v_${day(10)}`, 'yes']]);
  assert.equal(pendingPolls(cy), 1, 'one date left');
  await request('POST', `/polls/${poll}`, cy, [[`v_${day(11)}`, 'no']]);
  assert.equal(pendingPolls(cy), 0, 'all answered');
  assert.equal(pendingPolls(ada), 1, 'its creator owes answers too');

  run('UPDATE polls SET deadline = ? WHERE id = ?', day(-1), poll);
  assert.equal(pendingPolls(ada), 0, 'past its deadline, even before anything closed it');
  run('UPDATE polls SET deadline = NULL, closed_at = ? WHERE id = ?', now(), poll);
  assert.equal(pendingPolls(ada), 0, 'closed');

  run('UPDATE polls SET closed_at = NULL, is_private = 1 WHERE id = ?', poll); // shared with no group of Bob's
  assert.equal(pendingPolls(bob), 0, 'one I cannot see');
});

test('the nav counts them, the list marks them, the poll says until when', () => {
  const user = { id: 1, name: 'Ada', pending_polls: 2 };
  const list = pollsPage(user, [
    { id: 1, title: 'Climb', voters: 1, members: 3, deadline: '2026-10-30', i_owe: 1 },
    { id: 2, title: 'Games', voters: 3, members: 3, i_owe: 0 },
    { id: 3, title: 'Old', closed_at: '2026-09-01', i_owe: 1 },
  ]);
  assert.match(list, /<a href="\/polls">Polls \(2\)<\/a>/);
  assert.match(list, /open until 30 Oct 2026 · 1\/3 answered<\/small>\s*<\/span>\s*<a class="pill" href="\/polls\/1">to answer/);
  assert.equal(list.match(/>to answer</g).length, 1, 'not for one I answered, nor a closed one');
  assert.match(list, /<h2>Closed \(1\)<\/h2>[^]*Old/, 'closed ones apart');
  assert.doesNotMatch(pollsPage({ ...user, pending_polls: 0 }, []), /Polls \(/);

  const page = pollPage(user, { poll: { id: 1, title: 't', created_by: 1, deadline: '2026-10-30' },
    choices: ['2026-11-02'], members: [], votes: [], missing: ['Bob'], complete: false, best: [], event: null });
  assert.match(page, /Waiting for: Bob Answers until 30 Oct 2026\./);
  assert.match(page, /action="\/polls\/1\/deadline"[^]*?name="deadline" min="[\d-]+" value="2026-10-30"/);
});

const newActivityPoll = (userId, fields = []) => request('POST', '/polls/new', userId, [['title', 'Saturday?'],
  ['kind', 'activity'], ['activities', 'Bowling'], ['activities', ' bowling '], ['activities', 'Climb'],
  ['dates', 'ignored'], ['visibility', 'public'], ...fields]);
const idOf = answer => Number(answer.location.split('/').pop());

test('an activity poll: its activities once each, whatever their case; answered like dates', async () => {
  const poll = idOf(await newActivityPoll(ada));
  assert.deepEqual(all('SELECT choice FROM poll_choices WHERE poll_id = ? ORDER BY choice', poll).map(row => row.choice),
    ['Bowling', 'Climb']);
  assert.equal(get('SELECT kind FROM polls WHERE id = ?', poll).kind, 'activity');
  await request('POST', `/polls/${poll}`, bob, [['v_Bowling', 'yes'], ['v_Climb', 'no']]);
  assert.equal(get('SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = ? AND user_id = ?', poll, bob).n, 2);
  assert.equal((await request('POST', '/polls/new', ada, [['title', 'x'], ['kind', 'activity'],
    ['visibility', 'public']])).status, 400, 'at least one activity');
});

test('adding a choice: its creator or an admin, everyone once the poll lets them; not twice, not once closed', async () => {
  const poll = idOf(await newActivityPoll(ada));
  assert.equal((await request('POST', `/polls/${poll}/choices`, bob, [['choice', 'Swim']])).status, 403);
  assert.equal((await request('POST', `/polls/${poll}/choices`, ada, [['choice', 'Swim']])).location,
    `/polls/${poll}?msg=choice_added`);
  run('UPDATE polls SET open_choices = 1 WHERE id = ?', poll);
  await request('POST', `/polls/${poll}/choices`, bob, [['choice', 'swim']]);
  await request('POST', `/polls/${poll}/choices`, bob, [['choice', 'Ski']]);
  assert.deepEqual(all('SELECT choice FROM poll_choices WHERE poll_id = ? ORDER BY choice', poll).map(row => row.choice),
    ['Bowling', 'Climb', 'Ski', 'Swim']);
  assert.equal((await request('POST', `/polls/${poll}/choices`, bob, [['choice', ' ']])).status, 400);

  const dates = idOf(await request('POST', '/polls/new', ada, [['title', 'When'], ['dates', day(3)],
    ['open_choices', '1'], ['visibility', 'public']]));
  assert.equal((await request('POST', `/polls/${dates}/choices`, bob, [['choice', 'soon']])).status, 400);
  await request('POST', `/polls/${dates}/choices`, bob, [['choice', day(4)]]);
  assert.equal(get('SELECT COUNT(*) AS n FROM poll_choices WHERE poll_id = ?', dates).n, 2);
  await request('POST', `/polls/${dates}/close`, ada);
  assert.equal((await request('POST', `/polls/${dates}/choices`, bob, [['choice', day(5)]])).status, 409);
});

test('an activity poll\'s winner gets a date poll: once, after everyone answered, and it closes the first', async () => {
  run('DELETE FROM polls');
  const poll = idOf(await newActivityPoll(ada));
  const plan = (userId, activity) => request('POST', '/polls/new', userId, [['from', String(poll)],
    ['activity', activity], ['title', activity], ['kind', 'activity'], ['dates', day(8)], ['visibility', 'public']]);
  assert.equal((await plan(ada, 'Bowling')).status, 409, 'not everyone answered yet');
  for (const { id: member } of all('SELECT id FROM users')) { // Root, the admin above, too
    await request('POST', `/polls/${poll}`, member, [['v_Bowling', 'yes'], ['v_Climb', 'maybe']]);
  }
  assert.equal((await plan(ada, 'Climb')).status, 409, 'not the winner');
  const confirm = await request('POST', `/polls/${poll}/confirm`, ada, [['date', 'Bowling']]);
  assert.equal(confirm.status, 400, 'an activity is no event');

  const datePoll = idOf(await plan(bob, 'Bowling'));
  assert.deepEqual({ ...get('SELECT kind, title, from_poll_id, created_by FROM polls WHERE id = ?', datePoll) },
    { kind: 'date', title: 'Bowling', from_poll_id: poll, created_by: bob });
  const first = get('SELECT chosen, closed_at FROM polls WHERE id = ?', poll);
  assert.equal(first.chosen, 'Bowling');
  assert.ok(first.closed_at, 'decided, so closed');
  assert.equal((await plan(ada, 'Bowling')).location, `/polls/${datePoll}`, 'a second time: the one made');
  assert.match((await request('GET', `/polls/${poll}`, cy)).html, new RegExp(`href="/polls/${datePoll}"`));
  const prefilled = (await request('GET', `/polls/new?from=${poll}&activity=Bowling`, ada)).html;
  assert.doesNotMatch(prefilled, /name="from"/, 'planned already: a plain new poll');
});
