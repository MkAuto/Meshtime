import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidDate, bestDate, fold, buildIcs } from './src/lib.js';

const y = new Date().getUTCFullYear();

test('isValidDate', () => {
  assert.equal(isValidDate(`${y}-02-28`), true);
  assert.equal(isValidDate(`${y}-02-30`), false);
  assert.equal(isValidDate(`${y}-13-01`), false);
  assert.equal(isValidDate(`${y}-2-1`), false);
  assert.equal(isValidDate(`${y + 3}-01-01`), false);
  assert.equal(isValidDate(undefined), false);
  assert.equal(isValidDate("2026-01-01' OR 1=1"), false);
});

test('bestDate: most yes, then fewest no, then earliest', () => {
  const dates = ['2026-10-03', '2026-10-01', '2026-10-02'];
  assert.equal(bestDate(dates, [
    { date: '2026-10-01', answer: 'yes' }, { date: '2026-10-01', answer: 'no' },
    { date: '2026-10-02', answer: 'yes' }, { date: '2026-10-02', answer: 'yes' },
    { date: '2026-10-03', answer: 'yes' }, { date: '2026-10-03', answer: 'maybe' },
  ]), '2026-10-02');
  // tie on yes: fewer "no" wins
  assert.equal(bestDate(dates, [
    { date: '2026-10-01', answer: 'yes' }, { date: '2026-10-01', answer: 'no' },
    { date: '2026-10-03', answer: 'yes' }, { date: '2026-10-03', answer: 'maybe' },
  ]), '2026-10-03');
  // full tie: earliest
  assert.equal(bestDate(dates, []), '2026-10-01');
});

test('fold keeps every line within 75 octets, UTF-8 aware', () => {
  const folded = fold('SUMMARY:' + 'é'.repeat(100));
  for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `${Buffer.byteLength(line)} octets`);
  assert.equal(folded.split('\r\n').slice(1).every(l => l.startsWith(' ')), true);
  assert.equal(folded.replaceAll('\r\n ', ''), 'SUMMARY:' + 'é'.repeat(100));
  assert.equal(fold('short'), 'short');
});

test('buildIcs escapes text, uses CRLF and exclusive DTEND', () => {
  const ics = buildIcs({ name: 'Test', host: 'cal.example.com', items: [
    { uid: 'event-1', date: '2026-12-31', summary: 'Party; bring snacks, drinks\nand games', stamp: '2026-09-14T11:40:00.123Z' },
    { uid: 'free-2-2026-01-05', date: '2026-01-05', summary: 'Bob is free', stamp: '2026-01-05T00:00:00Z', transparent: true },
  ] });
  assert.ok(ics.includes('SUMMARY:Party\\; bring snacks\\, drinks\\nand games\r\n'));
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101\r\n'));
  assert.ok(ics.includes('DTSTAMP:20260914T114000Z\r\n'));
  assert.ok(ics.includes('UID:event-1@cal.example.com\r\n'));
  assert.ok(ics.includes('TRANSP:TRANSPARENT\r\n'));
  assert.equal(ics.split('\n').length - 1, ics.split('\r\n').length - 1, 'only CRLF line endings');
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});
