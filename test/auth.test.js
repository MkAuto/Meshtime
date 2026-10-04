import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { verifyWebAuthn, RP_ID, ORIGIN } from '../src/lib.js';
import { loginAllowed, loginFailed } from '../src/auth.js';

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

// ---- login limiter ----
// Both tests share the module's counters, so each uses its own IP range.

test('login limiter is keyed per client and per account, not global', () => {
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

// Security review: an empty name must not share one counter that blocks everyone's passkey login.
test('login limiter: failures with no name cannot block passkey login for others', () => {
  for (let i = 0; i < 10; i++) {
    loginFailed('10.9.0.' + i, ''); // ten clients, under the per-client limit, all with an empty name
  }
  assert.equal(loginAllowed('10.9.1.1'), true, 'the passkey options request from someone else still passes');
});
