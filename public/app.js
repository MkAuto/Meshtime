// Forms with data-confirm ask before submitting (CSP forbids inline onsubmit). Without JS they just submit.
for (const form of document.querySelectorAll('form[data-confirm]'))
  form.addEventListener('submit', event => { if (!confirm(form.dataset.confirm)) event.preventDefault(); });

// Live preview of the color slider in Settings.
const hue = document.querySelector('.hue'), swatch = document.getElementById('swatch');
if (hue && swatch) hue.addEventListener('input', () => { swatch.className = `c${hue.value} swatch`; });

// New poll: collapse the server-rendered rows to one, grow a fresh one each time the last is filled,
// up to data-max (MAX_DATES in src/lib.js, also enforced on POST). Without JS the 6 static rows stay.
const dates = document.querySelector('.dates');
if (dates) {
  const rows = () => dates.querySelectorAll('input');
  for (const extra of [...rows()].slice(1)) extra.remove();
  dates.addEventListener('input', () => {
    const last = dates.lastElementChild;
    // cloneNode copies the value (spec: input cloning propagates value + dirty flag), so blank it.
    if (last.value && rows().length < Number(dates.dataset.max))
      dates.append(Object.assign(last.cloneNode(), { value: '' }));
  });
}

// Passkeys. Both flows are the same shape: ask the server for a challenge, hand it to the
// authenticator, post back what it signed. The buttons start hidden and are only revealed on a
// browser that can do WebAuthn, so nothing dead is ever shown and the password form still works.

const toBase64url = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer)))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

const fromBase64url = value =>
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));

/** Posts a form-encoded body and returns the parsed JSON, throwing the server's message on failure. */
async function postJson(url, fields = {}) {
  const response = await fetch(url, { method: 'POST', body: new URLSearchParams(fields) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

/** Reveals a hidden "<p><button><span class=err>" block and runs `action` when the button is clicked. */
function onPasskeyButton(id, action) {
  const holder = document.getElementById(id);
  if (!holder || !window.PublicKeyCredential) return;
  holder.hidden = false;

  const button = holder.querySelector('button');
  const error = holder.querySelector('.err');
  button.addEventListener('click', async event => {
    event.preventDefault();
    error.textContent = '';
    button.disabled = true;
    try {
      await action();
    } catch (err) {
      // NotAllowedError is the user dismissing the system prompt; that needs no error message.
      if (err.name !== 'NotAllowedError') error.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
}

onPasskeyButton('passkey-add', async () => {
  const options = await postJson('/settings/passkeys/options');
  const label = prompt('Name this passkey', 'My device');
  if (label === null) return;

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: fromBase64url(options.challenge),
      rp: { id: options.rpId, name: 'Meshtime' },
      user: { id: new TextEncoder().encode(options.userId), name: options.name, displayName: options.name },
      pubKeyCredParams: [-7, -257, -8].map(alg => ({ type: 'public-key', alg })),
      // A discoverable credential is what lets the login button work without typing a name first.
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: options.exclude.map(id => ({ type: 'public-key', id: fromBase64url(id) })),
    },
  });

  const response = credential.response;
  const publicKey = response.getPublicKey();
  if (!publicKey) throw new Error('This browser cannot export the passkey. Try another one.');

  await postJson('/settings/passkeys', {
    id: credential.id,
    publicKey: toBase64url(publicKey),
    alg: response.getPublicKeyAlgorithm(),
    label,
    challenge: options.challenge,
    clientDataJSON: toBase64url(response.clientDataJSON),
    authenticatorData: toBase64url(response.getAuthenticatorData()),
  });
  location.href = '/settings?msg=passkey';
});

onPasskeyButton('passkey-login', async () => {
  const options = await postJson('/login/passkey/options');
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: fromBase64url(options.challenge),
      rpId: options.rpId,
      userVerification: 'preferred',
    },
  });

  await postJson('/login/passkey', {
    id: credential.id,
    challenge: options.challenge,
    clientDataJSON: toBase64url(credential.response.clientDataJSON),
    authenticatorData: toBase64url(credential.response.authenticatorData),
    signature: toBase64url(credential.response.signature),
  });
  location.href = '/';
});
