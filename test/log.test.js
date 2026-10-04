import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLogLine, parseLogLine, localTimestamp } from '../src/log.js';

test('log line: time, ip, user (real or not), action; user input cannot forge a line', () => {
  assert.match(formatLogLine({ ip: '1.2.3.4', user: 'alice', known: true, action: 'login ok (password)' }),
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d-0[45]:00 ip=1\.2\.3\.4 user="alice" action=login ok \(password\)\n$/);
  assert.match(formatLogLine({ ip: '1.2.3.4', user: 'mallory', known: false, action: 'x' }),
    / user="mallory" \(unknown\) /);
  assert.match(formatLogLine({ ip: '1.2.3.4', action: 'x' }), / user=- /);
  const forged = formatLogLine({ ip: '1.2.3.4\n9.9.9.9', user: 'a\n2026 ip=6.6.6.6', known: false, action: 'x' });
  assert.equal(forged.split('\n').length, 2, 'exactly one line plus the trailing newline');
});

test('log times are Eastern, following daylight saving', () => {
  assert.equal(localTimestamp(new Date('2026-07-01T12:00:00Z')), '2026-07-01T08:00:00-04:00', 'summer: UTC-4');
  assert.equal(localTimestamp(new Date('2026-01-15T12:00:00Z')), '2026-01-15T07:00:00-05:00', 'winter: UTC-5');
  assert.equal(localTimestamp(new Date('2026-01-01T03:30:00Z')), '2025-12-31T22:30:00-05:00',
    'crosses midnight and the year');
  // 2026-11-01 06:30Z is 01:30 EST, after clocks fell back at 06:00Z
  assert.equal(localTimestamp(new Date('2026-11-01T06:30:00Z')), '2026-11-01T01:30:00-05:00');
  // an old UTC line is shown in Eastern like the rest
  assert.equal(parseLogLine('2026-09-29T20:44:24.123Z ip=::1 user="a" action=logout').time,
    '2026-09-29T16:44:24-04:00');
});

test('parseLogLine reads back what formatLogLine wrote, even with a hostile name', () => {
  const roundTrip = entry => parseLogLine(formatLogLine(entry).trimEnd());
  const hostile = roundTrip({
    ip: '1.2.3.4', user: 'x" action=fake \\', known: false, action: 'login failed (password)',
  });
  assert.deepEqual({ ...hostile, time: '' },
    { time: '', ip: '1.2.3.4', user: 'x" action=fake \\', known: false, action: 'login failed (password)' });
  assert.deepEqual({ ...roundTrip({ ip: '::1', action: 'banned (too many attempts)' }), time: '' },
    { time: '', ip: '::1', user: '', known: true, action: 'banned (too many attempts)' });
  assert.equal(parseLogLine('garbage').action, 'garbage');
});
