import { test } from 'node:test';
import assert from 'node:assert/strict';
import ical from 'node-ical';
import { freePartsByDay, freePartsAround, withoutFreeEvents } from '../src/sync.js';

// Times are TZID'd in TIME_ZONE (pinned to America/Toronto for tests by test/test.env).
const calendar = events => ical.sync.parseICS(`BEGIN:VCALENDAR\r\n${events.map(lines => [
  'BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n')).join('\r\n')}\r\nEND:VCALENDAR\r\n`);
const at = time => `;TZID=America/Toronto:${time}`;

test('freePartsByDay: the free parts left around each day\'s events', () => {
  const days = freePartsByDay([calendar([
    ['UID:a', `DTSTART${at('20261003T090000')}`, `DTEND${at('20261003T110000')}`],
    ['UID:b', 'DTSTART;VALUE=DATE:20261004', 'DTEND;VALUE=DATE:20261005'],
    ['UID:c', `DTSTART${at('20261006T170000')}`, `DTEND${at('20261006T190000')}`],
    ['UID:d', 'TRANSP:TRANSPARENT', `DTSTART${at('20261007T090000')}`, `DTEND${at('20261007T110000')}`],
    ['UID:e', `DTSTART${at('20261008T220000')}`, `DTEND${at('20261009T080000')}`],
    ['UID:f', `DTSTART${at('20261010T100000')}`, `DTEND${at('20261010T130000')}`],
    ['UID:g', `DTSTART${at('20261011T090000')}`, `DTEND${at('20261011T110000')}`],
    ['UID:h', `DTSTART${at('20261011T113000')}`, `DTEND${at('20261011T123000')}`],
    ['UID:i', `DTSTART${at('20261012T020000')}`, `DTEND${at('20261012T060000')}`],
    ['UID:j', `DTSTART${at('20261013T080000')}`, `DTEND${at('20261013T090000')}`],
    ['UID:k', `DTSTART${at('20261013T100000')}`, `DTEND${at('20261013T110000')}`],
    ['UID:l', `DTSTART${at('20261014T130000')}`, `DTEND${at('20261014T143000')}`],
    ['UID:m', `DTSTART${at('20261014T133000')}`, `DTEND${at('20261014T143000')}`],
  ])], '2026-10-03', '2026-10-14');
  assert.deepEqual(days.get('2026-10-03'), ['pm', 'eve'], '9 to 11 am: 2 h of the morning');
  assert.deepEqual(days.get('2026-10-04'), [], 'all-day event');
  assert.deepEqual(days.get('2026-10-05'), ['all'], 'no event');
  assert.deepEqual(days.get('2026-10-06'), ['all'], '17:00 to 19:00: only 1 h of the afternoon and of the evening');
  assert.deepEqual(days.get('2026-10-07'), ['pm', 'eve'], 'an event shown as Free counts when it is kept');
  assert.deepEqual(days.get('2026-10-08'), ['am', 'pm'], '22:00 into the next day: 2 h of the evening');
  assert.deepEqual(days.get('2026-10-09'), ['pm', 'eve'], 'until 8:00: 2 h of the morning');
  assert.deepEqual(days.get('2026-10-10'), ['pm', 'eve'], '10:00 to 13:00: 2 h of the morning, 1 of the afternoon');
  assert.deepEqual(days.get('2026-10-11'), ['pm', 'eve'], '2 h + 30 min of the morning');
  assert.deepEqual(days.get('2026-10-12'), ['all'], 'before 6:00 is in no part');
  assert.deepEqual(days.get('2026-10-13'), ['pm', 'eve'], 'two 1 h events add up to 2 h of the morning');
  assert.deepEqual(days.get('2026-10-14'), ['all'], 'overlapping events: the shared hour counts once (1 h 30)');
});

test('freePartsByDay: weekly repeats, skipped dates and several calendars', () => {
  const work = calendar([['UID:w', `DTSTART${at('20261005T090000')}`, `DTEND${at('20261005T110000')}`,
    'RRULE:FREQ=WEEKLY;COUNT=3', `EXDATE${at('20261012T090000')}`]]);
  const gym = calendar([['UID:g', `DTSTART${at('20261019T190000')}`, `DTEND${at('20261019T210000')}`]]);
  const days = freePartsByDay([work, gym], '2026-10-05', '2026-10-26');
  assert.deepEqual(days.get('2026-10-05'), ['pm', 'eve']);
  assert.deepEqual(days.get('2026-10-12'), ['all'], 'EXDATE');
  assert.deepEqual(days.get('2026-10-19'), ['pm'], 'both calendars count');
  assert.deepEqual(days.get('2026-10-26'), ['all'], 'COUNT=3 ended');
});

test('freePartsByDay: the member\'s rules: busy threshold, always-busy slots, ignored title words', () => {
  const events = calendar([
    ['UID:a', 'SUMMARY:Standup', `DTSTART${at('20261005T090000')}`, `DTEND${at('20261005T093000')}`], // Mon
    ['UID:b', 'SUMMARY:GYM with Sam', `DTSTART${at('20261006T090000')}`, `DTEND${at('20261006T120000')}`],
    ['UID:c', `DTSTART${at('20261007T090000')}`, `DTEND${at('20261007T120000')}`],
  ]);
  const days = freePartsByDay([events], '2026-10-05', '2026-10-08',
    { busy_minutes: 1, busy_slots: '4eve', ignore_words: 'lunch, gym' });
  assert.deepEqual(days.get('2026-10-05'), ['pm', 'eve'], 'Any event: 30 min take the morning');
  assert.deepEqual(days.get('2026-10-06'), ['all'], 'title contains "gym", any case');
  assert.deepEqual(days.get('2026-10-07'), ['pm', 'eve'], 'an event without a title is never ignored');
  assert.deepEqual(days.get('2026-10-08'), ['am', 'pm'], 'Thursday evening is always busy');
  assert.deepEqual(freePartsByDay([events], '2026-10-05', '2026-10-07').get('2026-10-05'), ['all'], 'default: 2 h');
  assert.deepEqual(freePartsByDay([events], '2026-10-07', '2026-10-07', { busy_minutes: 360 }).get('2026-10-07'),
    ['all'], 'Whole slot: 3 h of 6 is not enough');
  const dinner = calendar([['UID:d', `SUMMARY:${'Dîner'.normalize('NFD')}`, `DTSTART${at('20261005T180000')}`,
    `DTEND${at('20261005T210000')}`]]);
  assert.deepEqual(freePartsByDay([dinner], '2026-10-05', '2026-10-05', { ignore_words: 'dîner'.normalize('NFC') })
    .get('2026-10-05'), ['all'], 'an accent written in another Unicode form in the feed than typed');
  assert.deepEqual(freePartsByDay([dinner], '2026-10-05', '2026-10-05', { ignore_words: 'DINER' }).get('2026-10-05'),
    ['all'], 'typed without the accent');
});

test('withoutFreeEvents: drops the events shown as Free, keeps the Busy ones', () => {
  const both = calendar([
    ['UID:busy', `DTSTART${at('20261003T090000')}`, `DTEND${at('20261003T110000')}`],
    ['UID:free', 'TRANSP:TRANSPARENT', `DTSTART${at('20261004T090000')}`, `DTEND${at('20261004T110000')}`],
  ]);
  const days = freePartsByDay([withoutFreeEvents(both)], '2026-10-03', '2026-10-04');
  assert.deepEqual(days.get('2026-10-03'), ['pm', 'eve']);
  assert.deepEqual(days.get('2026-10-04'), ['all']);
});

test('freePartsAround: another group\'s events take a member\'s free parts by their Calendar Integration rules', () => {
  const event = (title, date, start_time = null, end_time = null, end_date = date) =>
    ({ title, date, end_date, start_time, end_time });
  const day = '2026-10-05';
  assert.deepEqual(freePartsAround(['all'], day, [event('Hike', day)]), [], 'all day');
  assert.deepEqual(freePartsAround(['all'], day, [event('Brunch', day, '10:00', '13:00')]), ['pm', 'eve'],
    '10:00 to 13:00: 2 h of the morning, 1 of the afternoon');
  assert.deepEqual(freePartsAround(['am', 'eve'], day, [event('Dinner', day, '19:00')]), ['am'],
    'no end time: its whole slot');
  assert.deepEqual(freePartsAround(['all'], day, [event('Late', day, '05:00')]), ['all'], 'before 6:00 is in no part');
  assert.deepEqual(freePartsAround(['all'], day, [event('Trip', '2026-10-04', '18:00', '09:00', day)]), ['pm', 'eve'],
    'the day it ends: 3 h of the morning');
  assert.deepEqual(freePartsAround(['all'], day, [event('Call', day, '09:00', '09:30')], { busy_minutes: 1 }),
    ['pm', 'eve'], 'Any event');
  assert.deepEqual(freePartsAround(['all'], day, [event('Gym class', day)], { ignore_words: 'gym' }), ['all'],
    'ignored title');
  assert.deepEqual(freePartsAround(['all'], day, [event('Dîner'.normalize('NFD'), day)],
    { ignore_words: 'dîner'.normalize('NFC') }), ['all'], 'accents in two Unicode forms');
  assert.deepEqual(freePartsAround(['all'], day, [event('Café', day)], { ignore_words: 'cafe' }), ['all'],
    'typed without the accent');
});
