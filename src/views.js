import { monthInfo, dayClass, ANSWERS, COLORS, MAX_DATES, MIN_PASSWORD } from './lib.js';

// ---- the html`` template tag ----
// Every interpolation is escaped, so untrusted text is safe by default. Wrap trusted
// markup in raw(); nested html`` results are already trusted. Arrays are joined with no
// separator, null / undefined / false render as nothing (handy for `cond && html`...``).

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

export const raw = s => new Raw(String(s));

function render(value) {
  if (value instanceof Raw) return value.s;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value == null || value === false) return '';
  return String(value).replace(/[&<>"']/g, char => ESC[char]);
}

export const html = (strings, ...values) =>
  new Raw(strings.reduce((out, string, i) => out + render(values[i - 1]) + string));

// ---- shared bits ----

/** "Ada Lovelace" -> "AL". Shown in calendar cells and as the color swatch. */
const initials = name => name.trim().split(/\s+/).map(word => word[0]).join('').slice(0, 2).toUpperCase();

// Confirmations, keyed by the ?msg= value the settings routes redirect with.
const MSGS = {
  rotated: 'Feed links rotated. Re-subscribe in your calendar apps.',
  password: 'Password changed.',
  invite: 'Link created (see below).',
  color: 'Color saved.',
  passkey: 'Passkey added.',
  passkey_removed: 'Passkey removed.',
};

/** The ?msg= confirmation and the inline error line, shared by Settings and Administration. */
const notices = (msg, error) => html`${MSGS[msg] && html`<p class="ok">${MSGS[msg]}</p>`}${error && html`<p class="err">${error}</p>`}`;

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Page shell: head, header with nav (only when logged in), and the body inside <main>. */
export function layout(title, user, body) {
  return '<!doctype html>' + html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Meshtime</title><link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script></head><body>
<header><a href="/" class="brand">Meshtime</a>${user ? html`<nav><a href="/">Calendar</a><a href="/polls">Polls</a><a href="/settings">Settings</a>${user.is_admin ? html`<a href="/admin">Administration</a>` : ''}
<form method="post" action="/logout"><button class="link">Log out (${user.name})</button></form></nav>` : ''}</header>
<main>${body}</main></body></html>`.s;
}

export const errorPage = (status, msg, user) => layout(`Error ${status}`, user, html`<h1>${status}</h1><p>${msg}</p><p><a href="/">Back to calendar</a></p>`);

// ---- auth pages ----

export const loginPage = error => layout('Log in', null, html`<h1>Log in</h1>${error && html`<p class="err">${error}</p>`}
<form method="post" action="/login" class="stack">
<label>Name <input name="name" required maxlength="40" autocomplete="username" autofocus></label>
<label>Password <input name="password" type="password" required autocomplete="current-password"></label>
<button>Log in</button></form>
<p id="passkey-login" hidden>or <button class="link">log in with a passkey</button> <span class="err"></span></p>
<p class="hint">No account? Ask a member for an invite link.</p>`);

// One page for both invite kinds: resetName is set only for a password-reset link,
// in which case the name is already known and the field is left out.
export const invitePage = (token, resetName, error) => layout(resetName ? 'Reset password' : 'Join', null, html`
<h1>${resetName ? `Reset password for ${resetName}` : 'Create your account'}</h1>${error && html`<p class="err">${error}</p>`}
<form method="post" action="/invite/${token}" class="stack">
${resetName ? '' : html`<label>Your name <input name="name" required maxlength="40" autocomplete="username" autofocus></label>`}
<label>Password (min ${MIN_PASSWORD} characters) <input name="password" type="password" required minlength="${MIN_PASSWORD}" autocomplete="new-password"></label>
<button>${resetName ? 'Set password' : 'Create account'}</button></form>`);

// ---- calendar ----

export function calendarPage(user, yearMonth, { free, mine, events, today, members }) {
  const month = monthInfo(yearMonth);

  // Blank cells so day 1 lands on its weekday, then one cell per day of the month.
  const cells = Array.from({ length: month.pad }, () => html`<div class="day pad"></div>`);
  for (let day = 1; day <= month.days; day++) {
    const date = `${yearMonth}-${String(day).padStart(2, '0')}`;
    const who = free.get(date) || [];
    const isFree = mine.has(date);
    const dayEvents = events.filter(event => event.date === date);
    // The whole cell is the toggle button: posting /free flips my own free/not-free.
    // Initials and events live inside it, as spans, so every pixel of the square is clickable
    // while each one keeps its own title tooltip on hover.
    cells.push(html`<div class="day ${dayClass({ who, members, mine: isFree })}${date === today ? ' today' : ''}">
<form method="post" action="/free"><input type="hidden" name="date" value="${date}"><input type="hidden" name="m" value="${yearMonth}">
<button title="${isFree ? 'Click: I am no longer free' : 'Click: I am free that day'}"><span class="num">${day}</span>
${who.length ? html`<span class="who">${who.map(member => html`<span class="c${member.color}" title="${member.name}">${initials(member.name)}</span>`)}</span>` : ''}
${dayEvents.map(event => html`<span class="ev" title="${event.title} (by ${event.creator})">${event.title}</span>`)}</button></form></div>`);
  }

  return layout(month.label, user, html`
<h1><a href="/?m=${month.prev}" title="Previous month">&lsaquo;</a> ${month.label} <a href="/?m=${month.next}" title="Next month">&rsaquo;</a></h1>
<p class="hint">Click a day to mark yourself free (outlined). Initials show who is free; green means everyone is.</p>
<div class="grid">${WEEKDAYS.map(name => html`<div class="dow">${name}</div>`)}${cells}</div>
<section><h2>Events this month</h2>
<ul class="events">${events.length ? events.map(event => html`<li>${event.date} — <b>${event.title}</b> <small class="hint">by ${event.creator}</small>
${event.created_by === user.id || user.is_admin ? html` <form method="post" action="/events/${event.id}/delete" class="inline"><input type="hidden" name="m" value="${yearMonth}"><button class="link danger">delete</button></form>` : ''}</li>`)
    : html`<li class="hint">No events this month.</li>`}</ul>
<form method="post" action="/events" class="row"><input type="hidden" name="m" value="${yearMonth}">
<input name="title" placeholder="Event title" required maxlength="100"><input type="date" name="date" required><button>Add event</button></form></section>`);
}

// ---- polls ----

export const pollsPage = (user, polls) => layout('Polls', user, html`<h1>Polls</h1>
<p><a class="btn" href="/polls/new">New poll</a></p>
<ul class="polls">${polls.length ? polls.map(poll => html`<li><a href="/polls/${poll.id}">${poll.title}</a>
<small>${poll.closed_at ? (poll.chosen_date ? `✓ ${poll.chosen_date}` : 'closed') : `open · ${poll.voters}/${poll.members} answered`}</small></li>`)
  : html`<li class="hint">No polls yet.</li>`}</ul>`);

// Six date rows are rendered server-side as the no-JS fallback; public/app.js collapses
// them to one and grows rows on demand, up to data-max.
export const newPollPage = (user, error) => layout('New poll', user, html`<h1>New poll</h1>${error && html`<p class="err">${error}</p>`}
<form method="post" action="/polls/new" class="stack">
<label>What for? <input name="title" required maxlength="100" placeholder="Board game night" autofocus></label>
<fieldset class="stack dates" data-max="${MAX_DATES}"><legend>Proposed dates (max ${MAX_DATES})</legend><noscript class="hint">Leave extras empty.</noscript>${[1, 2, 3, 4, 5, 6].map(() => html`<input type="date" name="dates">`)}</fieldset>
<button>Create poll</button></form>`);

// A grid of members × proposed dates: my row holds selects, everyone else's is read-only.
export function pollPage(user, { poll, dates, members, votes, missing, complete, best, event }) {
  const answers = {}; // user_id -> { date: answer }
  for (const vote of votes) (answers[vote.user_id] ??= {})[vote.date] = vote.answer;

  const answerOf = (memberId, date) => answers[memberId]?.[date];
  const myAnswers = answers[user.id] || {};
  const countAnswer = (date, answer) => votes.filter(vote => vote.date === date && vote.answer === answer).length;

  const isOpen = !poll.closed_at;
  const canManage = poll.created_by === user.id || user.is_admin;
  // The result only makes sense once everyone answered, or the poll was closed early.
  const showResult = (complete || !isOpen) && best.length > 0;

  return layout(poll.title, user, html`<h1>${poll.title}</h1>
<p class="hint">${isOpen ? (complete ? 'Everyone has answered.' : `Waiting for: ${missing.join(', ')}`) : 'Poll closed.'}</p>
<form method="post" action="/polls/${poll.id}"><table class="poll"><thead><tr><th></th>${dates.map(date => html`<th class="${showResult && best.includes(date) ? 'best' : ''}">${date}</th>`)}</tr></thead><tbody>
${members.map(member => html`<tr><td>${member.name}${member.id === user.id ? ' (you)' : ''}</td>${dates.map(date => html`<td>${member.id === user.id && isOpen
    ? html`<select name="v_${date}">${myAnswers[date] ? '' : html`<option value="" selected>—</option>`}${ANSWERS.map(answer => html`<option value="${answer}"${myAnswers[date] === answer ? raw(' selected') : ''}>${answer}</option>`)}</select>`
    : html`<span class="a ${answerOf(member.id, date) || 'none'}">${answerOf(member.id, date) || '–'}</span>`}</td>`)}</tr>`)}
<tr class="tot"><td>yes / maybe / no</td>${dates.map(date => html`<td>${countAnswer(date, 'yes')} / ${countAnswer(date, 'maybe')} / ${countAnswer(date, 'no')}</td>`)}</tr></tbody></table>
${isOpen ? html`<button>Save my answers</button>` : ''}</form>
${showResult ? html`<section class="result"><h2>Best date${best.length > 1 ? 's' : ''}: ${best.join(', ')}</h2>
${best.length > 1 ? html`<p class="hint">Tied on yes and no — pick the one you want.</p>` : ''}
${event ? html`<p>Added to the calendar as <b>${event.title}</b> on ${event.date}. <a href="/?m=${event.date.slice(0, 7)}">View</a></p>`
    : html`<div class="row">${best.map(date => html`<form method="post" action="/polls/${poll.id}/confirm"><input type="hidden" name="date" value="${date}"><button>Add ${date} to calendar</button></form>`)}</div>`}</section>` : ''}
${isOpen && canManage ? html`<p><form method="post" action="/polls/${poll.id}/close" class="inline"><button class="link danger">Close poll now</button></form></p>` : ''}`);
}

// ---- settings ----

export function settingsPage(user, { base, passkeys, msg, error }) {
  const feedUrl = kind => `${base}/feed/${user.feed_token}/${kind}.ics`;
  // webcal:// makes desktop calendar apps subscribe instead of downloading the file once.
  const asWebcal = url => url.replace(/^https?:\/\//, 'webcal://');
  const FEEDS = [['events', 'Group events'], ['free', 'Who is free']];

  // Each panel is a <details>: collapsing is native, needs no JS and survives with JS off.
  // ponytail: all closed on load; remembering which you opened would need localStorage.
  return layout('Settings', user, html`<h1>Settings</h1>${notices(msg, error)}
<details class="panel panel-feeds"><summary><h2>Calendar feeds</h2></summary>
<p class="hint">Private links: anyone who has one can read it. Rotating them requires re-subscribing.</p>
<ul class="feeds">${FEEDS.map(([kind, label]) => html`<li><b>${label}</b><br><code>${feedUrl(kind)}</code><br><a href="${asWebcal(feedUrl(kind))}">webcal link (Apple / Outlook desktop)</a></li>`)}</ul>
<details><summary>How to subscribe</summary><ul>
<li><b>Google Calendar</b> (web): Other calendars → + → From URL → paste the https link. Google refreshes every 12–24 h and cannot be forced.</li>
<li><b>Apple Calendar</b>: click the webcal link, or File → New Calendar Subscription. Choose a short auto-refresh interval.</li>
<li><b>Outlook</b> (web): Add calendar → Subscribe from web → paste the https link. Refreshes every few hours.</li></ul></details>
<form method="post" action="/settings/rotate-feed"><button class="danger">Rotate feed links</button></form></details>

<details class="panel panel-custom"><summary><h2>Customisation</h2></summary>
<h3>My color</h3>
<p class="hint">Your initials appear in this color on every day you mark yourself free.</p>
<form method="post" action="/settings/color" class="row">
<b class="c${user.color} swatch" id="swatch" title="Preview">${initials(user.name)}</b>
<input type="range" name="color" class="hue" min="0" max="${COLORS - 1}" value="${user.color}" aria-label="Color">
<button>Save color</button></form></details>

<details class="panel panel-security"><summary><h2>Security</h2></summary>
<h3>Change password</h3>
<form method="post" action="/settings/password" class="stack">
<label>Current password <input name="current" type="password" required autocomplete="current-password"></label>
<label>New password (min ${MIN_PASSWORD}) <input name="password" type="password" required minlength="${MIN_PASSWORD}" autocomplete="new-password"></label>
<button>Change password</button></form>
<h3>Passkeys</h3>
<p class="hint">Log in with your fingerprint, face or device PIN instead of typing a password. Your password keeps working.</p>
<ul>${passkeys.length ? passkeys.map(passkey => html`<li>${passkey.label} <small class="hint">added ${passkey.created_at.slice(0, 10)}</small>
 <form method="post" action="/settings/passkeys/delete" class="inline"><input type="hidden" name="id" value="${passkey.id}"><button class="link danger">remove</button></form></li>`)
    : html`<li class="hint">No passkeys yet.</li>`}</ul>
<p id="passkey-add" hidden><button class="btn">Add a passkey</button> <span class="err"></span></p>
<noscript class="hint">Adding a passkey needs JavaScript.</noscript></details>`);
}

// ---- administration (admin only; the route enforces it, this only draws it) ----
// Future admin-only tools get their own <section class="panel panel-admin"> here.

export const adminPage = (user, { base, invites, members, msg, error }) =>
  layout('Administration', user, html`<h1>Administration</h1>${notices(msg, error)}
<section class="panel panel-admin"><h2>Members</h2>
<p class="hint">A member who forgot their password needs a reset link — send them the one you create here.</p>
<ul>${members.map(member => html`<li>${member.name}${member.is_admin ? ' (admin)' : ''} — <form method="post" action="/admin/invite" class="inline"><input type="hidden" name="user_id" value="${member.id}"><button class="link">create reset-password link</button></form></li>`)}</ul>
<h3>Invite someone new</h3>
<form method="post" action="/admin/invite"><button>Create invite link</button></form>
${invites.length ? html`<h3>Open links (valid 7 days, single use)</h3><ul>${invites.map(invite => html`<li>${invite.user_name ? `Reset for ${invite.user_name}` : 'Invite'}: <code>${base}/invite/${invite.token}</code></li>`)}</ul>` : ''}</section>`);
