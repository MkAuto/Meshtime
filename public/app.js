// The server writes times the way this device does, 19:00 or 7:00 PM (formatTime in lib.js): it reads this
// cookie. Set on every page, the login page included, so it is there before any time is shown.
const hour12 = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12;
document.cookie = `hour12=${hour12 ? 1 : 0}; Path=/; Max-Age=31536000; SameSite=Lax`;

// Forms with data-confirm ask before submitting (CSP forbids inline onsubmit). Without JS they just submit.
for (const form of document.querySelectorAll('form[data-confirm]')) {
  form.addEventListener('submit', event => {
    if (!confirm(form.dataset.confirm)) {
      event.preventDefault();
    }
  });
}

// Checkboxes with data-confirm-on / data-confirm-off ask before their form is saved, but only when the box
// was changed: ticked asks data-confirm-on, unticked data-confirm-off. Saving the rest of the form never asks.
for (const box of document.querySelectorAll('input[data-confirm-on]')) {
  box.form.addEventListener('submit', event => {
    if (box.checked === box.defaultChecked) {
      return;
    }
    if (!confirm(box.checked ? box.dataset.confirmOn : box.dataset.confirmOff)) {
      event.preventDefault();
    }
  });
}

// Live preview of the color slider in Settings.
const hue = document.querySelector('.hue'), swatch = document.getElementById('swatch');
if (hue && swatch) {
  hue.addEventListener('input', () => { swatch.className = `c${hue.value} swatch`; });
}

// Folding panels with data-remember (settings, profile, groups) reopen the way you
// last left them: open or closed, per panel, in this browser (localStorage). Until you touch one, the
// page's own default stands. A panel showing an error message is never folded from memory, or the message
// would be hidden. Storage can be blocked (private windows): then every page just uses its defaults.
const PANEL_STATE_KEY = 'panelState'; // { [data-remember]: true when open }
const rememberedPanels = document.querySelectorAll('details[data-remember]');
if (rememberedPanels.length) {
  let panelState;
  try {
    panelState = JSON.parse(localStorage.getItem(PANEL_STATE_KEY)) || {};
  } catch {
    panelState = {};
  }
  for (const panel of rememberedPanels) {
    const key = panel.dataset.remember;
    const showsError = [...panel.querySelectorAll('.err')].some(error => error.textContent.trim());
    if (key in panelState && !showsError) {
      panel.open = panelState[key];
    }
    panel.addEventListener('toggle', () => {
      panelState[key] = panel.open;
      try {
        localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(panelState));
      } catch {
        // storage blocked or full: the panel still folds, it just will not be remembered
      }
    });
  }
}

// A link to a folded panel (e.g. Groups → /settings#subscribe-help) unfolds it and every panel around it, whatever
// was remembered, then scrolls to it: the browser already tried to scroll while it was still folded.
// A ternary, not &&: with no hash, && would give '' and ''?.matches() throws, stopping the rest of this file.
const linkedPanel = location.hash ? document.getElementById(location.hash.slice(1)) : null;
if (linkedPanel?.matches('details')) {
  for (let panel = linkedPanel; panel; panel = panel.parentElement.closest('details')) {
    panel.open = true;
  }
  linkedPanel.scrollIntoView();
}

// Copy buttons (data-copy: the text to copy) start hidden, since they need JS and a secure page (https or
// localhost) for the clipboard. Without either, the link next to them can still be selected and copied.
// data-copied / data-copy-failed: what the button says for a moment after, in the page's language.
if (navigator.clipboard) {
  for (const button of document.querySelectorAll('button[data-copy]')) {
    button.hidden = false;
    button.addEventListener('click', async () => {
      const label = button.textContent;
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        button.textContent = button.dataset.copied;
      } catch {
        button.textContent = button.dataset.copyFailed;
      }
      setTimeout(() => { button.textContent = label; }, 1500);
    });
  }
}

// Forms with data-autosubmit (the calendar's group picker) apply a new choice at once; their button is
// only there for when JS is off.
for (const form of document.querySelectorAll('form[data-autosubmit]')) {
  form.querySelector('button').hidden = true;
  form.addEventListener('change', () => form.submit());
}

// Calendar. A tap or a single click submits the day's form as-is: free all day, or clear it.
// Holding the day (touch) or double-clicking it (mouse) opens the #day-part menu instead, to pick
// morning / afternoon / evening / all day / not free, or Automatic (with a calendar connected: Calendar
// Integration decides the day again). Right-click and the keyboard's menu key open it too.
// The slots toggle: opening the menu again on a day free in the morning adds the afternoon or evening
// (up to MAX_SLOTS_PER_DAY, as in src/lib.js, which the server enforces too).
// Without JS only the plain toggle exists.
const partMenu = document.getElementById('day-part');
if (partMenu) {
  const LONG_PRESS_MS = 500;
  const DOUBLE_CLICK_MS = 300;
  const MAX_SLOTS_PER_DAY = 2;
  const WHOLE_DAY_CHOICES = ['all', 'none', 'auto'];
  const choiceForm = partMenu.querySelector('form');

  const openMenu = day => {
    choiceForm.elements.date.value = day.form.elements.date.value;
    partMenu.querySelector('h2').textContent = day.dataset.dateLabel;
    const parts = day.dataset.parts.split(' ');
    const slotsPicked = parts.filter(part => !WHOLE_DAY_CHOICES.includes(part)).length;
    for (const choice of choiceForm.querySelectorAll('button[name=part]')) {
      const isCurrent = parts.includes(choice.value);
      const isSlot = !WHOLE_DAY_CHOICES.includes(choice.value);
      choice.classList.toggle('current', isCurrent);
      choice.disabled = isSlot && !isCurrent && slotsPicked >= MAX_SLOTS_PER_DAY;
    }
    if (!partMenu.open) {
      partMenu.showModal();
    }
  };

  let pointerType = 'mouse';
  let pressTimer, clickTimer;
  let menuOpenedByPress = false; // the finger lifting after a long press must not also toggle the day

  for (const day of document.querySelectorAll('.day button')) {
    day.addEventListener('pointerdown', event => {
      pointerType = event.pointerType;
      menuOpenedByPress = false;
      if (pointerType !== 'touch') {
        return;
      }
      pressTimer = setTimeout(() => { menuOpenedByPress = true; openMenu(day); }, LONG_PRESS_MS);
    });
    // Lifting the finger early, or starting to scroll (pointercancel), is not a long press.
    for (const type of ['pointerup', 'pointercancel']) {
      day.addEventListener(type, () => clearTimeout(pressTimer));
    }

    // Android sends contextmenu on a long press, desktops on right-click / the menu key.
    day.addEventListener('contextmenu', event => {
      event.preventDefault();
      clearTimeout(pressTimer);
      if (pointerType === 'touch') {
        menuOpenedByPress = true;
      }
      openMenu(day);
    });

    day.addEventListener('click', event => {
      if (menuOpenedByPress) {
        return event.preventDefault();
      }
      if (pointerType === 'touch' || event.detail === 0) {
        return; // a tap, or Enter / Space: submit now
      }
      // Mouse: hold the submit briefly, since this click may be the first half of a double-click.
      event.preventDefault();
      clearTimeout(clickTimer);
      if (event.detail >= 2) {
        return openMenu(day);
      }
      clickTimer = setTimeout(() => day.form.submit(), DOUBLE_CLICK_MS);
    });
  }
}

const eventForm = document.querySelector('input[name=start_time]')?.form;
if (eventForm) {
  const { date: startDate, start_time: startTime, end_date: endDate, end_time: endTime } = eventForm.elements;
  const ONE_HOUR_MS = 60 * 60 * 1000;
  // UTC, so a daylight-saving change never adds or loses an hour here.
  const toMs = (date, time) => Date.parse(`${date}T${time}Z`);

  let previousStart = startTime.value;
  // input, not change: Firefox and Safari fire change on a time box only once it loses focus.
  startTime.addEventListener('input', () => {
    if (startTime.value && startDate.value) {
      const length = previousStart && endTime.value
        ? toMs(endDate.value || startDate.value, endTime.value) - toMs(startDate.value, previousStart)
        : ONE_HOUR_MS;
      const end = new Date(toMs(startDate.value, startTime.value) + length).toISOString(); // YYYY-MM-DDTHH:MM:...
      endTime.value = end.slice(11, 16);
      endDate.value = end.slice(0, 10) === startDate.value ? '' : end.slice(0, 10);
    }
    previousStart = startTime.value;
  });
}

// Event form: the location box's clear button empties it (style.css shows it only while there is text). Without JS
// it stays hidden, as it could do nothing.
const clearPlace = document.querySelector('.place-clear');
if (clearPlace) {
  const box = document.getElementById('location');
  clearPlace.hidden = false;
  clearPlace.addEventListener('click', () => {
    box.value = '';
    box.focus();
  });
}

const dates = document.querySelector('.dates');
if (dates) {
  const rows = () => dates.querySelectorAll('input');
  for (const extra of [...rows()].slice(1)) {
    extra.remove();
  }
  dates.addEventListener('focusin', event => {
    const last = dates.lastElementChild;
    // cloneNode copies the value (spec: input cloning propagates value + dirty flag), so blank it.
    if (event.target === last && rows().length < Number(dates.dataset.max)) {
      dates.append(Object.assign(last.cloneNode(), { value: '' }));
    }
  });
}


const toBase64url = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer)))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

const fromBase64url = value =>
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));

/** Posts a form-encoded body and returns the parsed JSON, throwing the server's message (or none) on failure. */
async function postJson(url, fields = {}) {
  const response = await fetch(url, {
    method: 'POST', body: new URLSearchParams(fields), headers: { Accept: 'application/json' },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error ?? '');
  }
  return data;
}

/**
 * Reveals a hidden "<p><button><span class=err>" block and runs `action` when the button is clicked, with the texts
 * the block carries in its data-* (the page's language): data-error is shown for an error that has no message.
 */
function onPasskeyButton(id, action) {
  const holder = document.getElementById(id);
  if (!holder || !window.PublicKeyCredential) {
    return;
  }
  holder.hidden = false;

  const button = holder.querySelector('button');
  const error = holder.querySelector('.err');
  button.addEventListener('click', async event => {
    event.preventDefault();
    error.textContent = '';
    button.disabled = true;
    try {
      await action(holder.dataset);
    } catch (err) {
      // NotAllowedError is the user dismissing the system prompt; that needs no error message.
      if (err.name !== 'NotAllowedError') {
        error.textContent = err.message || holder.dataset.error;
      }
    } finally {
      button.disabled = false;
    }
  });
}

// Forms with data-copy-link (invite and reset-password links, in Administration and Settings) copy the link they create. Browsers only allow the
// clipboard during the click, so the write starts right away with the link still on its way (a ClipboardItem
// takes a promise). Without JS or that API the form posts as usual and the page lists the link.
if (navigator.clipboard && window.ClipboardItem) {
  for (const form of document.querySelectorAll('form[data-copy-link]')) {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const link = postJson(form.action, Object.fromEntries(new FormData(form)));
      const linkText = link.then(data => new Blob([data.url], { type: 'text/plain' }));
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': linkText })]);
        location.href = `${location.pathname}?msg=invite_copied`;
      } catch {
        try {
          await link;
          location.href = `${location.pathname}?msg=invite`; // created, not copied: the page still lists it
        } catch {
          form.submit(); // not created (the member is gone...): post it plainly so the page shows why
        }
      }
    });
  }
}

onPasskeyButton('passkey-add', async texts => {
  const options = await postJson('/profile/passkeys/options');
  const label = prompt(texts.prompt, texts.defaultName);
  if (label === null) {
    return;
  }

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
  if (!publicKey) {
    throw new Error(texts.noExport);
  }

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

// The language menu (templates/language-menu.html) is a details element: a click outside it or Esc folds it.
const languageMenu = document.querySelector('.lang-menu');
if (languageMenu) {
  document.addEventListener('click', event => {
    if (!languageMenu.contains(event.target)) {
      languageMenu.open = false;
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      languageMenu.open = false;
    }
  });
}

// The nav link of the page we are on gets .active (style.css draws it as a pill).
document.querySelector(`nav a[href="${location.pathname}"]`)?.classList.add('active');
