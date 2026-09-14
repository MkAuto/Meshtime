import { monthInfo, dayClass, COLORS } from './lib.js';

// html`` auto-escapes every interpolation; wrap trusted markup in raw(). Nested html`` results are trusted.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = s => new Raw(String(s));
const render = v => v instanceof Raw ? v.s
  : Array.isArray(v) ? v.map(render).join('')
  : v == null || v === false ? ''
  : String(v).replace(/[&<>"']/g, c => ESC[c]);
export const html = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + render(vals[i - 1]) + s));

const initials = n => n.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
const MSGS = { rotated: 'Feed links rotated. Re-subscribe in your calendar apps.', password: 'Password changed.', invite: 'Link created (see below).', color: 'Color saved.' };

export function layout(title, user, body) {
  return '<!doctype html>' + html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Meshtime</title><link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script></head><body>
<header><a href="/" class="brand">Meshtime</a>${user ? html`<nav><a href="/">Calendar</a><a href="/polls">Polls</a><a href="/settings">Settings</a>
<form method="post" action="/logout"><button class="link">Log out (${user.name})</button></form></nav>` : ''}</header>
<main>${body}</main></body></html>`.s;
}

export const errorPage = (status, msg, user) => layout(`Error ${status}`, user, html`<h1>${status}</h1><p>${msg}</p><p><a href="/">Back to calendar</a></p>`);

export const loginPage = error => layout('Log in', null, html`<h1>Log in</h1>${error && html`<p class="err">${error}</p>`}
<form method="post" action="/login" class="stack">
<label>Name <input name="name" required maxlength="40" autocomplete="username" autofocus></label>
<label>Password <input name="password" type="password" required autocomplete="current-password"></label>
<button>Log in</button></form>
<p class="hint">No account? Ask a member for an invite link.</p>`);

export const invitePage = (token, resetName, error) => layout(resetName ? 'Reset password' : 'Join', null, html`
<h1>${resetName ? `Reset password for ${resetName}` : 'Create your account'}</h1>${error && html`<p class="err">${error}</p>`}
<form method="post" action="/invite/${token}" class="stack">
${resetName ? '' : html`<label>Your name <input name="name" required maxlength="40" autocomplete="username" autofocus></label>`}
<label>Password (min 8 characters) <input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
<button>${resetName ? 'Set password' : 'Create account'}</button></form>`);

export function calendarPage(user, ym, { free, mine, events, today, members }) {
  const mi = monthInfo(ym);
  const cells = Array.from({ length: mi.pad }, () => html`<div class="day pad"></div>`);
  for (let d = 1; d <= mi.days; d++) {
    const date = `${ym}-${String(d).padStart(2, '0')}`;
    const who = free.get(date) || [];
    const evs = events.filter(e => e.date === date);
    cells.push(html`<div class="day ${dayClass({ who, members, mine: mine.has(date) })}${date === today ? ' today' : ''}">
<form method="post" action="/free"><input type="hidden" name="date" value="${date}"><input type="hidden" name="m" value="${ym}">
<button title="${mine.has(date) ? 'Click: I am no longer free' : 'Click: I am free that day'}">${d}</button></form>
${who.length ? html`<div class="who">${who.map(u => html`<span class="c${u.color}" title="${u.name}">${initials(u.name)}</span>`)}</div>` : ''}
${evs.map(e => html`<div class="ev" title="${e.title} (by ${e.creator})">${e.title}</div>`)}</div>`);
  }
  return layout(mi.label, user, html`
<h1><a href="/?m=${mi.prev}" title="Previous month">&lsaquo;</a> ${mi.label} <a href="/?m=${mi.next}" title="Next month">&rsaquo;</a></h1>
<p class="hint">Click a day to mark yourself free (outlined). Initials show who is free; green means everyone is.</p>
<div class="grid">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => html`<div class="dow">${d}</div>`)}${cells}</div>
<section><h2>Events this month</h2>
<ul class="events">${events.length ? events.map(e => html`<li>${e.date} — <b>${e.title}</b> <small class="hint">by ${e.creator}</small>
${e.created_by === user.id || user.is_admin ? html` <form method="post" action="/events/${e.id}/delete" class="inline"><input type="hidden" name="m" value="${ym}"><button class="link danger">delete</button></form>` : ''}</li>`)
    : html`<li class="hint">No events this month.</li>`}</ul>
<form method="post" action="/events" class="row"><input type="hidden" name="m" value="${ym}">
<input name="title" placeholder="Event title" required maxlength="100"><input type="date" name="date" required><button>Add event</button></form></section>`);
}

export const pollsPage = (user, polls) => layout('Polls', user, html`<h1>Polls</h1>
<p><a class="btn" href="/polls/new">New poll</a></p>
<ul class="polls">${polls.length ? polls.map(p => html`<li><a href="/polls/${p.id}">${p.title}</a>
<small>${p.closed_at ? (p.chosen_date ? `✓ ${p.chosen_date}` : 'closed') : `open · ${p.voters}/${p.members} answered`}</small></li>`)
  : html`<li class="hint">No polls yet.</li>`}</ul>`);

export const newPollPage = (user, error) => layout('New poll', user, html`<h1>New poll</h1>${error && html`<p class="err">${error}</p>`}
<form method="post" action="/polls/new" class="stack">
<label>What for? <input name="title" required maxlength="100" placeholder="Board game night" autofocus></label>
<fieldset class="stack"><legend>Proposed dates (leave extras empty)</legend>${[1, 2, 3, 4, 5, 6].map(() => html`<input type="date" name="dates">`)}</fieldset>
<button>Create poll</button></form>`);

export function pollPage(user, { poll, dates, members, votes, missing, complete, best, event }) {
  const v = {};
  for (const x of votes) (v[x.user_id] ??= {})[x.date] = x.answer;
  const mine = v[user.id] || {};
  const open = !poll.closed_at;
  const canManage = poll.created_by === user.id || user.is_admin;
  const count = (date, a) => votes.filter(x => x.date === date && x.answer === a).length;
  const showResult = (complete || !open) && best;
  return layout(poll.title, user, html`<h1>${poll.title}</h1>
<p class="hint">${open ? (complete ? 'Everyone has answered.' : `Waiting for: ${missing.join(', ')}`) : 'Poll closed.'}</p>
<form method="post" action="/polls/${poll.id}"><table class="poll"><thead><tr><th></th>${dates.map(d => html`<th class="${showResult && d === best ? 'best' : ''}">${d}</th>`)}</tr></thead><tbody>
${members.map(m => html`<tr><td>${m.name}${m.id === user.id ? ' (you)' : ''}</td>${dates.map(d => html`<td>${m.id === user.id && open
    ? html`<select name="v_${d}">${mine[d] ? '' : html`<option value="" selected>—</option>`}${['yes', 'maybe', 'no'].map(a => html`<option value="${a}"${mine[d] === a ? raw(' selected') : ''}>${a}</option>`)}</select>`
    : html`<span class="a ${(v[m.id] || {})[d] || 'none'}">${(v[m.id] || {})[d] || '–'}</span>`}</td>`)}</tr>`)}
<tr class="tot"><td>yes / maybe / no</td>${dates.map(d => html`<td>${count(d, 'yes')} / ${count(d, 'maybe')} / ${count(d, 'no')}</td>`)}</tr></tbody></table>
${open ? html`<button>Save my answers</button>` : ''}</form>
${showResult ? html`<section class="result"><h2>Best date: ${best}</h2>
${event ? html`<p>Added to the calendar as <b>${event.title}</b> on ${event.date}. <a href="/?m=${event.date.slice(0, 7)}">View</a></p>`
    : html`<form method="post" action="/polls/${poll.id}/confirm"><input type="hidden" name="date" value="${best}"><button>Add to calendar</button></form>`}</section>` : ''}
${open && canManage ? html`<p><form method="post" action="/polls/${poll.id}/close" class="inline"><button class="link danger">Close poll now</button></form></p>` : ''}`);
}

export function settingsPage(user, { base, invites, members, msg, error }) {
  const feed = kind => `${base}/feed/${user.feed_token}/${kind}.ics`;
  const webcal = u => u.replace(/^https?:\/\//, 'webcal://');
  return layout('Settings', user, html`<h1>Settings</h1>${MSGS[msg] && html`<p class="ok">${MSGS[msg]}</p>`}${error && html`<p class="err">${error}</p>`}
<section><h2>Calendar feeds</h2>
<p class="hint">Private links: anyone who has one can read it. Rotating them requires re-subscribing.</p>
<ul class="feeds">${[['events', 'Group events'], ['free', 'Who is free']].map(([k, label]) => html`<li><b>${label}</b><br><code>${feed(k)}</code><br><a href="${webcal(feed(k))}">webcal link (Apple / Outlook desktop)</a></li>`)}</ul>
<details><summary>How to subscribe</summary><ul>
<li><b>Google Calendar</b> (web): Other calendars → + → From URL → paste the https link. Google refreshes every 12–24 h and cannot be forced.</li>
<li><b>Apple Calendar</b>: click the webcal link, or File → New Calendar Subscription. Choose a short auto-refresh interval.</li>
<li><b>Outlook</b> (web): Add calendar → Subscribe from web → paste the https link. Refreshes every few hours.</li></ul></details>
<form method="post" action="/settings/rotate-feed"><button class="danger">Rotate feed links</button></form></section>
<section><h2>My color</h2><form method="post" action="/settings/color" class="row">
<b class="c${user.color} swatch" id="swatch" title="Preview">${initials(user.name)}</b>
<input type="range" name="color" class="hue" min="0" max="${COLORS - 1}" value="${user.color}" aria-label="Color">
<button>Save color</button></form></section>
<section><h2>Change password</h2><form method="post" action="/settings/password" class="stack">
<label>Current password <input name="current" type="password" required autocomplete="current-password"></label>
<label>New password (min 8) <input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
<button>Change password</button></form></section>
${user.is_admin ? html`<section><h2>Members (admin)</h2>
<ul>${members.map(m => html`<li>${m.name}${m.is_admin ? ' (admin)' : ''} — <form method="post" action="/settings/invite" class="inline"><input type="hidden" name="user_id" value="${m.id}"><button class="link">create reset-password link</button></form></li>`)}</ul>
<form method="post" action="/settings/invite"><button>Create invite link</button></form>
${invites.length ? html`<h3>Open links (valid 7 days, single use)</h3><ul>${invites.map(i => html`<li>${i.user_name ? `Reset for ${i.user_name}` : 'Invite'}: <code>${base}/invite/${i.token}</code></li>`)}</ul>` : ''}</section>` : ''}`);
}
