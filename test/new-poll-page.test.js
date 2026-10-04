import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DATES } from '../src/lib.js';
import { newPollPage } from '../src/views.js';

// The no-JS fallback and the hook public/app.js keys off of.
test('newPollPage renders 6 date rows inside .dates', () => {
  const page = newPollPage({ name: 'a', id: 1 });
  assert.equal(page.match(/<input type="date" name="dates">/g).length, 6);
  assert.match(page, new RegExp(`<fieldset class="stack dates" data-max="${MAX_DATES}">`));
  assert.match(page, /value="public" checked>/, 'public by default, like events');
  const rejected = newPollPage({ id: 1 }, {
    groups: [{ id: 5, name: 'Climbers', color: 2 }], sharing: { isPrivate: 1, groupIds: [5] },
    errors: { visibility: 'Oops.' },
  });
  assert.match(rejected, /id="visibility-private" checked>/, 'a rejected form keeps who sees it');
  assert.match(rejected, /name="group_ids" value="5" checked>/);
  assert.match(rejected, /<p class="err">Oops\.<\/p>/);
});
