import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsPage } from '../src/views.js';

test('settingsPage: Disable border of free days is off by default and ticked once set', () => {
  const user = { id: 1, feed_token: 'tok', week_start: 0, show_birthdays: 1, color: 3 };
  const box = /<input type="checkbox" name="hide_free_border" value="1"( checked)?>/;
  assert.equal(settingsPage(user, { base: '' }).match(box)[1], undefined, 'unticked by default');
  assert.equal(settingsPage({ ...user, hide_free_border: 1 }, { base: '' }).match(box)[1], ' checked');
});

test('settingsPage: one feed per group I am in, with Copy and webcal, and the birthdays feed', () => {
  const user = { id: 1, feed_token: 'tok', week_start: 0, date_format: undefined, show_birthdays: 1 };
  const page = settingsPage(user, { base: 'https://x.test', groups: [{ id: 7, name: 'Climbers' }] });
  assert.match(page, /<b>Climbers<\/b> \(group events\)/);
  assert.match(page, /data-copy="https:\/\/x\.test\/feed\/tok\/groups\/7\.ics" hidden>Copy/);
  assert.match(page, /href="webcal:\/\/x\.test\/feed\/tok\/groups\/7\.ics"/);
  assert.match(page, /data-copy="https:\/\/x\.test\/feed\/tok\/birthdays\.ics" hidden>Copy/, 'same box and button');
  assert.ok(page.indexOf('birthdays.ics') < page.indexOf('groups/7.ics'), 'birthdays first');
  assert.doesNotMatch(page, /events\.ics/, 'no all-events feed any more');
  assert.match(settingsPage(user, { base: 'https://x.test' }), /each <a href="\/groups">group<\/a> you are in/);
});
