import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollPage } from '../src/views.js';

test('pollPage: you first, then everyone A to Z', () => {
  const members = [
    { id: 1, name: 'Zoé' }, { id: 2, name: 'bob' }, { id: 3, name: 'Keven' }, { id: 4, name: 'Élodie' },
  ];
  const page = pollPage({ id: 3, name: 'Keven' }, { poll: { id: 1, title: 't' }, choices: ['2026-09-29'], members,
    votes: [], missing: [], complete: false, best: [], event: null });
  assert.deepEqual(page.match(/<\/span>[^<]+<\/span><\/th>/g).map(cell => cell.slice(7, -12)),
    ['Keven (you)', 'bob', 'Élodie', 'Zoé']);
  assert.match(page, /<tr class="me">/);
  assert.match(page, /<th class="" scope="col"><small>Tue<\/small>29 Sep 2026<\/th>/);
});

test('pollPage: Who sees it shows to everyone, the form only to its creator or an admin', () => {
  const groups = [{ id: 5, name: 'Climbers', color: 2 }, { id: 6, name: 'Board games', color: 4 }];
  const data = {
    poll: { id: 1, title: 't', created_by: 1, is_private: 1 }, choices: ['2026-09-29'], members: [{ id: 1, name: 'A' }],
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
  assert.doesNotMatch(member, /\/visibility"|group_ids|Manage/, 'no form, no group names for a plain member');
  assert.match(pollPage({ id: 3, name: 'C', is_admin: 1 }, data), /action="\/polls\/1\/visibility"/, 'admins too');
});

test('pollPage: a confirmed poll whose event I may not see shows only its date', () => {
  const data = {
    poll: { id: 1, title: 't', created_by: 1, chosen: '2026-09-29', closed_at: '2026-09-01' },
    choices: ['2026-09-29'], members: [], votes: [], missing: [], complete: true, best: ['2026-09-29'],
  };
  const hidden = pollPage({ id: 2 }, { ...data, event: null });
  assert.match(hidden, /Confirmed for 29 Sep 2026\./);
  assert.doesNotMatch(hidden, /Added to the calendar|\/confirm"/, 'no event title, and nothing left to confirm');
  const shown = pollPage({ id: 2 }, { ...data, event: { title: 'Secret plan', date: '2026-12-24' } });
  assert.match(shown, /Added to the calendar as <b>Secret plan<\/b> on 24 Dec 2026/);
  assert.doesNotMatch(shown, /Confirmed for/);
});

test('pollPage: my unanswered dates start on what my free days say, dashed; a saved answer wins', () => {
  const data = { poll: { id: 1, title: 't' }, choices: ['2026-09-29', '2026-09-30', '2026-10-01'],
    members: [{ id: 3, name: 'Keven' }], votes: [{ choice: '2026-09-30', user_id: 3, answer: 'no' }],
    missing: [], complete: false, best: [], event: null, suggested: { '2026-09-29': 'yes', '2026-09-30': 'yes' } };
  const page = pollPage({ id: 3, name: 'Keven' }, data);
  const picked = date => page.match(new RegExp(`name="v_${date}" value="(\\w+)"[^>]* checked`))?.[1];
  assert.match(page, /The dashed answers come from your free days/);
  assert.match(page, /<span class="vote suggested" role="radiogroup" aria-label="29 Sep 2026">/);
  assert.equal(picked('2026-09-29'), 'yes');
  assert.equal(picked('2026-09-30'), 'no', 'saved: not dashed, not the suggestion');
  assert.match(page, /<span class="vote" role="radiogroup" aria-label="30 Sep 2026">/);
  assert.equal(picked('2026-10-01'), undefined, 'nothing known: unanswered');

  assert.doesNotMatch(pollPage({ id: 3, name: 'Keven' }, { ...data, suggested: { '2026-09-30': 'yes' } }),
    /dashed answers|vote suggested/, 'only a saved date suggested: no hint');
});

test('pollPage: an activity poll shows its activities; its winner plans a date poll, then links to it', () => {
  const data = {
    poll: { id: 4, title: 'Saturday?', kind: 'activity', created_by: 1, open_choices: 1 },
    choices: ['Bowling', 'Climbing & co'], members: [{ id: 2, name: 'Bob' }],
    votes: [{ choice: 'Climbing & co', user_id: 2, answer: 'yes' }], missing: [], complete: true,
    best: ['Climbing & co'], event: null,
  };
  const page = pollPage({ id: 2, name: 'Bob' }, data);
  assert.match(page, /<th class="activity" scope="col">Bowling<\/th>/);
  assert.match(page, /<th class="activity best" scope="col">Climbing &amp; co<\/th>/);
  assert.match(page, /Best activity: Climbing &amp; co/);
  assert.match(page, /href="\/polls\/new\?from=4&amp;activity=Climbing%20%26%20co">Plan dates for Climbing &amp; co</);
  assert.doesNotMatch(page, /\/confirm"/, 'no event from an activity');
  assert.match(page, /action="\/polls\/4\/choices"[^]*?name="choice" required maxlength="60"/, 'open: anyone adds');
  assert.doesNotMatch(page, /Manage/, 'Bob is no manager');

  const planned = pollPage({ id: 2 }, { ...data, poll: { ...data.poll, chosen: 'Climbing & co', closed_at: 'x' },
    datePoll: { id: 9, title: '<i>Climb</i>' } });
  assert.match(planned, /Dates are being picked in <b>&lt;i&gt;Climb&lt;\/i&gt;<\/b>\./);
  assert.match(planned, /href="\/polls\/9"/);
  assert.doesNotMatch(planned, /Plan dates for|\/choices"/, 'done, and closed');
  assert.match(pollPage({ id: 2 }, { ...data, poll: { ...data.poll, chosen: 'Bowling', closed_at: 'x' } }),
    /Picked: Bowling\./, 'its date poll hidden from me: only the winner');
});

// Names and titles are typed by members: they must reach the page as text, never as markup.
test('pollPage escapes what members typed', () => {
  const members = [{ id: 1, name: '<script>alert(1)</script>' }];
  const page = pollPage({ id: 2, name: 'x' }, { poll: { id: 1, title: 'A & "B"' }, choices: ['2026-09-29'], members,
    votes: [], missing: [], complete: false, best: [], event: null });
  assert.doesNotMatch(page, /<script>alert/);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;/);
  assert.match(page, /<h1>A &amp; &quot;B&quot;<\/h1>/);
});
