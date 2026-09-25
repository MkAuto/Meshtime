import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { isValidDate, bestDates, fold, buildIcs, dayClass, MAX_DATES, verifyWebAuthn, RP_ID, ORIGIN } from './src/lib.js';
import { newPollPage } from './src/views.js';

const thisYear = new Date().getUTCFullYear();

test('isValidDate', () => {
  assert.equal(isValidDate(`${thisYear}-02-28`), true);
  assert.equal(isValidDate(`${thisYear}-02-30`), false);
  assert.equal(isValidDate(`${thisYear}-13-01`), false);
  assert.equal(isValidDate(`${thisYear}-2-1`), false);
  assert.equal(isValidDate(`${thisYear + 3}-01-01`), false);
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
  assert.deepEqual(bestDates(['2026-10-01', '2026-10-02'], [{ date: '2026-10-01', answer: 'maybe' }]), ['2026-10-01', '2026-10-02']);
  assert.deepEqual(bestDates([], []), []);
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

test('dayClass: all = every member free, mine = I am free', () => {
  assert.equal(dayClass({ who: ['a', 'b'], members: 2, mine: true }), 'all mine');
  assert.equal(dayClass({ who: ['a'], members: 2, mine: false }), '');
  assert.equal(dayClass({ who: [], members: 0, mine: false }), '');
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
  assert.equal(verifyWebAuthn(assertion({ clientDataJSON: clientData({ origin: 'https://evil.example' }) })), false, 'phishing origin');
  assert.equal(verifyWebAuthn(assertion({ clientDataJSON: clientData({ crossOrigin: true }) })), false, 'cross-origin iframe');
  assert.equal(verifyWebAuthn({ ...assertion(), type: 'webauthn.create' }), false, 'registration passed off as a login');
  assert.equal(verifyWebAuthn(assertion({ authenticatorData: authData('evil.example') })), false, 'wrong relying party');
  assert.equal(verifyWebAuthn(assertion({ authenticatorData: authData(RP_ID, 0x00) })), false, 'user presence flag clear');
  assert.equal(verifyWebAuthn(assertion({ signature: Buffer.alloc(70) })), false, 'forged signature');
  assert.equal(verifyWebAuthn({ ...assertion(), publicKey: Buffer.alloc(0) }), false, 'unparseable key');
  assert.equal(verifyWebAuthn({ ...assertion(), clientDataJSON: Buffer.from('not json') }), false, 'junk client data');

  // A signature over a different authenticator data must not carry over to this one.
  const other = assertion();
  assert.equal(verifyWebAuthn({ ...assertion(), signature: sign('sha256', Buffer.from('x'), privateKey) }), false, 'signature over other data');
  assert.equal(verifyWebAuthn(other), true, 'still valid untouched');

  // Registration has no signature to check (attestation "none"), but the other checks still apply.
  const registration = { ...assertion(), signature: undefined, type: 'webauthn.create',
    clientDataJSON: clientData({ type: 'webauthn.create' }) };
  assert.equal(verifyWebAuthn(registration), true);
  assert.equal(verifyWebAuthn({ ...registration, challenge: 'wrong' }), false);
});
