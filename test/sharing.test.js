import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// While groups are on nothing is public: events and polls go to groups, a poll names only who I could see on the
// calendar, and a member's id gives away nobody's name. Against a throwaway DB, this file's process alone.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'meshtime-')), 'app.db');
const { get, run, now, shareWithCreatorGroups } = await import('../src/db.js');
const auth = await import('../src/auth.js');
const { routes } = await import('../src/routes.js');
const { addDays, today } = await import('../src/lib.js');

const addUser = (name, isPrivate = 1) => run(`INSERT INTO users(name, password_hash, feed_token, created_at,
  is_private) VALUES (?, 'x', ?, ?, ?)`, name, 'tok-' + name, now(), isPrivate).lastInsertRowid;

/** A group of `userIds` (the first one made it); returns its id. */
function addGroup(name, ...userIds) {
  const groupId = run('INSERT INTO member_groups(name, created_by, created_at) VALUES (?,?,?)', name, userIds[0], now())
    .lastInsertRowid;
  for (const userId of userIds) {
    run('INSERT INTO group_members(group_id, user_id, joined_at) VALUES (?,?,?)', groupId, userId, now());
  }
  return groupId;
}

/** Runs one route the way server.js would, as member `userId` (null: logged out); returns what it answered. */
async function request(method, path, userId, body = []) {
  const out = {};
  const url = new URL(path, 'http://x.test');
  const route = routes.find(r => r.method === method && r.path.test(url.pathname));
  await route.handler({
    ip: '127.0.0.1', url, params: url.pathname.match(route.path).groups || {}, lang: 'en', cookies: {},
    req: { headers: {} }, setCookie: () => {},
    user: userId ? auth.userFromSession(auth.createSession(userId)) : null, body: new URLSearchParams(body),
    html: (html, status = 200) => Object.assign(out, { status, html }),
    redirect: location => Object.assign(out, { status: 303, location }),
    fail: (status, message) => Object.assign(out, { status, message }),
  });
  return out;
}

const day = offset => addDays(today(), offset);
const pollFields = [['title', 'Climb'], ['dates', day(10)], ['deadline', '']];
const pollId = answer => Number(answer.location.split('/').pop());
const sharedWith = id => get('SELECT group_concat(group_id) AS ids FROM poll_groups WHERE poll_id = ?', id).ids;

// Ana is in both groups; Dee only in Climbers; Eve and Pat only in Games (Pat's account was public: no longer counts).
const [ana, dee, eve] = ['Ana', 'Dee', 'Eve'].map(name => addUser(name));
const pat = addUser('Pat', 0);
const climbers = addGroup('Climbers', ana, dee);
const games = addGroup('Games', ana, eve, pat);

test('a poll shared with two groups names only who I could see on the calendar; the rest is counted', async () => {
  const poll = pollId(await request('POST', '/polls/new', ana,
    [...pollFields, ['group_ids', String(climbers)], ['group_ids', String(games)]]));
  await request('POST', `/polls/${poll}`, eve, [[`v_${day(10)}`, 'yes']]);

  const seenByDee = (await request('GET', `/polls/${poll}`, dee)).html;
  assert.doesNotMatch(seenByDee, /Eve|Pat/, 'the other group: no names, a public account no more than the rest');
  assert.match(seenByDee, /2 others you share no group with: 1 answered everything/);
  assert.match(seenByDee, /<span class="yes">1<\/span>/, 'her answer still counts');
  assert.match(seenByDee, /Waiting for: Ana, Dee and 1 other/);

  const seenByAna = (await request('GET', `/polls/${poll}`, ana)).html;
  assert.match(seenByAna, /Eve/, 'its creator shares a group with everyone it is for');
  assert.doesNotMatch(seenByAna, /class="unseen"/);
});

test('no Public: the groups ticked, a lone group by itself, at least one; in none, no poll', async () => {
  const refused = await request('POST', '/polls/new', ana, pollFields);
  assert.equal(refused.status, 400, 'two groups, none ticked');
  assert.match(refused.html, /Pick at least one group to share this poll with\./);

  const forged = await request('POST', '/polls/new', dee, [...pollFields, ['visibility', 'public']]);
  assert.equal(sharedWith(pollId(forged)), String(climbers), 'one group: shared with it, whatever was posted');
  assert.equal(get('SELECT is_private FROM polls WHERE id = ?', pollId(forged)).is_private, 1);

  const loner = addUser('Lou');
  assert.match((await request('GET', '/polls/new', loner)).html, /join or create a group<\/a> first/);
  const before = get('SELECT COUNT(*) AS n FROM polls').n;
  assert.equal((await request('POST', '/polls/new', loner, pollFields)).status, 403);
  assert.equal(get('SELECT COUNT(*) AS n FROM polls').n, before);

  // an event, though, is only theirs
  const event = await request('POST', '/events', loner, [['title', 'Dentist'], ['date', day(3)], ['all_day', '1'],
    ['ends', 'never']]);
  assert.equal(event.status, 303);
  const saved = get('SELECT id, is_private FROM events WHERE created_by = ?', loner);
  assert.equal(saved.is_private, 1);
  assert.equal(get('SELECT COUNT(*) AS n FROM event_groups WHERE event_id = ?', saved.id).n, 0);
});

test('what was public goes to its creator\'s groups, at start and when groups are turned back on', () => {
  const poll = run(`INSERT INTO polls(title, created_by, created_at, is_private) VALUES ('Old', ?, ?, 0)`, ana, now())
    .lastInsertRowid;
  const event = run(`INSERT INTO events(title, date, end_date, created_by, created_at, is_private)
                     VALUES ('Old', ?, ?, ?, ?, 0)`, day(1), day(1), dee, now()).lastInsertRowid;
  shareWithCreatorGroups();
  assert.equal(get('SELECT is_private FROM polls WHERE id = ?', poll).is_private, 1);
  assert.equal(sharedWith(poll), `${climbers},${games}`);
  assert.equal(get('SELECT group_concat(group_id) AS ids FROM event_groups WHERE event_id = ?', event).ids,
    String(climbers));
});

test('everyone invites from a list of the people they see; any other id is "pick someone", like none at all', async () => {
  const games2 = addGroup('Games 2', dee, pat); // Dee now sees Pat, still not Eve
  const list = (await request('GET', '/groups', dee)).html;
  assert.match(list, /<select name="user_id"/, 'a list, not a name to type');
  assert.match(list, new RegExp(`<option value="${pat}">Pat</option>`));
  assert.doesNotMatch(list, /Eve|name="name" list=/);
  assert.doesNotMatch(list, /formaction="\/groups\/\d+\/add"/, 'adding directly stays for admins');

  const hidden = await request('POST', `/groups/${climbers}/invite`, dee, [['user_id', String(eve)]]);
  const missing = await request('POST', `/groups/${climbers}/invite`, dee, [['user_id', '9999']]);
  assert.equal(hidden.status, 400);
  assert.match(hidden.html, /Pick someone to invite\./);
  assert.doesNotMatch(hidden.html, /Eve/);
  assert.equal(missing.html.match(/<p class="err">[^<]*/)[0], hidden.html.match(/<p class="err">[^<]*/)[0],
    'someone I cannot see and nobody: the same answer');
  assert.equal(get('SELECT COUNT(*) AS n FROM group_invites').n, 0, 'nobody invited');

  const sent = await request('POST', `/groups/${climbers}/invite`, dee, [['user_id', String(pat)]]);
  assert.equal(sent.location, '/groups?msg=invited&to=Pat');
  run('DELETE FROM member_groups WHERE id = ?', games2);
});

test('a group link: one use, 7 days; with an account you log in and join, a new account only while allowed', async () => {
  const linkFor = async (userId, groupId) => {
    await request('POST', `/groups/${groupId}/link`, userId);
    return get('SELECT token FROM invites WHERE group_id = ? ORDER BY rowid DESC LIMIT 1', groupId).token;
  };
  const token = await linkFor(dee, climbers);
  const card = (await request('GET', '/groups', dee)).html;
  assert.match(card, new RegExp(`data-copy="[^"]*/invite/${token}"`), 'listed for Dee, to copy');
  assert.match(card, /Single use · until/);
  assert.match(card, new RegExp(`action="/groups/${climbers}/links/${token}/off"`), 'and to turn off');
  assert.doesNotMatch(card, /name="kind"/, 'Dee does not manage Climbers: single use only');
  assert.equal((await request('POST', `/groups/${climbers}/link`, dee, [['kind', 'always']])).status, 403);

  // logged out, new-account links off and made by a member: only "log in", which comes back here
  const out = await request('GET', `/invite/${token}`, null);
  assert.match(out.html, /Join the group Climbers/);
  assert.doesNotMatch(out.html, /name="password"/);
  assert.match(out.html, new RegExp(`href="/login\\?next=/invite/${token}">Log in</a>`));
  assert.equal((await request('POST', `/invite/${token}`, null, [['name', 'New'], ['password', 'long enough pw']]))
    .status, 403);
  assert.match((await request('GET', `/login?next=/invite/${token}`, null)).html,
    new RegExp(`name="next" value="/invite/${token}"`));
  assert.equal((await request('GET', `/login?next=/invite/${token}`, eve)).location, `/invite/${token}`);
  assert.equal((await request('GET', '/login?next=//evil.test/x', eve)).location, '/', 'nowhere else');

  // logged in: one click, and the link is spent
  assert.match((await request('GET', `/invite/${token}`, eve)).html, /action="\/invite\/[\w-]+\/join"/);
  assert.equal((await request('POST', `/invite/${token}/join`, dee)).location, '/groups?msg=already_member');
  assert.equal((await request('POST', `/invite/${token}/join`, eve)).location, '/groups?msg=joined');
  assert.ok(get('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?', climbers, eve));
  assert.equal((await request('POST', `/invite/${token}/join`, pat)).status, 410, 'once');

  // new-account links on: the form, and the account starts in the group
  run('UPDATE app_settings SET member_invites = 1');
  const second = await linkFor(dee, climbers);
  assert.match((await request('GET', `/invite/${second}`, null)).html, /name="password"/);
  await request('POST', `/invite/${second}`, null, [['name', 'Neo'], ['password', 'long enough pw']]);
  const neo = get('SELECT id FROM users WHERE name = ?', 'Neo').id;
  assert.ok(get('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?', climbers, neo));
  run('UPDATE app_settings SET member_invites = 0');

  // its creator leaves: their links go with them
  const third = await linkFor(eve, climbers);
  await request('POST', `/groups/${climbers}/leave`, eve);
  assert.equal(get('SELECT COUNT(*) AS n FROM invites WHERE token = ?', third).n, 0);
});

test('a group link for anyone: only its owner or an admin makes one; until a date or turned off, never used up', async () => {
  const lastToken = () => get('SELECT token FROM invites WHERE group_id = ? ORDER BY rowid DESC LIMIT 1', games).token;
  assert.equal((await request('POST', `/groups/${games}/link`, ana, [['kind', 'until'], ['until', addDays(today(), -1)]]))
    .status, 400, 'a last day already past');
  await request('POST', `/groups/${games}/link`, ana, [['kind', 'until'], ['until', day(30)]]);
  const until = lastToken();
  assert.ok(get('SELECT expires_at FROM invites WHERE token = ?', until).expires_at > `${day(30)}T`, 'all of that day');
  await request('POST', `/groups/${games}/link`, ana, [['kind', 'always']]);
  const always = lastToken();

  const [kim, lee] = ['Kim', 'Lee'].map(name => addUser(name));
  for (const userId of [kim, lee]) {
    assert.equal((await request('POST', `/invite/${always}/join`, userId)).location, '/groups?msg=joined');
  }
  assert.equal(get('SELECT used_at FROM invites WHERE token = ?', always).used_at, null, 'never used up');

  const card = (await request('GET', '/groups', ana)).html;
  assert.match(card, /Anyone · until turned off/);
  assert.match(card, /Anyone · until /);
  assert.match(card, /name="kind"/, 'its owner picks who the link is for');

  // someone else's link: no Turn off for a plain member, and the route refuses it
  await request('POST', `/groups/${games}/link`, eve);
  const evesOnce = lastToken();
  assert.doesNotMatch((await request('GET', '/groups', eve)).html, new RegExp(`links/${always}/off`),
    'Eve only sees her own links');
  // a single-use link: only whoever made it and admins, not even the group's owner
  assert.doesNotMatch((await request('GET', '/groups', ana)).html, new RegExp(evesOnce));
  assert.equal((await request('POST', `/groups/${games}/links/${evesOnce}/off`, ana)).status, 403);
  const root = addUser('Root');
  run('UPDATE users SET is_admin = 1 WHERE id = ?', root);
  run('INSERT INTO group_members(group_id, user_id, joined_at) VALUES (?,?,?)', games, root, now());
  assert.match((await request('GET', '/groups', root)).html, new RegExp(`links/${evesOnce}/off`), 'an admin sees it');
  assert.equal((await request('POST', `/groups/${games}/links/${always}/off`, eve)).status, 403);
  assert.equal((await request('POST', `/groups/${games}/links/${always}/off`, ana)).location, '/groups?msg=link_off');
  assert.equal((await request('POST', `/invite/${always}/join`, pat)).status, 410, 'off: nobody joins any more');

  run('UPDATE invites SET expires_at = ? WHERE token = ?', new Date(Date.now() - 1000).toISOString(), until);
  assert.equal((await request('GET', `/invite/${until}`, null)).status, 410, 'past its last day');
});
