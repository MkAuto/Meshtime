import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarPage } from '../src/views.js';

test('calendarPage: drops the free-day outline when Disable border of free days is set', () => {
  const user = { id: 1, feed_token: 'tok', week_start: 0, show_birthdays: 1, color: 3 };
  const month = { free: new Map(), mine: new Map(), events: [], birthdays: [], today: '2026-10-04', members: 1 };
  assert.match(calendarPage(user, '2026-10', month), /<div class="grid c3">/);
  assert.match(calendarPage({ ...user, hide_free_border: 1 }, '2026-10', month),
    /<div class="grid c3 no-free-border">/);
});

test('calendarPage: leaves my own initials out when Hide my own initials is set', () => {
  const user = { id: 1, feed_token: 'tok', week_start: 0, show_birthdays: 1, color: 3 };
  const free = new Map([['2026-10-05', [
    { name: 'Ann Lee', color: 1, parts: ['all'], isMe: true },
    { name: 'Bob Kay', color: 2, parts: ['all'], isMe: false },
  ]]]);
  const month = { free, mine: new Map([['2026-10-05', ['all']]]), events: [], birthdays: [], today: '2026-10-04',
    members: 2 };
  assert.match(calendarPage(user, '2026-10', month), /Ann Lee/);
  const hidden = calendarPage({ ...user, hide_own_initials: 1 }, '2026-10', month);
  assert.doesNotMatch(hidden, /Ann Lee/);
  assert.match(hidden, /Bob Kay/);
});

test('calendarPage: the continuous calendar fills the first and last weeks with the months around', () => {
  const user = { id: 1, feed_token: 'tok', week_start: 0, show_birthdays: 1, color: 3 };
  const month = { free: new Map(), mine: new Map(), events: [], birthdays: [], today: '2026-10-04', members: 1 };
  // November 2026: Sunday 1st to Monday 30th, so Tuesday Dec 1 to Saturday Dec 5 finish the last week
  const continuous = calendarPage(user, '2026-11', month);
  assert.match(continuous, /<div class="day [^"]* outside">\s*<form[^>]*>\s*<input [^>]*value="2026-12-01"/);
  assert.match(continuous, /<span class="num">Dec\. 1<\/span>/, 'a day of the next month says which month');
  assert.match(continuous, /<span class="num">Dec\. 5<\/span>/, 'every one of them, not only the 1st');
  assert.match(continuous, /<span class="num">30<\/span>/, 'the days of this month do not');
  assert.match(continuous, /value="2026-12-05"/);
  assert.doesNotMatch(continuous, /value="2026-12-06"/, 'only to the end of the week');
  assert.doesNotMatch(continuous, /day pad/);
  // October 2026 starts on a Thursday: Sep 27 to 30 come first
  assert.match(calendarPage(user, '2026-10', month), /value="2026-09-27"/);

  const blank = calendarPage({ ...user, continuous_calendar: 0 }, '2026-10', month);
  assert.doesNotMatch(blank, /value="2026-09-|outside/);
  assert.equal(blank.match(/day pad/g).length, 4, 'blank cells before Thursday the 1st');
});

test('calendarPage: events from the days around show in the grid, not in the month list', () => {
  const user = { id: 1, feed_token: 'tok', week_start: 0, show_birthdays: 1, color: 3 };
  const event = { id: 9, title: 'Crag day', date: '2026-12-02', end_date: '2026-12-02', creator: 'Bob', created_by: 2 };
  const page = calendarPage(user, '2026-11',
    { free: new Map(), mine: new Map(), events: [event], birthdays: [], today: '2026-10-04', members: 1 });
  assert.match(page, /title="Crag day[^"]*">Crag day<\/span>/, 'in its cell');
  assert.match(page, /<li class="hint">No events this month\.<\/li>/);
});
