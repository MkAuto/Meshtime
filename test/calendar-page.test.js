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
