import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventPage } from '../src/views.js';

test('eventPage: a new event starts blank on the default color, with nothing to delete', () => {
  const page = eventPage({ id: 1, name: 'a' }, { event: { date: '2026-10-03' } });
  assert.match(page, /<form method="post" action="\/events" class="stack">/);
  assert.match(page, /name="date" required value="2026-10-03"/);
  assert.match(page, /value="" aria-label="Default" checked>/);
  assert.match(page, /name="all_day" value="1" id="all-day" checked>/, 'a new event starts all day');
  assert.equal((page.match(/ checked>/g) || []).length, 5,
    'only the default color, All day, Public, and the hidden Repeat defaults: its weekday in Custom, Ends never');
  assert.doesNotMatch(page, /delete/);
});

test('eventPage: All day is ticked for an event without a start time, or as a rejected form posted it', () => {
  const timed = { id: 7, title: 'Dinner', date: '2026-10-03', end_date: '2026-10-03', start_time: '19:00' };
  assert.match(eventPage({ id: 1 }, { event: timed }), /id="all-day">/, 'a timed event is not all day');
  assert.match(eventPage({ id: 1 }, { event: { ...timed, start_time: null } }), /id="all-day" checked>/);
  assert.match(eventPage({ id: 1 }, { event: { ...timed, start_time: null, allDay: false } }), /id="all-day">/,
    'unticked and sent back without a time: stays unticked so the time error shows');
});

test('eventPage: public by default; a private event ticks the groups it is shared with', () => {
  const groups = [{ id: 1, name: 'Climbers', color: 3 }, { id: 2, name: 'Board games', color: 5 }];
  const fresh = eventPage({ id: 1 }, { event: { date: '2026-10-03' }, groups });
  assert.match(fresh, /value="public" checked>/);
  assert.match(fresh, /name="group_ids" value="1">/, 'every group offered, none ticked');
  assert.match(fresh, /name="group_ids" value="2">/);
  const shared = eventPage({ id: 1 }, { event: { date: '2026-10-03', is_private: 1, groupIds: [2] }, groups });
  assert.match(shared, /value="private" id="visibility-private" checked>/);
  assert.match(shared, /name="group_ids" value="1">/);
  assert.match(shared, /name="group_ids" value="2" checked>/);
  assert.match(eventPage({ id: 1 }, { event: { date: '2026-10-03' } }), /Not in any <a href="\/groups">group<\/a>/);
});

test('eventPage: editing shows the saved values and color, and offers delete', () => {
  const event = {
    id: 7, title: 'Trip', date: '2026-10-03', end_date: '2026-10-05', start_time: '18:00', end_time: '14:00', color: 4,
  };
  const page = eventPage({ id: 1, name: 'a' }, { event, errors: { end: 'Oops' } });
  assert.match(page, /action="\/events\/7" class="stack"/);
  assert.match(page, /value="Trip"/);
  assert.match(page, /name="end_date" aria-label="End date" value="2026-10-05"/);
  assert.match(page, /name="end_time" aria-label="End time" value="14:00"/);
  assert.match(page, /value="4" aria-label="Color 5" checked>/);
  assert.equal((page.match(/ checked>/g) || []).length, 4, 'its color, Public, and the hidden Repeat defaults');
  assert.match(page, /action="\/events\/7\/delete"/);
  // a form error sits right under the field it is about, not on a page of its own
  assert.match(page, /value="14:00">\s*<\/span>\s*<\/label>\s*<p class="err">Oops<\/p>/);
  assert.equal((page.match(/class="err"/g) || []).length, 1, 'only the field in error');
  // a one-day event shows no end date, so moving its start does not strand the end
  assert.match(eventPage({ id: 1 }, { event: { ...event, end_date: event.date } }),
    /name="end_date" aria-label="End date" value=""/);
});

test('eventPage: Repeat names the start date like Google Calendar; a saved custom rule shows in Custom', () => {
  const fresh = eventPage({ id: 1 }, { event: { date: '2026-10-13' } });
  assert.match(fresh, /<option value="" selected>Does not repeat<\/option>/);
  for (const label of ['Daily', 'Weekly on Tuesday', 'Every 2 weeks on Tuesday', 'Monthly on day 13',
    'Monthly on the second Tuesday', 'Annually on October 13', 'Every weekday \\(Monday to Friday\\)', 'Custom…']) {
    assert.match(fresh, new RegExp(`>${label}</option>`));
  }
  assert.match(fresh, /value="weekly" data-label="Weekly on \{day\}">/, 'app.js renames it when the date changes');
  assert.match(fresh, /value="last" data-label="Monthly on the last \{day\}" hidden disabled>/,
    'the 13th is not in the month\'s last week');
  assert.match(fresh, /name="location" maxlength="200" value=""/);
  assert.doesNotMatch(fresh, /name="scope"/, 'a new event: no choice of which times');

  const event = { id: 7, title: 'Climb', date: '2026-10-05', end_date: '2026-10-05', location: 'Gym',
    rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10', changes: '{}', on: '2026-10-19' };
  const page = eventPage({ id: 1, week_start: 1 }, { event });
  assert.match(page, /name="location" maxlength="200" value="Gym"/);
  assert.match(page, /<option value="custom" selected>Custom…<\/option>/);
  assert.match(page, /name="repeat_every" min="1" max="99" value="2"/);
  assert.match(page, /<option value="WEEKLY" data-one="week" data-other="weeks" selected>weeks<\/option>/);
  assert.deepEqual([...page.matchAll(/name="repeat_days" value="(\w\w)" aria-label="\w+"( checked)?/g)]
    .map(([, day, checked]) => day + (checked ? '✓' : '')), ['MO✓', 'TU', 'WE✓', 'TH', 'FR', 'SA', 'SU'],
  'in my week\'s order');
  assert.match(page, /value="after" checked> After/);
  assert.match(page, /name="ends_after" min="1" max="999" value="10"/);
  assert.equal(page.match(/name="on" value="2026-10-19"/g).length, 2, 'the time it is for, to save and to delete');
  assert.equal(page.match(/value="one" checked> This event/g).length, 2);
  assert.match(page, /value="following"> This and following events/);
  assert.match(page, /value="all"> All events/);
  assert.match(page, /data-confirm="Delete Climb\?"/);
  assert.doesNotMatch(page, /data-confirm-changes/, 'no time changed on its own: nothing to warn about');
  assert.match(eventPage({ id: 1 }, { event: { ...event, changes: '{"2026-10-12":null}' } }),
    /data-confirm-changes="The times of this event you changed one by one/);
});
