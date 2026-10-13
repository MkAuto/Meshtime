import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollPage } from '../src/views.js';

test('pollPage: you first, then everyone A to Z', () => {
  const members = [
    { id: 1, name: 'Zoé' }, { id: 2, name: 'bob' }, { id: 3, name: 'Keven' }, { id: 4, name: 'Élodie' },
  ];
  const page = pollPage({ id: 3, name: 'Keven' }, { poll: { id: 1, title: 't' }, dates: ['2026-09-29'], members,
    votes: [], missing: [], complete: false, best: [], event: null });
  assert.deepEqual(page.match(/<tr><td>[^<]+/g).map(cell => cell.slice(8)), ['Keven (you)', 'bob', 'Élodie', 'Zoé']);
  assert.match(page, /<th class="">29 Sept\. 2026<\/th>/);
});

test('pollPage: Who sees it shows to everyone, the form only to its creator or an admin', () => {
  const groups = [{ id: 5, name: 'Climbers', color: 2 }, { id: 6, name: 'Board games', color: 4 }];
  const data = {
    poll: { id: 1, title: 't', created_by: 1, is_private: 1 }, dates: ['2026-09-29'], members: [{ id: 1, name: 'A' }],
    votes: [], missing: [], complete: false, best: [], event: null, groupIds: [6], creatorGroups: groups,
  };
  const creator = pollPage({ id: 1, name: 'A' }, data);
  assert.match(creator, /Who sees it: Private: only the groups it is shared with/);
  assert.match(creator, /action="\/polls\/1\/visibility"/);
  assert.match(creator, /value="private" id="visibility-private" checked>/);
  assert.match(creator, /name="group_ids" value="5">/);
  assert.match(creator, /name="group_ids" value="6" checked>/);

  const member = pollPage({ id: 2, name: 'B' }, data);
  assert.match(member, /Who sees it: Private/);
  assert.doesNotMatch(member, /\/visibility"|group_ids/, 'no form, no group names for a plain member');
  assert.match(pollPage({ id: 3, name: 'C', is_admin: 1 }, data), /action="\/polls\/1\/visibility"/, 'admins too');
});

test('pollPage: a confirmed poll whose event I may not see shows only its date', () => {
  const data = {
    poll: { id: 1, title: 't', created_by: 1, chosen_date: '2026-09-29', closed_at: '2026-09-01' },
    dates: ['2026-09-29'], members: [], votes: [], missing: [], complete: true, best: ['2026-09-29'],
  };
  const hidden = pollPage({ id: 2 }, { ...data, event: null });
  assert.match(hidden, /Confirmed for 29 Sept\. 2026\./);
  assert.doesNotMatch(hidden, /Added to the calendar|\/confirm"/, 'no event title, and nothing left to confirm');
  const shown = pollPage({ id: 2 }, { ...data, event: { title: 'Secret plan', date: '2026-12-24' } });
  assert.match(shown, /Added to the calendar as <b>Secret plan<\/b> on 24 Dec\. 2026/);
  assert.doesNotMatch(shown, /Confirmed for/);
});

// Names and titles are typed by members: they must reach the page as text, never as markup.
test('pollPage escapes what members typed', () => {
  const members = [{ id: 1, name: '<script>alert(1)</script>' }];
  const page = pollPage({ id: 2, name: 'x' }, { poll: { id: 1, title: 'A & "B"' }, dates: ['2026-09-29'], members,
    votes: [], missing: [], complete: false, best: [], event: null });
  assert.doesNotMatch(page, /<script>alert/);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;/);
  assert.match(page, /<h1>A &amp; &quot;B&quot;<\/h1>/);
});
