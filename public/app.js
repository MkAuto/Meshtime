// Forms with data-confirm ask before submitting (CSP forbids inline onsubmit). Without JS they just submit.
for (const form of document.querySelectorAll('form[data-confirm]'))
  form.addEventListener('submit', event => { if (!confirm(form.dataset.confirm)) event.preventDefault(); });

// Live preview of the color slider in Settings.
const hue = document.querySelector('.hue'), swatch = document.getElementById('swatch');
if (hue && swatch) hue.addEventListener('input', () => { swatch.className = `c${hue.value} swatch`; });

// Calendar. A tap or a single click submits the day's form as-is: free all day, or clear it.
// Holding the day (touch) or double-clicking it (mouse) opens the #day-part menu instead, to pick
// morning / afternoon / all day / not free. Right-click and the keyboard's menu key open it too.
// Without JS only the plain toggle exists.
const partMenu = document.getElementById('day-part');
if (partMenu) {
  const LONG_PRESS_MS = 500;
  const DOUBLE_CLICK_MS = 300;
  const choiceForm = partMenu.querySelector('form');

  const openMenu = day => {
    choiceForm.elements.date.value = day.form.elements.date.value;
    partMenu.querySelector('h2').textContent = day.dataset.dateLabel;
    for (const choice of choiceForm.querySelectorAll('button[name=part]'))
      choice.classList.toggle('current', choice.value === day.dataset.part);
    if (!partMenu.open) partMenu.showModal();
  };

  let pointerType = 'mouse';
  let pressTimer, clickTimer;
  let menuOpenedByPress = false; // the finger lifting after a long press must not also toggle the day

  for (const day of document.querySelectorAll('.day button')) {
    day.addEventListener('pointerdown', event => {
      pointerType = event.pointerType;
      menuOpenedByPress = false;
      if (pointerType !== 'touch') return;
      pressTimer = setTimeout(() => { menuOpenedByPress = true; openMenu(day); }, LONG_PRESS_MS);
    });
    // Lifting the finger early, or starting to scroll (pointercancel), is not a long press.
    for (const type of ['pointerup', 'pointercancel']) day.addEventListener(type, () => clearTimeout(pressTimer));

    // Android sends contextmenu on a long press, desktops on right-click / the menu key.
    day.addEventListener('contextmenu', event => {
      event.preventDefault();
      clearTimeout(pressTimer);
      if (pointerType === 'touch') menuOpenedByPress = true;
      openMenu(day);
    });

    day.addEventListener('click', event => {
      if (menuOpenedByPress) return event.preventDefault();
      if (pointerType === 'touch' || event.detail === 0) return; // a tap, or Enter / Space: submit now
      // Mouse: hold the submit briefly, since this click may be the first half of a double-click.
      event.preventDefault();
      clearTimeout(clickTimer);
      if (event.detail >= 2) return openMenu(day);
      clickTimer = setTimeout(() => day.form.submit(), DOUBLE_CLICK_MS);
    });
  }
}


const dates = document.querySelector('.dates');
if (dates) {
  const rows = () => dates.querySelectorAll('input');
  for (const extra of [...rows()].slice(1)) extra.remove();
  dates.addEventListener('focusin', event => {
    const last = dates.lastElementChild;
    // cloneNode copies the value (spec: input cloning propagates value + dirty flag), so blank it.
    if (event.target === last && rows().length < Number(dates.dataset.max))
      dates.append(Object.assign(last.cloneNode(), { value: '' }));
  });
}


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
  const options = await postJson('/profile/passkeys/options');
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

  await postJson('/profile/passkeys', {
    id: credential.id,
    publicKey: toBase64url(publicKey),
    alg: response.getPublicKeyAlgorithm(),
    label,
    challenge: options.challenge,
    clientDataJSON: toBase64url(response.clientDataJSON),
    authenticatorData: toBase64url(response.getAuthenticatorData()),
  });
  location.href = '/profile?msg=passkey';
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
