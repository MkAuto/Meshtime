import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  isValidDate, birthdayIn, birthdayRrule, isValidTime, eventError, formatEventWhen, eventLanes, isValidWeekStart,
  formatDate, isValidDateFormat, bestDates, fold, buildIcs, dayClass, monthInfo, weekdayNames, MAX_DATES,
  toggleSlot,
  verifyWebAuthn, RP_ID, ORIGIN,
} from './src/lib.js';
import { newPollPage, pollPage, eventPage, profilePage, groupsPage, settingsPage } from './src/views.js';

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

test('pollPage: you first, then everyone A to Z', () => {
  const members = [
    { id: 1, name: 'Zoé' }, { id: 2, name: 'bob' }, { id: 3, name: 'Keven' }, { id: 4, name: 'Élodie' },
  ];
  const page = pollPage({ id: 3, name: 'Keven' }, { poll: { id: 1, title: 't' }, dates: ['2026-09-29'], members,
    votes: [], missing: [], complete: false, best: [], event: null });
  assert.deepEqual(page.match(/<tr><td>[^<]+/g).map(cell => cell.slice(8)), ['Keven (you)', 'bob', 'Élodie', 'Zoé']);
  assert.match(page, /<th class="">29 Sept\. 2026<\/th>/);
});

test('isValidWeekStart: only Saturday, Sunday and Monday', () => {
  for (const day of [6, 0, 1]) {
    assert.equal(isValidWeekStart(day), true);
  }
  for (const day of [2, 3, 4, 5, 7, -1, NaN, '0']) {
    assert.equal(isValidWeekStart(day), false, String(day));
  }
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

test('eventPage: a new event starts blank on the default color, with nothing to delete', () => {
  const page = eventPage({ id: 1, name: 'a' }, { event: { date: '2026-10-03' } });
  assert.match(page, /<form method="post" action="\/events" class="stack">/);
  assert.match(page, /name="date" required value="2026-10-03"/);
  assert.match(page, /value="" aria-label="Default" checked>/);
  assert.match(page, /name="all_day" value="1" id="all-day" checked>/, 'a new event starts all day');
  assert.equal((page.match(/ checked>/g) || []).length, 3, 'only the default color, All day and Public');
  assert.doesNotMatch(page, /delete/);
});

test('eventPage: All day is ticked for an event without a start time, or as a rejected form posted it', () => {
  const timed = { id: 7, title: 'Dinner', date: '2026-10-03', end_date: '2026-10-03', start_time: '19:00' };
  assert.match(eventPage({ id: 1 }, { event: timed }), /id="all-day">/, 'a timed event is not all day');
  assert.match(eventPage({ id: 1 }, { event: { ...timed, start_time: null } }), /id="all-day" checked>/);
  assert.match(eventPage({ id: 1 }, { event: { ...timed, start_time: null, allDay: false } }), /id="all-day">/,
    'unticked and sent back without a time: stays unticked so the time error shows');
});

test('eventPage: public by default; a private event ticks the groups it is shared with', () => {
  const groups = [{ id: 1, name: 'Climbers', color: 3 }, { id: 2, name: 'Board games', color: 5 }];
  const fresh = eventPage({ id: 1 }, { event: { date: '2026-10-03' }, groups });
  assert.match(fresh, /value="public" checked>/);
  assert.match(fresh, /name="group_ids" value="1">/, 'every group offered, none ticked');
  assert.match(fresh, /name="group_ids" value="2">/);
  const shared = eventPage({ id: 1 }, { event: { date: '2026-10-03', is_private: 1, groupIds: [2] }, groups });
  assert.match(shared, /value="private" id="visibility-private" checked>/);
  assert.match(shared, /name="group_ids" value="1">/);
  assert.match(shared, /name="group_ids" value="2" checked>/);
  assert.match(eventPage({ id: 1 }, { event: { date: '2026-10-03' } }), /Not in any <a href="\/groups">group<\/a>/);
});

test('eventPage: editing shows the saved values and color, and offers delete', () => {
  const event = {
    id: 7, title: 'Trip', date: '2026-10-03', end_date: '2026-10-05', start_time: '18:00', end_time: '14:00', color: 4,
  };
  const page = eventPage({ id: 1, name: 'a' }, { event, errors: { end: 'Oops' } });
  assert.match(page, /action="\/events\/7" class="stack"/);
  assert.match(page, /value="Trip"/);
  assert.match(page, /name="end_date" aria-label="End date" value="2026-10-05"/);
  assert.match(page, /name="end_time" aria-label="End time" value="14:00"/);
  assert.match(page, /value="4" aria-label="Color 5" checked>/);
  assert.equal((page.match(/ checked>/g) || []).length, 2, 'its color, and Public');
  assert.match(page, /action="\/events\/7\/delete"/);
  // a form error sits right under the field it is about, not on a page of its own
  assert.match(page, /value="14:00">\s*<\/span>\s*<\/label>\s*<p class="err">Oops<\/p>/);
  assert.equal((page.match(/class="err"/g) || []).length, 1, 'only the field in error');
  // a one-day event shows no end date, so moving its start does not strand the end
  assert.match(eventPage({ id: 1 }, { event: { ...event, end_date: event.date } }),
    /name="end_date" aria-label="End date" value=""/);
});

// The no-JS fallback and the hook public/app.js keys off of.
test('newPollPage renders 6 date rows inside .dates', () => {
  const page = newPollPage({ name: 'a', id: 1 });
  assert.equal(page.match(/<input type="date" name="dates">/g).length, 6);
  assert.match(page, new RegExp(`<fieldset class="stack dates" data-max="${MAX_DATES}">`));
});

// ---- passkeys ----
// The whole trust boundary of passkey login: every one of these checks is what stops a forged
// or replayed assertion from logging someone in.

test('verifyWebAuthn accepts a genuine assertion and rejects every tampered one', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const challenge = 'Zm9vYmFyLWNoYWxsZW5nZQ';

  // authenticator data: rpIdHash(32) + flags(1, UP set) + sign counter(4)
  const authData = (rpId = RP_ID, flags = 0x01) => Buffer.concat([
    createHash('sha256').update(rpId).digest(),
    Buffer.from([flags]),
    Buffer.alloc(4),
  ]);
  const clientData = (overrides = {}) => Buffer.from(JSON.stringify(
    { type: 'webauthn.get', challenge, origin: ORIGIN, ...overrides }));

  const assertion = (over = {}) => {
    const authenticatorData = over.authenticatorData ?? authData();
    const clientDataJSON = over.clientDataJSON ?? clientData();
    return {
      clientDataJSON,
      authenticatorData,
      signature: over.signature ?? sign('sha256', Buffer.concat(
        [authenticatorData, createHash('sha256').update(clientDataJSON).digest()]), privateKey),
      publicKey: spki,
      alg: -7,
      type: 'webauthn.get',
      challenge,
    };
  };

  assert.equal(verifyWebAuthn(assertion()), true);

  // Each of these is a real attack, and each must fail on its own.
  assert.equal(verifyWebAuthn({ ...assertion(), challenge: 'some-other-challenge' }), false, 'replayed challenge');
  const rejected = (input, why) => assert.equal(verifyWebAuthn(input), false, why);
  rejected(assertion({ clientDataJSON: clientData({ origin: 'https://evil.example' }) }), 'phishing origin');
  rejected(assertion({ clientDataJSON: clientData({ crossOrigin: true }) }), 'cross-origin iframe');
  rejected({ ...assertion(), type: 'webauthn.create' }, 'registration passed off as a login');
  rejected(assertion({ authenticatorData: authData('evil.example') }), 'wrong relying party');
  rejected(assertion({ authenticatorData: authData(RP_ID, 0x00) }), 'user presence flag clear');
  assert.equal(verifyWebAuthn(assertion({ signature: Buffer.alloc(70) })), false, 'forged signature');
  assert.equal(verifyWebAuthn({ ...assertion(), publicKey: Buffer.alloc(0) }), false, 'unparseable key');
  assert.equal(verifyWebAuthn({ ...assertion(), clientDataJSON: Buffer.from('not json') }), false, 'junk client data');

  // A signature over a different authenticator data must not carry over to this one.
  const other = assertion();
  assert.equal(verifyWebAuthn({ ...assertion(), signature: sign('sha256', Buffer.from('x'), privateKey) }), false,
    'signature over other data');
  assert.equal(verifyWebAuthn(other), true, 'still valid untouched');

  // Registration has no signature to check (attestation "none"), but the other checks still apply.
  const registration = { ...assertion(), signature: undefined, type: 'webauthn.create',
    clientDataJSON: clientData({ type: 'webauthn.create' }) };
  assert.equal(verifyWebAuthn(registration), true);
  assert.equal(verifyWebAuthn({ ...registration, challenge: 'wrong' }), false);
});

test('log line: time, ip, user (real or not), action; user input cannot forge a line', async () => {
  const { formatLogLine } = await import('./src/log.js');
  assert.match(formatLogLine({ ip: '1.2.3.4', user: 'alice', known: true, action: 'login ok (password)' }),
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d-0[45]:00 ip=1\.2\.3\.4 user="alice" action=login ok \(password\)\n$/);
  assert.match(formatLogLine({ ip: '1.2.3.4', user: 'mallory', known: false, action: 'x' }),
    / user="mallory" \(unknown\) /);
  assert.match(formatLogLine({ ip: '1.2.3.4', action: 'x' }), / user=- /);
  const forged = formatLogLine({ ip: '1.2.3.4\n9.9.9.9', user: 'a\n2026 ip=6.6.6.6', known: false, action: 'x' });
  assert.equal(forged.split('\n').length, 2, 'exactly one line plus the trailing newline');
});

test('log times are Eastern, following daylight saving', async () => {
  const { localTimestamp, parseLogLine } = await import('./src/log.js');
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

test('parseLogLine reads back what formatLogLine wrote, even with a hostile name', async () => {
  const { formatLogLine, parseLogLine } = await import('./src/log.js');
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

test('login limiter is keyed per client and per account, not global', async () => {
  const { loginAllowed, loginFailed } = await import('./src/auth.js');
  for (let i = 0; i < 20; i++) {
    loginFailed('10.0.0.1', 'nobody');
  }
  assert.equal(loginAllowed('10.0.0.1', 'alice'), false, 'the flooding client is blocked');
  assert.equal(loginAllowed('10.0.0.2', 'alice'), true, 'everyone else still logs in');
  for (let i = 0; i < 10; i++) {
    loginFailed('10.0.0.' + (10 + i), 'bob');
  }
  assert.equal(loginAllowed('10.0.0.99', 'bob'), false, 'a targeted account locks across clients');
  assert.equal(loginAllowed('10.0.0.99', 'Bob'), false, 'case-insensitive, like the name column');
  assert.equal(loginAllowed('10.0.0.99', 'carol'), true);
});

test('isValidDate: old dates and leap days (birthdays)', () => {
  assert.ok(isValidDate('1990-05-17'));
  assert.ok(isValidDate('2000-02-29'));
  assert.ok(!isValidDate('1990-02-30'));
  assert.ok(!isValidDate('1990-5-17'));
  assert.ok(!isValidDate(''));
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

// ---- templates ----

// Names and titles are typed by members: they must reach the page as text, never as markup.
test('pages escape what members typed', () => {
  const members = [{ id: 1, name: '<script>alert(1)</script>' }];
  const page = pollPage({ id: 2, name: 'x' }, { poll: { id: 1, title: 'A & "B"' }, dates: ['2026-09-29'], members,
    votes: [], missing: [], complete: false, best: [], event: null });
  assert.doesNotMatch(page, /<script>alert/);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;/);
  assert.match(page, /<h1>A &amp; &quot;B&quot;<\/h1>/);
});

test('profilePage: a rejected form keeps what was typed and opens the panel holding the error', () => {
  const user = { id: 1, name: 'Ada', color: 2, birthday: null, date_format: undefined };
  const page = profilePage(user, {
    passkeys: [],
    errors: { birthday: 'Invalid date.', password: 'Too short.' },
    about: { name: 'Ada L', birthday: '2999-01-01', color: 5 },
  });
  assert.match(page, /value="Ada L"/);
  assert.match(page, /aria-label="Birthday">\s*<p class="err">Invalid date\.<\/p>/);
  assert.match(page, /value="5" aria-label="Color"/);
  assert.match(page, /<details class="panel panel-security" open data-remember="profile-security">/);
  assert.match(page, /autocomplete="new-password">\s*<\/label>\s*<p class="err">Too short\.<\/p>/);
});

test('profilePage: the privacy radio matches the account, private by default', () => {
  const user = { id: 1, name: 'Ada', color: 2, birthday: null };
  assert.match(profilePage({ ...user, is_private: 1 }, { passkeys: [] }), /value="private" checked>/);
  assert.match(profilePage({ ...user, is_private: 0 }, { passkeys: [] }), /value="public" checked>/);
});

test('groupsPage: managers get Rename / remove / Delete, only admins get Add directly', () => {
  const group = canManage => ({
    id: 7, name: 'Climbers', creator: 'Ada', canManage, color: 4,
    members: [{ id: 1, name: 'Ada', color: 0 }, { id: 2, name: 'Bob', color: 1 }],
    invited: [{ id: 3, name: 'Cy' }],
    invitable: [{ id: 4, name: 'Di' }],
  });
  const render = (user, canManage) =>
    groupsPage(user, { groups: [group(canManage)], invites: [], base: 'https://x.test' });

  const manager = render({ id: 1, is_admin: 0, feed_token: 'tok' }, true);
  assert.match(manager, /value="https:\/\/x\.test\/feed\/tok\/groups\/7\.ics" readonly/, 'my own feed link');
  assert.match(manager, /data-copy="https:\/\/x\.test\/feed\/tok\/groups\/7\.ics" hidden>Copy/);
  assert.match(manager, /<details class="panel panel-group c4" open data-remember="group-7">/,
    'own color, open, remembered');
  const rejected = groupsPage({ id: 1 }, { groups: [group(true)], invites: [], errors: { 7: 'Nope.' } });
  // app.js never folds a panel showing an error from memory, so the error text is what matters here
  assert.match(rejected, /data-remember="group-7">[\s\S]*<p class="err">Nope\.<\/p>/, 'the error shows in its group');
  assert.match(manager, /action="\/groups\/7\/rename"/);
  assert.match(manager, /action="\/groups\/7\/members\/2\/remove"/, 'the group id, then the member id');
  assert.doesNotMatch(manager, /members\/1\/remove/, 'a manager leaves, they do not remove themselves');
  assert.match(manager, /action="\/groups\/7\/invites\/3\/cancel"/);
  assert.match(manager, /action="\/groups\/7\/delete"/);
  assert.doesNotMatch(manager, /Add directly/);

  const member = render({ id: 2, is_admin: 0 }, false);
  assert.doesNotMatch(member, /rename|remove"|cancel"|\/delete"/);
  assert.match(member, /action="\/groups\/7\/invite"/, 'every member can invite');
  assert.match(member, /action="\/groups\/7\/leave"/);

  assert.match(render({ id: 1, is_admin: 1 }, true), /formaction="\/groups\/7\/add">Add directly/);
});

test('groupsPage: Next event, Last event when none is coming, and a placeholder when there never was one', () => {
  const group = headlineEvent => ({
    id: 7, name: 'Climbers', creator: 'Ada', canManage: false, color: 1,
    members: [], invited: [], invitable: [], headlineEvent,
  });
  const render = headlineEvent => groupsPage({ id: 1 }, { groups: [group(headlineEvent)], invites: [], base: '' });
  const event = { title: 'Crag day', date: '2026-11-14', end_date: '2026-11-14', start_time: null, creator: 'Bob' };

  const next = render(event);
  assert.match(next, /<h3>Next event<\/h3>\s*<p>\s*<b>Crag day<\/b> — /);
  assert.match(next, /by Bob/);
  assert.match(next, /href="\/\?m=2026-11&amp;g=7">see it on the calendar/, "the group's own view, that month");

  assert.match(render({ ...event, isLast: true }), /<h3>Last event<\/h3>\s*<p>\s*<b>Crag day<\/b>/);

  const none = render(undefined);
  assert.match(none, /<h3>Next event<\/h3>\s*<p class="hint">No event yet<\/p>/);
});

test('settingsPage: one feed per group I am in, with Copy and webcal, and the birthdays feed', () => {
  const user = { id: 1, feed_token: 'tok', week_start: 0, date_format: undefined, show_birthdays: 1 };
  const page = settingsPage(user, { base: 'https://x.test', groups: [{ id: 7, name: 'Climbers' }] });
  assert.match(page, /<b>Climbers<\/b> \(group events\)/);
  assert.match(page, /data-copy="https:\/\/x\.test\/feed\/tok\/groups\/7\.ics" hidden>Copy/);
  assert.match(page, /href="webcal:\/\/x\.test\/feed\/tok\/groups\/7\.ics"/);
  assert.match(page, /data-copy="https:\/\/x\.test\/feed\/tok\/birthdays\.ics" hidden>Copy/, 'same box and button');
  assert.ok(page.indexOf('birthdays.ics') < page.indexOf('groups/7.ics'), 'birthdays first');
  assert.doesNotMatch(page, /events\.ics/, 'no all-events feed any more');
  assert.match(settingsPage(user, { base: 'https://x.test' }), /each <a href="\/groups">group<\/a> you are in/);
});

// Security review: an empty name must not share one counter that blocks everyone's passkey login.
test('login limiter: failures with no name cannot block passkey login for others', async () => {
  const { loginAllowed, loginFailed } = await import('./src/auth.js');
  for (let i = 0; i < 10; i++) {
    loginFailed('10.9.0.' + i, ''); // ten clients, under the per-client limit, all with an empty name
  }
  assert.equal(loginAllowed('10.9.1.1'), true, 'the passkey options request from someone else still passes');
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
