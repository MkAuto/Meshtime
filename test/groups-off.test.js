import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profilePage, newPollPage, adminPage, settingsPage } from '../src/views.js';

// Administration → Options → Groups: off, pages show no groups and no public / private choice.
const user = groupsEnabled => ({ id: 1, name: 'Ada', color: 2, is_admin: 1, groups_enabled: groupsEnabled });

test('groups off: no Groups link, no Account choice, no Who sees it', () => {
  const groups = [{ id: 7, name: 'Climbers', color: 4 }];
  const on = profilePage(user(1), { passkeys: [] }) + newPollPage(user(1), { groups });
  const off = profilePage(user(0), { passkeys: [] }) + newPollPage(user(0), { groups });

  assert.match(on, /href="\/groups">Groups/);
  assert.match(on, /name="privacy"/);
  assert.match(on, /name="visibility"/);
  assert.doesNotMatch(off, /href="\/groups"/);
  assert.doesNotMatch(off, /name="privacy"/);
  assert.doesNotMatch(off, /name="visibility"|Who sees it/);
});

test('groups off: the admin Groups checkbox shows the saved state', () => {
  const admin = groupsEnabled => adminPage(user(groupsEnabled), { base: '', invites: [], members: [], log: [] });
  assert.match(admin(1), /name="groups_enabled" value="1" checked\s/);
  assert.match(admin(0), /name="groups_enabled" value="1"\s+data-confirm-on/);
});

test('groups off: Settings offers the All events feed instead of group feeds', () => {
  const settings = groupsEnabled => settingsPage({ ...user(groupsEnabled), feed_token: 'tok' },
    { base: 'https://x.test', groups: [{ id: 7, name: 'Climbers' }] });
  assert.match(settings(1), /feed\/tok\/groups\/7\.ics/);
  assert.doesNotMatch(settings(1), /events\.ics/);
  assert.match(settings(0), /value="https:\/\/x\.test\/feed\/tok\/events\.ics" readonly/);
  assert.doesNotMatch(settings(0), /groups\/7\.ics/);
});

test('the Groups checkbox carries both confirm messages for app.js', () => {
  const admin = adminPage(user(1), { base: '', invites: [], members: [], log: [] });
  assert.match(admin, /name="groups_enabled"[^>]*data-confirm-on="Turn groups on\?[^"]*"\s+data-confirm-off="/);
  assert.doesNotMatch(admin, /<form[^>]*action="\/admin\/options"[^>]*data-confirm/, 'saving the rest never asks');
});
