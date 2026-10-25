import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, buildIcs, birthdayRrule, eventRrule } from '../src/lib.js';

test('fold keeps every line within 75 octets, UTF-8 aware', () => {
  const folded = fold('SUMMARY:' + 'é'.repeat(100));
  for (const line of folded.split('\r\n')) {
    assert.ok(Buffer.byteLength(line) <= 75, `${Buffer.byteLength(line)} octets`);
  }
  assert.equal(folded.split('\r\n').slice(1).every(l => l.startsWith(' ')), true);
  assert.equal(folded.replaceAll('\r\n ', ''), 'SUMMARY:' + 'é'.repeat(100));
  assert.equal(fold('short'), 'short');
});

test('buildIcs escapes text, uses CRLF and exclusive DTEND', () => {
  const ics = buildIcs({ name: 'Test', host: 'cal.example.com', items: [
    {
      uid: 'event-1', date: '2026-12-31', summary: 'Party; bring snacks, drinks\nand games',
      stamp: '2026-09-14T11:40:00.123Z',
    },
  ] });
  assert.ok(ics.includes('SUMMARY:Party\\; bring snacks\\, drinks\\nand games\r\n'));
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101\r\n'));
  assert.ok(ics.includes('DTSTAMP:20260914T114000Z\r\n'));
  assert.ok(ics.includes('UID:event-1@cal.example.com\r\n'));
  assert.equal(ics.split('\n').length - 1, ics.split('\r\n').length - 1, 'only CRLF line endings');
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});

test('buildIcs: multi-day all-day and timed floating events', () => {
  const ics = buildIcs({ name: 'Test', host: 'h', items: [
    { uid: 'a', date: '2026-10-30', endDate: '2026-11-01', summary: 'Trip', stamp: '2026-09-14T11:40:00Z' },
    {
      uid: 'b', date: '2026-10-03', endDate: '2026-10-03', startTime: '19:00', endTime: '22:30',
      summary: 'Dinner', stamp: '2026-09-14T11:40:00Z',
    },
    { uid: 'c', date: '2026-10-04', startTime: '09:05', summary: 'Call', stamp: '2026-09-14T11:40:00Z' },
  ] });
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20261030\r\nDTEND;VALUE=DATE:20261102\r\n'),
    'exclusive end after the last day');
  assert.ok(ics.includes('DTSTART:20261003T190000\r\nDTEND:20261003T223000\r\n'));
  assert.ok(ics.includes('DTSTART:20261004T090500\r\nSUMMARY:Call'), 'no end time: no DTEND');
});

test('buildIcs: yearly birthday RRULE', () => {
  const ics = buildIcs({ name: 'B', host: 'h', items: [
    {
      uid: 'birthday-1', date: '2000-02-29', rrule: birthdayRrule('2000-02-29'), summary: '🎉 Ada',
      stamp: '2026-01-01T00:00:00Z',
    },
    {
      uid: 'birthday-2', date: '1990-05-17', rrule: birthdayRrule('1990-05-17'), summary: '🎉 Bob',
      stamp: '2026-01-01T00:00:00Z',
    },
  ] });
  assert.ok(ics.includes(
    'DTSTART;VALUE=DATE:20000229\r\nDTEND;VALUE=DATE:20000301\r\nRRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1\r\n'));
  assert.ok(ics.includes('DTSTART;VALUE=DATE:19900517\r\nDTEND;VALUE=DATE:19900518\r\nRRULE:FREQ=YEARLY\r\n'));
});

test('a repeating event is one VEVENT with its RRULE, UNTIL the kind of value DTSTART is; LOCATION escaped', () => {
  assert.equal(eventRrule({ rrule: null }), null);
  assert.equal(eventRrule({ rrule: 'FREQ=MONTHLY;UNTIL=20261231' }), 'FREQ=MONTHLY;UNTIL=20261231');
  assert.equal(eventRrule({ rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231', start_time: '19:00' }),
    'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T235900');
  const ics = buildIcs({ name: 'G', host: 'h', items: [{
    uid: 'event-1', date: '2026-10-05', startTime: '19:00', summary: 'Climb', location: 'Gym; Main St, 2nd floor',
    rrule: 'FREQ=YEARLY', stamp: '2026-01-01T00:00:00Z',
  }] });
  assert.ok(ics.includes('DTSTART:20261005T190000\r\nRRULE:FREQ=YEARLY\r\nLOCATION:Gym\\; Main St\\, 2nd floor\r\n'));
  assert.doesNotMatch(buildIcs({ name: 'G', host: 'h', items: [{ uid: 'x', date: '2026-10-05', summary: 's',
    stamp: '2026-01-01T00:00:00Z' }] }), /LOCATION|RRULE/, 'neither when not given');
});

test('a repeating event\'s skipped times are EXDATEs; one changed on its own a VEVENT with its RECURRENCE-ID', () => {
  const stamp = '2026-01-01T00:00:00Z';
  const timed = buildIcs({ name: 'G', host: 'h', items: [
    { uid: 'event-1', date: '2026-10-05', startTime: '19:00', summary: 'Climb', rrule: 'FREQ=WEEKLY;BYDAY=MO',
      exdates: ['2026-10-12', '2026-10-26'], stamp },
    { uid: 'event-1', date: '2026-10-20', startTime: '18:00', summary: 'Climb, Tuesday',
      recurrenceId: { date: '2026-10-19', startTime: '19:00' }, stamp },
  ] });
  assert.ok(timed.includes('RRULE:FREQ=WEEKLY;BYDAY=MO\r\nEXDATE:20261012T190000\r\nEXDATE:20261026T190000\r\n'));
  assert.ok(timed.includes('UID:event-1@h\r\nDTSTAMP:20260101T000000Z\r\nRECURRENCE-ID:20261019T190000\r\n'
    + 'DTSTART:20261020T180000\r\nSUMMARY:Climb\\, Tuesday\r\n'));
  const allDay = buildIcs({ name: 'G', host: 'h', items: [
    { uid: 'event-2', date: '2026-10-05', summary: 'Gym', rrule: 'FREQ=DAILY', exdates: ['2026-10-06'], stamp },
    { uid: 'event-2', date: '2026-10-09', summary: 'Gym', recurrenceId: { date: '2026-10-08' }, stamp },
  ] });
  assert.ok(allDay.includes('EXDATE;VALUE=DATE:20261006\r\n'));
  assert.ok(allDay.includes('RECURRENCE-ID;VALUE=DATE:20261008\r\nDTSTART;VALUE=DATE:20261009\r\n'));
});

// Security review: a lone CR in a member's text must not start a new line in the feed.
test('buildIcs: no line break or control character in text survives', () => {
  const ics = buildIcs({ name: 'T', host: 'h', items: [
    { uid: 'x', date: '2026-10-05', summary: 'Party\rEND:VEVENT\rBEGIN:VEVENT\x0b\x00', stamp: '2026-01-01T00:00:00Z' },
  ] });
  assert.ok(ics.includes('SUMMARY:Party\\nEND:VEVENT\\nBEGIN:VEVENT\r\n'));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2, 'the one real event, plus the escaped text');
  assert.equal(ics.split('\r\n').some(line => /[\x00-\x1f\x7f]/.test(line)), false);
});
