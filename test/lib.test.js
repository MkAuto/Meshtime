import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidDate, birthdayIn, isValidTime, eventError, formatEventWhen, eventLanes, isValidWeekStart,
  formatDate, isValidDateFormat, bestDates, dayClass, monthInfo, weekdayNames, toggleSlot, today, occurrences,
  parseRrule, formatRrule, repeatRule, repeatForm, firstTime, timesBefore, timeOn,
} from '../src/lib.js';

const thisYear = new Date().getUTCFullYear();

test('today: the date in TZ (Eastern in tests), not in UTC', () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-24T02:00:00Z') }); // 22:00 on the 23rd in Toronto
  try {
    assert.equal(today(), '2026-10-23');
  } finally {
    mock.timers.reset();
  }
});

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
  assert.equal(f({}), '3 Oct 2026');
  assert.equal(f({ start_time: '19:00' }), '3 Oct 2026 19:00');
  assert.equal(f({ start_time: '19:00', end_time: '22:00' }), '3 Oct 2026 19:00–22:00');
  assert.equal(f({ end_date: '2026-10-05' }), '3 Oct 2026 – 5 Oct 2026');
  assert.equal(f({ end_date: '2026-10-05', start_time: '18:00', end_time: '14:00' }),
    '3 Oct 2026 18:00 – 5 Oct 2026 14:00');
});

test('formatEventWhen on a 12-hour device: midnight and noon are 12', () => {
  const f = event => formatEventWhen({ date: '2026-10-03', end_date: '2026-10-03', ...event }, 'd-mon-y', true);
  assert.equal(f({ start_time: '00:30', end_time: '12:00' }), '3 Oct 2026 12:30 AM–12:00 PM');
  assert.equal(f({ end_date: '2026-10-05', start_time: '09:05', end_time: '23:59' }),
    '3 Oct 2026 9:05 AM – 5 Oct 2026 11:59 PM');
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
  assert.deepEqual([...lanes].map(([event, lane]) => [event.id, lane]), [[1, 0], [2, 1], [4, 2], [5, 0]]);
});

// an event for occurrences: all day, on its own date, with `rrule`; dates() lists its times in a window
const ev = event => ({ id: 1, start_time: null, end_date: event.date, rrule: null, changes: '{}', ...event });
const dates = (events, from, to) => occurrences(events, from, to).map(event => `${event.date}..${event.end_date}`);
const days = (rrule, date, from, to) => occurrences([ev({ date, rrule })], from, to).map(event => event.date);

test('occurrences: each time a repeating event comes back in the window, at its own dates', () => {
  assert.deepEqual(days('FREQ=WEEKLY;BYDAY=MO', '2026-10-05', '2026-10-01', '2026-11-04'),
    ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02']);
  assert.deepEqual(days('FREQ=WEEKLY;BYDAY=MO;UNTIL=20261019', '2026-10-05', '2026-10-13', '2026-11-04'),
    ['2026-10-19'], 'until its last date, and only inside the window');
  assert.deepEqual(dates([ev({ date: '2026-09-25', end_date: '2026-09-27', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR' })],
    '2026-09-27', '2026-10-31'), ['2026-09-25..2026-09-27', '2026-10-09..2026-10-11', '2026-10-23..2026-10-25'],
  'a weekend every 2 weeks, the first one ending inside the window');
  assert.deepEqual(days('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE', '2026-10-07', '2026-10-01', '2026-10-31'),
    ['2026-10-07', '2026-10-19', '2026-10-21'], 'Mondays and Wednesdays every other week, from a Wednesday');
  assert.deepEqual(days('FREQ=DAILY;INTERVAL=3;COUNT=4', '2026-10-30', '2026-10-01', '2026-12-31'),
    ['2026-10-30', '2026-11-02', '2026-11-05', '2026-11-08'], 'every 3 days, 4 times');
  assert.deepEqual(days('FREQ=MONTHLY', '2026-01-31', '2026-01-01', '2026-05-31'),
    ['2026-01-31', '2026-03-31', '2026-05-31'], 'no 31st, none that month');
  assert.deepEqual(days('FREQ=MONTHLY;INTERVAL=2;BYDAY=2TU', '2026-10-13', '2026-10-01', '2027-02-28'),
    ['2026-10-13', '2026-12-08', '2027-02-09'], 'the second Tuesday, every other month');
  assert.deepEqual(days('FREQ=MONTHLY;BYDAY=-1FR', '2026-10-30', '2026-10-01', '2027-01-31'),
    ['2026-10-30', '2026-11-27', '2026-12-25', '2027-01-29'], 'the last Friday');
  assert.deepEqual(days('FREQ=YEARLY', '2028-02-29', '2028-01-01', '2033-01-01'), ['2028-02-29', '2032-02-29']);
  assert.deepEqual(dates([ev({ date: '2026-10-05' })], '2026-10-06', '2026-10-31'), [], 'a one-time event outside');

  const monday = ev({ date: '2026-10-05', rrule: 'FREQ=WEEKLY;BYDAY=MO' });
  const sorted = occurrences([ev({ id: 2, date: '2026-10-12', start_time: '09:00' }), { ...monday, id: 3 }],
    '2026-10-12', '2026-10-12');
  assert.deepEqual(sorted.map(event => event.id), [3, 2], 'all-day first');
  assert.equal(new Set(eventLanes(occurrences([{ ...monday, end_date: '2026-10-06' }], '2026-10-01', '2026-10-31'))
    .values()).size, 1, 'every occurrence its own lane entry, all in the top lane');
});

test('occurrences: a time changed or skipped on its own; a skipped one still counts toward COUNT', () => {
  const changes = JSON.stringify({ '2026-10-12': null, '2026-10-19': { title: 'Moved', date: '2026-10-20',
    end_date: '2026-10-20' }, '2026-11-09': { date: '2026-10-28', end_date: '2026-10-28' } });
  const climb = ev({ title: 'Climb', date: '2026-10-05', rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=6', changes });
  assert.deepEqual(occurrences([climb], '2026-10-01', '2026-10-31').map(time => [time.on, time.date, time.title]), [
    ['2026-10-05', '2026-10-05', 'Climb'], ['2026-10-19', '2026-10-20', 'Moved'], ['2026-10-26', '2026-10-26', 'Climb'],
    ['2026-11-09', '2026-10-28', 'Climb'],
  ], 'the 12th skipped, the 19th moved a day, the 9th of November moved in from after the window');
  assert.deepEqual(days(climb.rrule, climb.date, '2026-11-01', '2026-12-31'), ['2026-11-02', '2026-11-09'],
    '6 times from the first, whatever is skipped');
  assert.deepEqual(timeOn(climb, '2026-10-19'), { ...climb, title: 'Moved', date: '2026-10-20',
    end_date: '2026-10-20', on: '2026-10-19' });
});

test('rules: RRULE text both ways, the first date a rule gives, how many before a date', () => {
  const rule = { freq: 'WEEKLY', interval: 2, byday: ['MO', 'WE'], count: 10, until: undefined };
  assert.equal(formatRrule(rule), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10');
  assert.deepEqual(parseRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10'), rule);
  assert.equal(parseRrule('FREQ=MONTHLY;UNTIL=20261231').until, '2026-12-31');
  assert.equal(parseRrule(null), null);
  assert.equal(firstTime('2026-10-06', parseRrule('FREQ=WEEKLY;BYDAY=MO,WE')), '2026-10-07', 'a Tuesday: Wednesday');
  assert.equal(firstTime('2026-10-06', parseRrule('FREQ=WEEKLY;BYDAY=MO;UNTIL=20261011')), undefined, 'none');
  assert.equal(timesBefore('2026-10-05', parseRrule('FREQ=WEEKLY;BYDAY=MO'), '2026-10-26'), 3);
});

test('repeatRule: the Repeat menu and Custom, relative to the start date; repeatForm the other way', () => {
  const tuesday = '2026-10-13'; // the second Tuesday of October
  const rule = (form, date = tuesday) => {
    const { rule: made, error } = repeatRule(form, date);
    return error ?? (made && formatRrule(made));
  };
  assert.equal(rule({ repeats: '' }), null);
  assert.equal(rule({ repeats: 'weekly' }), 'FREQ=WEEKLY;BYDAY=TU');
  assert.equal(rule({ repeats: 'biweekly', ends: 'on', endsOn: '2026-12-31' }),
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20261231');
  assert.equal(rule({ repeats: 'monthlyNth' }), 'FREQ=MONTHLY;BYDAY=2TU');
  assert.equal(rule({ repeats: 'monthlyNth' }, '2026-10-29'), 'FREQ=MONTHLY;BYDAY=-1TH', 'a fifth Thursday: last');
  assert.equal(rule({ repeats: 'weekdays', ends: 'after', endsAfter: '10' }),
    'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10');
  const custom = { repeats: 'custom', every: '2', unit: 'WEEKLY', days: ['WE', 'MO', 'MO'] };
  assert.equal(rule(custom), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE');
  assert.equal(rule({ ...custom, days: [] }), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', 'no day ticked: its own');
  assert.equal(rule({ ...custom, unit: 'MONTHLY', monthly: 'last' }, '2026-10-27'),
    'FREQ=MONTHLY;INTERVAL=2;BYDAY=-1TU');
  assert.equal(rule({ ...custom, unit: 'MONTHLY', monthly: 'last' }), 'errors.event.repeat', 'not in the last week');
  assert.equal(rule({ ...custom, unit: 'YEARLY', every: '100' }), 'errors.event.repeatEvery');
  assert.equal(rule({ ...custom, days: ['XX'] }), 'errors.event.repeat');
  assert.equal(rule({ repeats: 'weekly', ends: 'after', endsAfter: '1000' }), 'errors.event.repeatCount');
  assert.equal(rule({ repeats: 'weekly', ends: 'on', endsOn: '2026-10-12' }), 'errors.event.repeatUntil');
  assert.equal(rule({ repeats: 'hourly' }), 'errors.event.repeat');

  assert.deepEqual(repeatForm(parseRrule('FREQ=WEEKLY;BYDAY=TU;COUNT=5'), tuesday), { repeats: 'weekly', every: 1,
    unit: 'WEEKLY', days: ['TU'], monthly: 'day', ends: 'after', endsOn: '', endsAfter: 5 });
  assert.deepEqual(repeatForm(parseRrule('FREQ=MONTHLY;BYDAY=-1TU;UNTIL=20261231'), '2026-10-27'), { repeats: 'custom',
    every: 1, unit: 'MONTHLY', days: ['TU'], monthly: 'last', ends: 'on', endsOn: '2026-12-31', endsAfter: '' },
  'the fourth Tuesday is also the last, but the menu offers the fourth: Custom');
  assert.equal(repeatForm(null, tuesday).repeats, '');
});

test('eventError: a repeating event must end before it comes back', () => {
  const d = '2026-10-03';
  const weekly = parseRrule('FREQ=WEEKLY;BYDAY=SA');
  const weekend = parseRrule('FREQ=WEEKLY;BYDAY=MO,SA');
  assert.equal(eventError({ date: d, endDate: '2026-10-09', rule: weekly }), null, '7 days, back on day 8');
  assert.equal(eventError({ date: d, endDate: '2026-10-10', rule: weekly })?.message, 'errors.event.repeatTooLong');
  assert.equal(eventError({ date: d, endDate: '2026-10-04', rule: weekend }), null, 'Saturday and Sunday, back Monday');
  assert.equal(eventError({ date: d, endDate: '2026-10-05', rule: weekend })?.message, 'errors.event.repeatTooLong',
    'the shortest gap counts');
  assert.equal(eventError({ date: d, endDate: '2026-10-31', rule: parseRrule('FREQ=MONTHLY') })?.message,
    'errors.event.repeatTooLong');
  assert.equal(eventError({ date: d, endDate: '2026-10-04', rule: parseRrule('FREQ=DAILY;INTERVAL=2') }), null);
});

test('monthInfo: pad and weekday header follow the chosen first day', () => {
  // 2026-10-01 is a Thursday (getUTCDay() === 4).
  assert.equal(monthInfo('2026-10').pad, 4);        // Sunday-first, the default
  assert.equal(monthInfo('2026-10', 1).pad, 3);     // Monday-first
  assert.equal(monthInfo('2026-10', 4).pad, 0);     // Thursday-first: day 1 leads the grid
  assert.equal(monthInfo('2026-10', 5).pad, 6);     // Friday-first: wraps a full week
  // the whole weeks the month touches: Sunday Sep 27 to Saturday Oct 31, Monday-first Sep 28 to Sunday Nov 1
  assert.equal(monthInfo('2026-10').gridStart, '2026-09-27');
  assert.equal(monthInfo('2026-10').gridEnd, '2026-10-31');
  assert.equal(monthInfo('2026-10', 1).gridStart, '2026-09-28');
  assert.equal(monthInfo('2026-10', 1).gridEnd, '2026-11-01');
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
  assert.equal(formatDate('2026-09-29', 'd-mon-y'), '29 Sep 2026');
  assert.equal(formatDate('2026-01-05', 'd-mon-y'), '5 Jan 2026');
  assert.equal(formatDate('2026-05-01', 'd-mon-y'), '1 May 2026');
  assert.equal(formatDate('2026-09-29', 'mon-d-y'), 'Sep 29, 2026');
  assert.equal(formatDate('2026-09-29', 'd-mon-y', 'fr'), '29 sept. 2026', 'month names follow the language');
  assert.equal(formatDate('2026-07-14', 'd-mon-y', 'fr'), '14 juill. 2026', 'Quebec French: juill.');
  assert.equal(formatDate('2026-09-29', 'dd/mm/yyyy', 'fr'), '29/09/2026', 'the pattern stays the member\'s');
  assert.equal(formatDate('2026-01-05', 'dd/mm/yyyy'), '05/01/2026');
  assert.equal(formatDate('2026-01-05', 'mm/dd/yyyy'), '01/05/2026');
  assert.equal(formatDate('2026-01-05', 'yyyy-mm-dd'), '2026-01-05');
  assert.equal(formatDate('2026-09-29', 'nope'), '29 Sep 2026', 'unknown format: default');
  assert.equal(formatDate('2026-09-29', undefined), '29 Sep 2026');
  assert.equal(formatDate('2026-09-29', 'd-mon-y', 'xx'), '29 Sep 2026', 'unknown language: English');
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
