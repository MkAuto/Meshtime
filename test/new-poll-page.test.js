import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CHOICES } from '../src/lib.js';
import { newPollPage } from '../src/views.js';

// The no-JS fallback and the hooks public/app.js and style.css key off of.
test('newPollPage renders 6 rows of dates and of activities, dates picked', () => {
  const page = newPollPage({ name: 'a', id: 1 });
  assert.equal(page.match(/<input type="date" name="dates" min="\d{4}-\d\d-\d\d" value="">/g).length, 6, 'no past dates');
  assert.equal(page.match(/<input name="activities" maxlength="60"/g).length, 6);
  assert.match(page, new RegExp(`<fieldset class="choices dates" data-max="${MAX_CHOICES}">`));
  assert.match(page, /name="kind" value="date" checked>/);
  assert.match(page, /name="open_choices" value="1">/, 'only its creator adds choices by default');
  assert.match(page, /value="public" checked>/, 'public by default, like events');
  const rejected = newPollPage({ id: 1 }, {
    kind: 'activity', choices: ['Bowling'], openChoices: 1,
    groups: [{ id: 5, name: 'Climbers', color: 2 }], sharing: { isPrivate: 1, groupIds: [5] },
    errors: { visibility: 'Oops.' },
  });
  assert.match(rejected, /name="kind" value="activity" checked>/, 'a rejected form keeps what was posted');
  assert.match(rejected, /name="activities" maxlength="60" placeholder="Bowling" value="Bowling">/);
  assert.equal(rejected.match(/name="activities"/g).length, 6, 'and fills up to six rows');
  assert.match(rejected, /name="open_choices" value="1" checked>/);
  assert.match(rejected, /id="visibility-private" checked>/);
  assert.match(rejected, /name="group_ids" value="5" checked>/);
  assert.match(rejected, /<p class="err">Oops\.<\/p>/);
});

test('newPollPage planned from an activity poll: dates only, the activity carried along', () => {
  const page = newPollPage({ id: 1 }, { title: 'Bowling', from: { id: 4, title: 'Saturday?', activity: 'Bowling' } });
  assert.match(page, /Pick dates for Bowling, the winner of “Saturday\?”\./);
  assert.match(page, /name="from" value="4">\s*<input type="hidden" name="activity" value="Bowling">/);
  assert.doesNotMatch(page, /name="kind"/);
  assert.match(page, /name="title" [^>]*value="Bowling"/);
});
