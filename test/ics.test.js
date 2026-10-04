import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, buildIcs, birthdayRrule } from '../src/lib.js';

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

// Security review: a lone CR in a member's text must not start a new line in the feed.
test('buildIcs: no line break or control character in text survives', () => {
  const ics = buildIcs({ name: 'T', host: 'h', items: [
    { uid: 'x', date: '2026-10-05', summary: 'Party\rEND:VEVENT\rBEGIN:VEVENT\x0b\x00', stamp: '2026-01-01T00:00:00Z' },
  ] });
  assert.ok(ics.includes('SUMMARY:Party\\nEND:VEVENT\\nBEGIN:VEVENT\r\n'));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2, 'the one real event, plus the escaped text');
  assert.equal(ics.split('\r\n').some(line => /[\x00-\x1f\x7f]/.test(line)), false);
});
