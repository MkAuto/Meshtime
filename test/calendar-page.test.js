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
