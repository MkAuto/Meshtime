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

test('settingsPage: Rules once a calendar is connected, days in my week order, my choices kept', () => {
  const user = {
    id: 1, feed_token: 'tok', week_start: 1, show_birthdays: 1,
    busy_minutes: 60, busy_slots: '0eve 1am', ignore_words: 'gym, lunch',
  };
  assert.doesNotMatch(settingsPage(user, { base: '' }), /settings\/calendars\/rules/, 'no calendar, no rules');
  const page = settingsPage(user, { base: '', calendarLinks: [{ id: 4, url: 'https://x.test/a.ics', label: 'Work' }] });
  assert.match(page, /<option value="60" selected>1h<\/option>/);
  assert.match(page, /name="ignore_words" maxlength="500" value="gym, lunch"/);
  assert.match(page, /value="1am" aria-label="Mon AM" checked>/);
  assert.match(page, /value="0eve" aria-label="Sun EVE" checked>/);
  assert.match(page, /value="1pm" aria-label="Mon PM">/, 'not ticked');
  assert.ok(page.indexOf('"Mon AM"') < page.indexOf('"Sun AM"'), 'Monday first');
  assert.match(settingsPage({ ...user, busy_minutes: undefined }, { base: '', calendarLinks: [{ id: 4, url: 'https://x.test' }] }),
    /<option value="120" selected>2h<\/option>/, 'default 2h');
});

test('settingsPage: Customisation first, then Calendar Integration with my calendars, then Calendar feeds', () => {
  const user = { id: 1, feed_token: 'tok', week_start: 0, show_birthdays: 1 };
  const page = settingsPage(user, { base: '', calendarLinks: [
    {
      id: 4, url: 'https://calendar.google.com/x/private-secret/basic.ics', label: '',
      last_error: 'Could not reach that link.',
    },
  ] });
  const order = ['Customisation', 'Calendar Integration', 'Calendar feeds']
    .map(title => page.indexOf(`<h2>${title}</h2>`));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(page, /<b>calendar\.google\.com<\/b>/, 'named by host when it has no label');
  assert.doesNotMatch(page, /private-secret/, 'the secret link is not shown again');
  assert.match(page, /action="\/settings\/calendars\/4\/delete"/);
  assert.match(page, /Could not reach that link\./);
});
