import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventPage } from '../src/views.js';

test('eventPage: a new event starts blank on the default color, with nothing to delete', () => {
  const page = eventPage({ id: 1, name: 'a' }, { event: { date: '2026-10-03' } });
  assert.match(page, /<form method="post" action="\/events" class="stack">/);
  assert.match(page, /name="date" required value="2026-10-03"/);
  assert.match(page, /value="" aria-label="Default" checked>/);
  assert.match(page, /name="all_day" value="1" id="all-day" checked>/, 'a new event starts all day');
  assert.equal((page.match(/ checked>/g) || []).length, 3, 'only the default color, All day and Public');
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
  assert.equal((page.match(/ checked>/g) || []).length, 2, 'its color, and Public');
  assert.match(page, /action="\/events\/7\/delete"/);
  // a form error sits right under the field it is about, not on a page of its own
  assert.match(page, /value="14:00">\s*<\/span>\s*<\/label>\s*<p class="err">Oops<\/p>/);
  assert.equal((page.match(/class="err"/g) || []).length, 1, 'only the field in error');
  // a one-day event shows no end date, so moving its start does not strand the end
  assert.match(eventPage({ id: 1 }, { event: { ...event, end_date: event.date } }),
    /name="end_date" aria-label="End date" value=""/);
});
