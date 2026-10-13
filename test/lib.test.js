import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidDate, birthdayIn, isValidTime, eventError, formatEventWhen, eventLanes, isValidWeekStart,
  formatDate, isValidDateFormat, bestDates, dayClass, monthInfo, weekdayNames, toggleSlot,
} from '../src/lib.js';

const thisYear = new Date().getUTCFullYear();

test('isValidDate', () => {
  assert.equal(isValidDate(`${thisYear}-02-28`), true);
  assert.equal(isValidDate(`${thisYear}-02-30`), false);
  assert.equal(isValidDate(`${thisYear}-13-01`), false);
  assert.equal(isValidDate(`${thisYear}-2-1`), false);
  assert.equal(isValidDate(`${thisYear + 30}-01-01`), true, 'any year');
  assert.equal(isValidDate(undefined), false);
  assert.equal(isValidDate("2026-01-01' OR 1=1"), false);
});

test('isValidDate: old dates and leap days (birthdays)', () => {
  assert.ok(isValidDate('1990-05-17'));
  assert.ok(isValidDate('2000-02-29'));
  assert.ok(!isValidDate('1990-02-30'));
  assert.ok(!isValidDate('1990-5-17'));
  assert.ok(!isValidDate(''));
});

test('bestDates: most yes, then fewest no', () => {
  const dates = ['2026-10-03', '2026-10-01', '2026-10-02'];
  assert.deepEqual(bestDates(dates, [
    { date: '2026-10-01', answer: 'yes' }, { date: '2026-10-01', answer: 'no' },
    { date: '2026-10-02', answer: 'yes' }, { date: '2026-10-02', answer: 'yes' },
    { date: '2026-10-03', answer: 'yes' }, { date: '2026-10-03', answer: 'maybe' },
  ]), ['2026-10-02']);
  // tie on yes: fewer "no" wins outright
  assert.deepEqual(bestDates(dates, [
    { date: '2026-10-01', answer: 'yes' }, { date: '2026-10-01', answer: 'no' },
    { date: '2026-10-03', answer: 'yes' }, { date: '2026-10-03', answer: 'maybe' },
  ]), ['2026-10-03']);
});

test('bestDates: every date tied on yes and no is proposed, earliest first', () => {
  const dates = ['2026-10-03', '2026-10-01', '2026-10-02'];
  // 10-01 and 10-03 both 2 yes / 1 no; 10-02 has fewer yes
  assert.deepEqual(bestDates(dates, [
    { date: '2026-10-01', answer: 'yes' }, { date: '2026-10-01', answer: 'yes' }, { date: '2026-10-01', answer: 'no' },
    { date: '2026-10-02', answer: 'yes' }, { date: '2026-10-02', answer: 'maybe' },
    { date: '2026-10-03', answer: 'yes' }, { date: '2026-10-03', answer: 'yes' }, { date: '2026-10-03', answer: 'no' },
  ]), ['2026-10-01', '2026-10-03']);
  // nobody voted: all tied at 0/0
  assert.deepEqual(bestDates(dates, []), ['2026-10-01', '2026-10-02', '2026-10-03']);
  // a "maybe" does not break a tie, it is neither yes nor no
  assert.deepEqual(bestDates(['2026-10-01', '2026-10-02'], [{ date: '2026-10-01', answer: 'maybe' }]),
    ['2026-10-01', '2026-10-02']);
  assert.deepEqual(bestDates([], []), []);
});

test('eventError: every rule', () => {
  const d = `${thisYear}-10-03`, next = `${thisYear}-10-05`;
  const ok = when => assert.equal(eventError({ date: d, ...when }), null, JSON.stringify(when));
  const bad = when => assert.notEqual(eventError({ date: d, ...when }), null, JSON.stringify(when));
  ok({});
  ok({ endDate: d, startTime: '19:00' });
  ok({ startTime: '19:00', endTime: '22:00' });
  ok({ endDate: next });
  ok({ endDate: next, startTime: '22:00', endTime: '08:00' }, 'overnight across days');
  bad({ date: 'nope' });
  bad({ endDate: `${thisYear}-10-02` });
  bad({ startTime: '24:00' });
  bad({ startTime: '7:00' });
  bad({ endTime: '10:00' });
  bad({ endDate: next, startTime: '19:00' });
  bad({ startTime: '19:00', endTime: '19:00' });
  assert.equal(isValidTime('23:59'), true);
  assert.equal(isValidTime(null), false);
});

test('eventError accepts any year, birthdayIn places a birthday in a month', () => {
  assert.equal(eventError({ date: '2040-06-01' }), null);
  assert.equal(eventError({ date: '1999-12-31', endDate: '2000-01-02' }), null);
  assert.equal(birthdayIn('2026-05', '1990-05-17'), '2026-05-17');
  assert.equal(birthdayIn('2026-06', '1990-05-17'), null);
  assert.equal(birthdayIn('2026-02', '2000-02-29'), '2026-02-28', 'Feb 29 falls on the 28th in other years');
  assert.equal(birthdayIn('2028-02', '2000-02-29'), '2028-02-29');
  assert.equal(birthdayIn('2026-05', null), null);
});

test('formatEventWhen: one day, timed, multi-day, timed multi-day', () => {
  const f = event => formatEventWhen({ date: '2026-10-03', end_date: '2026-10-03', ...event }, 'd-mon-y');
  assert.equal(f({}), '3 Oct. 2026');
  assert.equal(f({ start_time: '19:00' }), '3 Oct. 2026 19:00');
  assert.equal(f({ start_time: '19:00', end_time: '22:00' }), '3 Oct. 2026 19:00–22:00');
  assert.equal(f({ end_date: '2026-10-05' }), '3 Oct. 2026 – 5 Oct. 2026');
  assert.equal(f({ end_date: '2026-10-05', start_time: '18:00', end_time: '14:00' }),
    '3 Oct. 2026 18:00 – 5 Oct. 2026 14:00');
});

test('eventLanes: overlapping bars stack, a lane is reused once free, one-day events get none', () => {
  const ev = (id, date, end_date) => ({ id, date, end_date });
  const lanes = eventLanes([
    ev(1, '2026-10-01', '2026-10-03'),
    ev(2, '2026-10-02', '2026-10-05'),
    ev(3, '2026-10-02', '2026-10-02'),
    ev(4, '2026-10-03', '2026-10-04'), // lane 0 still busy on the 3rd: its end day counts
    ev(5, '2026-10-04', '2026-10-06'), // lane 0 free again
  ]);
  assert.deepEqual([...lanes], [[1, 0], [2, 1], [4, 2], [5, 0]]);
});

test('monthInfo: pad and weekday header follow the chosen first day', () => {
  // 2026-10-01 is a Thursday (getUTCDay() === 4).
  assert.equal(monthInfo('2026-10').pad, 4);        // Sunday-first, the default
  assert.equal(monthInfo('2026-10', 1).pad, 3);     // Monday-first
  assert.equal(monthInfo('2026-10', 4).pad, 0);     // Thursday-first: day 1 leads the grid
  assert.equal(monthInfo('2026-10', 5).pad, 6);     // Friday-first: wraps a full week
  assert.deepEqual(weekdayNames(1), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(weekdayNames(0)[0], 'Sun');
});

test('isValidWeekStart: only Saturday, Sunday and Monday', () => {
  for (const day of [6, 0, 1]) {
    assert.equal(isValidWeekStart(day), true);
  }
  for (const day of [2, 3, 4, 5, 7, -1, NaN, '0']) {
    assert.equal(isValidWeekStart(day), false, String(day));
  }
});

test('formatDate: every format, the fallback, and non-dates left alone', () => {
  assert.equal(formatDate('2026-09-29', 'd-mon-y'), '29 Sept. 2026');
  assert.equal(formatDate('2026-01-05', 'd-mon-y'), '5 Jan. 2026');
  assert.equal(formatDate('2026-05-01', 'd-mon-y'), '1 May 2026', 'short month names keep no period');
  assert.equal(formatDate('2026-09-29', 'mon-d-y'), 'Sept. 29, 2026');
  assert.equal(formatDate('2026-01-05', 'dd/mm/yyyy'), '05/01/2026');
  assert.equal(formatDate('2026-01-05', 'mm/dd/yyyy'), '01/05/2026');
  assert.equal(formatDate('2026-01-05', 'yyyy-mm-dd'), '2026-01-05');
  assert.equal(formatDate('2026-09-29', 'nope'), '29 Sept. 2026', 'unknown format: default');
  assert.equal(formatDate('2026-09-29', undefined), '29 Sept. 2026');
  assert.equal(formatDate('', 'd-mon-y'), '');
  assert.equal(isValidDateFormat('toString'), false, 'inherited keys are not formats');
});

test('dayClass: all = every member free at the same time, mine = I am free', () => {
  // each argument is one member: 'am', or 'am pm' for two free times that day
  const free = (...members) => members.map(parts => ({ parts: parts.split(' ') }));
  assert.equal(dayClass({ who: free('all', 'all'), members: 2, mine: true }), 'all mine');
  assert.equal(dayClass({ who: free('all'), members: 2, mine: false }), '');
  assert.equal(dayClass({ who: [], members: 0, mine: false }), '');
  assert.equal(dayClass({ who: free('am', 'am'), members: 2, mine: false }), 'all', 'everyone in the morning');
  assert.equal(dayClass({ who: free('all', 'pm'), members: 2, mine: false }), 'all',
    'all-day counts for the afternoon');
  assert.equal(dayClass({ who: free('am', 'pm'), members: 2, mine: false }), '', 'morning + afternoon never overlap');
  assert.equal(dayClass({ who: free('eve', 'all'), members: 2, mine: false }), 'all', 'all-day counts for the evening');
  assert.equal(dayClass({ who: free('eve', 'pm'), members: 2, mine: false }), '');
  assert.equal(dayClass({ who: free('am eve', 'eve'), members: 2, mine: false }), 'all', 'second slot counts');
  assert.equal(dayClass({ who: free('am eve', 'pm'), members: 2, mine: false }), '');
});

test('toggleSlot: adds a second slot, takes a picked one off, refuses a third', () => {
  assert.deepEqual(toggleSlot([], 'pm'), ['pm']);
  assert.deepEqual(toggleSlot(['all'], 'pm'), ['pm'], 'a slot replaces all day');
  assert.deepEqual(toggleSlot(['eve'], 'am'), ['am', 'eve'], 'kept in day order');
  assert.deepEqual(toggleSlot(['am', 'eve'], 'am'), ['eve']);
  assert.deepEqual(toggleSlot(['pm'], 'pm'), []);
  assert.equal(toggleSlot(['am', 'pm'], 'eve'), null);
});
