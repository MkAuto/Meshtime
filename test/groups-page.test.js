import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupsPage } from '../src/views.js';

test('groupsPage: managers get Rename / remove / Delete, only admins get Add directly', () => {
  const group = canManage => ({
    id: 7, name: 'Climbers', creator: 'Ada', canManage, color: 4,
    members: [{ id: 1, name: 'Ada', color: 0 }, { id: 2, name: 'Bob', color: 1 }],
    invited: [{ id: 3, name: 'Cy' }],
    invitable: [{ id: 4, name: 'Di' }],
  });
  const render = (user, canManage) =>
    groupsPage(user, { groups: [group(canManage)], invites: [], base: 'https://x.test' });

  const manager = render({ id: 1, is_admin: 0, feed_token: 'tok' }, true);
  assert.match(manager, /value="https:\/\/x\.test\/feed\/tok\/groups\/7\.ics" readonly/, 'my own feed link');
  assert.match(manager, /data-copy="https:\/\/x\.test\/feed\/tok\/groups\/7\.ics" hidden>Copy/);
  assert.match(manager, /<details class="panel panel-group c4" open data-remember="group-7">/,
    'own color, open, remembered');
  const rejected = groupsPage({ id: 1 }, { groups: [group(true)], invites: [], errors: { 7: 'Nope.' } });
  // app.js never folds a panel showing an error from memory, so the error text is what matters here
  assert.match(rejected, /data-remember="group-7">[\s\S]*<p class="err">Nope\.<\/p>/, 'the error shows in its group');
  assert.match(manager, /action="\/groups\/7\/rename"/);
  assert.match(manager, /action="\/groups\/7\/members\/2\/remove"/, 'the group id, then the member id');
  assert.doesNotMatch(manager, /members\/1\/remove/, 'a manager leaves, they do not remove themselves');
  assert.match(manager, /action="\/groups\/7\/invites\/3\/cancel"/);
  assert.match(manager, /action="\/groups\/7\/delete"/);
  assert.doesNotMatch(manager, /Add directly/);

  const member = render({ id: 2, is_admin: 0 }, false);
  assert.doesNotMatch(member, /rename|remove"|cancel"|\/delete"/);
  assert.match(member, /action="\/groups\/7\/invite"/, 'every member can invite');
  assert.match(member, /action="\/groups\/7\/leave"/);

  assert.match(render({ id: 1, is_admin: 1 }, true), /formaction="\/groups\/7\/add">Add directly/);
});

test('groupsPage: Next event, Last event when none is coming, and a placeholder when there never was one', () => {
  const group = headlineEvent => ({
    id: 7, name: 'Climbers', creator: 'Ada', canManage: false, color: 1,
    members: [], invited: [], invitable: [], headlineEvent,
  });
  const render = headlineEvent => groupsPage({ id: 1 }, { groups: [group(headlineEvent)], invites: [], base: '' });
  const event = { title: 'Crag day', date: '2026-11-14', end_date: '2026-11-14', start_time: null, creator: 'Bob' };

  const next = render(event);
  assert.match(next, /<h3>Next event<\/h3>\s*<p>\s*<b>Crag day<\/b> — /);
  assert.match(next, /by Bob/);
  assert.match(next, /href="\/\?m=2026-11&amp;g=7">see it on the calendar/, "the group's own view, that month");

  assert.match(render({ ...event, isLast: true }), /<h3>Last event<\/h3>\s*<p>\s*<b>Crag day<\/b>/);

  const none = render(undefined);
  assert.match(none, /<h3>Next event<\/h3>\s*<p class="hint">No event yet<\/p>/);
});
