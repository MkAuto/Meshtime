import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CHOICES } from '../src/lib.js';
import { newPollPage } from '../src/views.js';

// The no-JS fallback and the hooks public/app.js and style.css key off of.
test('newPollPage renders 6 rows of dates and of activities, dates picked', () => {
  const groups = [{ id: 5, name: 'Climbers', color: 2 }, { id: 6, name: 'Board games', color: 4 }];
  const page = newPollPage({ name: 'a', id: 1 }, { groups });
  assert.equal(page.match(/<input type="date" name="dates" min="\d{4}-\d\d-\d\d" value="">/g).length, 6, 'no past dates');
  assert.equal(page.match(/<input name="activities" maxlength="60"/g).length, 6);
  assert.match(page, new RegExp(`<fieldset class="choices dates" data-max="${MAX_CHOICES}">`));
  assert.match(page, /name="kind" value="date" checked>/);
  assert.match(page, /name="open_choices" value="1">/, 'only its creator adds choices by default');
  assert.match(page, /name="group_ids" value="5">/, 'in two groups: both offered, none ticked');
  assert.match(page, /name="group_ids" value="6">/);
  const rejected = newPollPage({ id: 1 }, {
    kind: 'activity', choices: ['Bowling'], openChoices: 1,
    groups, sharing: { groupIds: [5] },
    errors: { visibility: 'Oops.' },
  });
  assert.match(rejected, /name="kind" value="activity" checked>/, 'a rejected form keeps what was posted');
  assert.match(rejected, /name="activities" maxlength="60" placeholder="Bowling" value="Bowling">/);
  assert.equal(rejected.match(/name="activities"/g).length, 6, 'and fills up to six rows');
  assert.match(rejected, /name="open_choices" value="1" checked>/);
  assert.match(rejected, /name="group_ids" value="5" checked>/);
  assert.match(rejected, /name="group_ids" value="6">/);
  assert.match(rejected, /<p class="err">Oops\.<\/p>/);
});

test('newPollPage planned from an activity poll: dates only, the activity carried along', () => {
  const page = newPollPage({ id: 1 }, { title: 'Bowling', from: { id: 4, title: 'Saturday?', activity: 'Bowling' },
    groups: [{ id: 5, name: 'Climbers', color: 2 }] });
  assert.match(page, /Pick dates for Bowling, the winner of “Saturday\?”\./);
  assert.match(page, /name="from" value="4">\s*<input type="hidden" name="activity" value="Bowling">/);
  assert.doesNotMatch(page, /name="kind"/);
  assert.match(page, /name="title" [^>]*value="Bowling"/);
});

test('newPollPage: in one group it is ticked; in none, a pointer to Groups instead of the form', () => {
  assert.match(newPollPage({ id: 1 }, { groups: [{ id: 5, name: 'Climbers', color: 2 }] }),
    /name="group_ids" value="5" checked>/);
  const none = newPollPage({ id: 1 }, { groups: [] });
  assert.doesNotMatch(none, /<form method="post" action="\/polls\/new"/);
  assert.match(none, /<a href="\/groups">join or create a group<\/a> first/);
  assert.match(newPollPage({ id: 1, groups_enabled: 0 }, { groups: [] }), /action="\/polls\/new"/, 'groups off: the form');
});
