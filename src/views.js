import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import Mustache from 'mustache';
import packageJson from '../package.json' with { type: 'json' };
import {
  monthInfo, formatDate, formatEventWhen, eventLanes, dayClass, weekdayNames, today,
  DATE_FORMATS, WEEKDAYS, WEEK_START_CHOICES, ANSWERS, COLORS, MAX_DATES, MIN_PASSWORD,
} from './lib.js';

// Each page is a Mustache template in src/templates/ (https://mustache.github.io/mustache.5.html).
// The functions here only work out the values it shows; the markup lives in the template.
// {{value}} is HTML-escaped, {{{value}}} is not (only used for the page body inside the layout).
// All templates are read once at startup, keyed by file name, so any of them can be a {{> partial}}.
const TEMPLATE_DIR = join(import.meta.dirname, 'templates');
const templates = Object.fromEntries(readdirSync(TEMPLATE_DIR)
  .filter(file => file.endsWith('.html'))
  .map(file => [basename(file, '.html'), readFileSync(join(TEMPLATE_DIR, file), 'utf8')]));
const render = (name, values) => Mustache.render(templates[name], values, templates);

// Mustache's default escaping also encodes / ` and =, so every URL would come out as &#x2F;…
// Every value goes into text or a double-quoted attribute, where these five are all that matter.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
Mustache.escape = text => String(text).replace(/[&<>"']/g, char => ESCAPES[char]);

// Static files are cached for an hour (server.js). A hash of the content in the URL makes every
// change a new URL, so a restart after editing public/ reaches browsers at once, no Ctrl+F5.
// server.js serves by pathname, so the ?v= is ignored there.
const versioned = file => {
  const content = readFileSync(join(import.meta.dirname, '..', 'public', file));
  return `/${file}?v=` + createHash('sha256').update(content).digest('hex').slice(0, 8);
};
const STYLE_URL = versioned('style.css');
const SCRIPT_URL = versioned('app.js');

// ---- shared bits ----

/** "Ada Lovelace" -> "AL". Shown in calendar cells and as the color swatch. */
const initials = name => name.trim().split(/\s+/).map(word => word[0]).join('').slice(0, 2).toUpperCase();

// Confirmations, keyed by the ?msg= value the settings, profile and admin routes redirect with.
const MESSAGES = {
  rotated: 'Feed links rotated. Re-subscribe in your calendar apps.',
  password: 'Password changed.',
  invite: 'Link created (see below).',
  about: 'Profile saved.',
  customisation: 'Customisation saved.',
  passkey: 'Passkey added.',
  passkey_removed: 'Passkey removed.',
  removed: 'Member removed. Their sessions, passkeys and feed links no longer work.',
  group_created: 'Group created. Invite people below.',
  invited: 'Invite sent. They join once they accept it.',
  added: 'Member added to the group.',
  joined: 'You joined the group.',
  declined: 'Invite declined.',
  left: 'You left the group.',
  renamed: 'Group renamed.',
  member_removed: 'Member removed from the group.',
  invite_cancelled: 'Invite cancelled.',
  group_deleted: 'Group deleted.',
};

/** The value the notices partial shows for ?msg=. Form errors are shown under their fields instead. */
const notices = msg => ({ notice: MESSAGES[msg] });

/** Wraps a page's own HTML in the shell (head, header, nav). `user` is null on logged-out pages. */
export function layout(title, user, body) {
  return render('layout', { title, user, body, styleUrl: STYLE_URL, scriptUrl: SCRIPT_URL });
}

/** Renders template `name` with `values`, inside the shell. */
const page = (title, user, name, values) => layout(title, user, render(name, values));

/** Options for a <select>: `selected` marks the current one. */
const options = (entries, current) => entries.map(([value, label]) => ({ value, label, selected: value === current }));

export const errorPage = (status, message, user) => page(`Error ${status}`, user, 'error', { status, message });

// ---- auth pages ----

export const loginPage = error => page('Log in', null, 'login', { error });

// One page for both invite kinds: resetName is set only for a password-reset link.
// After a rejected form, `errors` ({ name, password }) shows under each field and `name` is kept.
export function invitePage(token, resetName, { errors = {}, name = '' } = {}) {
  return page(resetName ? 'Reset password' : 'Join', null, 'invite', {
    token,
    errors,
    name,
    isReset: Boolean(resetName),
    heading: resetName ? `Reset password for ${resetName}` : 'Create your account',
    button: resetName ? 'Set password' : 'Create account',
    minPassword: MIN_PASSWORD,
  });
}

// ---- calendar ----

// free_days.part, as tooltips say it
const PART_LABELS = { all: 'all day', am: 'morning', pm: 'afternoon', eve: 'evening' };
// The long-press / double-click menu: each button posts its value as `part` to /free.
const PART_CHOICES = { all: 'All day', am: 'Morning (AM)', pm: 'Afternoon (PM)', eve: 'Evening', none: 'Not free' };

/** ['am', 'eve'] -> 'morning and evening' */
const partsLabel = parts => parts.map(part => PART_LABELS[part]).join(' and ');

/** ' colored cN' for an event with a bar color (events.color), '' for the default look. */
const eventColor = event => event.color == null ? '' : ` colored c${event.color}`;

const MS_PER_DAY = 864e5;

// `error` is set when a /free post was rejected: it shows under the month title.
// `group` is the one group shown on its own (null: everyone I can see); `groups` fills the selector.
export function calendarPage(user, yearMonth, {
  free, mine, events, birthdays, today, members, error, group = null, groups = [],
}) {
  const month = monthInfo(yearMonth, user.week_start);
  const lanes = eventLanes(events);
  const eventTooltip = event => `${event.title}, ${formatEventWhen(event, user.date_format)} (by ${event.creator})`;

  const days = [];
  for (let day = 1; day <= month.days; day++) {
    const date = `${yearMonth}-${String(day).padStart(2, '0')}`;
    const whoIsFree = free.get(date) || [];
    const myParts = mine.get(date); // undefined when I have not marked this day
    const dayEvents = events.filter(event => event.date <= date && date <= event.end_date);

    // A bar is labelled where it starts, and again on day 1 and at the start of each week row.
    const column = (month.pad + day - 1) % 7;
    const startsRow = day === 1 || column === 0;
    // How many cells the label may run over: to the end of the event, the week row or the month.
    const labelRun = event => Math.min(
      (Date.parse(event.end_date) - Date.parse(date)) / MS_PER_DAY + 1,
      7 - column,
      month.days - day + 1,
    );
    const label = event => (event.start_time && event.date === date ? event.start_time + ' ' : '') + event.title;

    // Multi-day events sit in their lane; a lane with nothing today stays as a gap.
    const bars = [];
    for (const event of dayEvents) {
      if (lanes.has(event.id)) {
        bars[lanes.get(event.id)] = event;
      }
    }
    const barValues = Array.from(bars, event => {
      if (!event) {
        return { gap: true };
      }
      // .from / .to: the bar carries on from yesterday / into tomorrow, so that side is square
      // and joins the next cell.
      const continues = (event.date < date ? ' from' : '') + (date < event.end_date ? ' to' : '');
      return {
        gap: false,
        classes: `ev bar${eventColor(event)}${continues}`,
        tooltip: eventTooltip(event),
        showLabel: event.date === date || startsRow,
        run: labelRun(event),
        label: label(event),
      };
    });

    const dayStates = dayClass({ who: whoIsFree, members, mine: Boolean(myParts) });
    days.push({
      day,
      date,
      classes: `day ${dayStates}${date === today ? ' today' : ''}`,
      tooltip: myParts ? `You: ${partsLabel(myParts)}. Click to clear` : 'Click: I am free all day',
      dateLabel: formatDate(date, user.date_format),
      parts: myParts ? myParts.join(' ') : 'none',
      free: whoIsFree.map(member => ({
        color: member.color,
        tooltip: `${member.name}, ${partsLabel(member.parts)}`,
        initials: initials(member.name),
        // the small am / pm / eve next to the initials, a second one stacked under the first
        slots: member.parts.includes('all') ? [] : member.parts,
      })),
      bars: barValues,
      birthdays: birthdays.filter(member => member.date === date),
      oneDay: dayEvents.filter(event => !lanes.has(event.id)).map(event => ({
        classes: `ev${eventColor(event)}`,
        tooltip: eventTooltip(event),
        label: label(event),
      })),
    });
  }

  return page(month.label, user, 'calendar', {
    error,
    month,
    yearMonth,
    // carried by the month links and the day forms, so the one-group view stays put
    groupId: group ? group.id : '',
    myColor: user.color,
    // always set, empty for everyone: a link without g would open the default group instead
    groupQuery: `&g=${group ? group.id : ''}`,
    // "Make default" is offered only when the view on screen is not already the default
    isDefaultView: (group ? group.id : null) === (user.default_group_id ?? null),
    groupChoices: groups.map(choice => ({ value: choice.id, label: choice.name, selected: choice.id === group?.id })),
    weekdays: weekdayNames(user.week_start),
    padding: Array.from({ length: month.pad }, () => ({})),
    days,
    partChoices: Object.entries(PART_CHOICES).map(([value, label]) => ({
      value,
      label,
      classes: value === 'none' ? 'danger' : '',
    })),
    events: events.map(event => ({
      id: event.id,
      title: event.title,
      creator: event.creator,
      when: formatEventWhen(event, user.date_format),
      classes: event.end_date < today ? 'past' : '', // its last day is before today
      canEdit: event.created_by === user.id || Boolean(user.is_admin),
    })),
  });
}

// ---- groups ----

// `groups` are mine, each with members / invited / invitable / canManage (see showGroups in routes.js);
// `invites` are the ones waiting for my answer. errors[groupId] shows in that group, errors.create in New group.
export function groupsPage(user, { groups, invites, msg, errors = {} }) {
  return page('Groups', user, 'groups', {
    ...notices(msg),
    invites,
    createError: errors.create,
    isAdmin: Boolean(user.is_admin),
    groups: groups.map(group => ({
      id: group.id,
      name: group.name,
      color: group.color,
      creator: group.creator ?? 'a removed member',
      error: errors[group.id],
      canManage: group.canManage,
      members: group.members.map(member => ({
        groupId: group.id,
        id: member.id,
        name: member.name,
        color: member.color,
        initials: initials(member.name),
        // managers remove the others; they leave with Leave like everyone else
        removable: group.canManage && member.id !== user.id,
      })),
      invited: group.invited.map(person => ({ ...person, groupId: group.id })),
      invitable: group.invitable,
    })),
  });
}

// ---- events ----

// One page for both: event.id set means editing that event, otherwise adding one.
// `event` is an events row, or what was posted when the form is shown again with `errors`
// ({ title, start, end, color }: each shows under that part of the form).
export function eventPage(user, { event, errors = {} }) {
  const editing = Boolean(event.id);
  const heading = editing ? 'Edit event' : 'New event';
  const savedColor = String(event.color ?? '');
  const colorChoice = (value, label) => ({
    value,
    label,
    classes: `swatch-pick${value === '' ? '' : ` c${value}`}`,
    checked: savedColor === String(value),
  });

  return page(heading, user, 'event', {
    heading,
    errors,
    editing,
    id: event.id,
    action: editing ? `/events/${event.id}` : '/events',
    button: editing ? 'Save' : 'Add event',
    title: event.title ?? '',
    date: event.date ?? '',
    // A saved event is all day when it has no start time; a rejected form keeps the box as posted.
    allDay: event.allDay ?? !event.start_time,
    startTime: event.start_time ?? '',
    // A one-day event shows no end date, so moving its start date does not leave the end behind.
    endDate: event.end_date && event.end_date !== event.date ? event.end_date : '',
    endTime: event.end_time ?? '',
    colors: [colorChoice('', 'Default'), ...Array.from({ length: COLORS }, (_, i) => colorChoice(i, `Color ${i + 1}`))],
    month: (event.date || today()).slice(0, 7),
  });
}

// ---- polls ----

export function pollsPage(user, polls) {
  const status = poll => {
    if (!poll.closed_at) {
      return `open · ${poll.voters}/${poll.members} answered`;
    }
    return poll.chosen_date ? `✓ ${formatDate(poll.chosen_date, user.date_format)}` : 'closed';
  };
  return page('Polls', user, 'polls', {
    polls: polls.map(poll => ({ id: poll.id, title: poll.title, status: status(poll) })),
  });
}

// After a rejected form, `errors` ({ title, dates }) shows under each field and `title` is kept.
export const newPollPage = (user, { errors = {}, title = '' } = {}) =>
  page('New poll', user, 'new-poll', { errors, title, maxDates: MAX_DATES });

// `errors` after a rejected form: `answers` shows under the title, `result` in the result section.
export function pollPage(user, { poll, dates, members, votes, missing, complete, best, event, errors = {} }) {
  const answers = {}; // user_id -> { date: answer }
  for (const vote of votes) {
    (answers[vote.user_id] ??= {})[vote.date] = vote.answer;
  }
  const myAnswers = answers[user.id] || {};
  const countAnswer = (date, answer) => votes.filter(vote => vote.date === date && vote.answer === answer).length;
  const formatted = date => formatDate(date, user.date_format);

  const isOpen = !poll.closed_at;
  const canManage = poll.created_by === user.id || Boolean(user.is_admin);
  // The result only makes sense once everyone answered, or the poll was closed early.
  const showResult = (complete || !isOpen) && best.length > 0;
  // You first, then everyone else A to Z. localeCompare puts "Élodie" next to "Eric", not after "Zoé".
  const sortedMembers = members.toSorted((a, b) =>
    (b.id === user.id) - (a.id === user.id) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  let status = 'Poll closed.';
  if (isOpen) {
    status = complete ? 'Everyone has answered.' : `Waiting for: ${missing.join(', ')}`;
  }

  const rows = sortedMembers.map(member => {
    const isMe = member.id === user.id;
    return {
      name: member.name + (isMe ? ' (you)' : ''),
      cells: dates.map(date => {
        const answer = answers[member.id]?.[date];
        return {
          date,
          editable: isMe && isOpen,
          current: myAnswers[date] ?? null,
          options: ANSWERS.map(value => ({ value, selected: myAnswers[date] === value })),
          answerClass: answer || 'none',
          answerText: answer || '–',
        };
      }),
    };
  });

  const result = showResult && {
    heading: `Best date${best.length > 1 ? 's' : ''}: ${best.map(formatted).join(', ')}`,
    tied: best.length > 1,
    event: event && { title: event.title, date: formatted(event.date), month: event.date.slice(0, 7) },
    choices: best.map(date => ({ pollId: poll.id, date, label: formatted(date) })),
  };

  return page(poll.title, user, 'poll', {
    errors,
    id: poll.id,
    title: poll.title,
    status,
    isOpen,
    canClose: isOpen && canManage,
    columns: dates.map(date => ({ label: formatted(date), classes: showResult && best.includes(date) ? 'best' : '' })),
    rows,
    totals: dates.map(date => ({
      yes: countAnswer(date, 'yes'),
      maybe: countAnswer(date, 'maybe'),
      no: countAnswer(date, 'no'),
    })),
    result,
  });
}

// ---- settings ----

// webcal:// makes desktop calendar apps subscribe instead of downloading the file once.
const webcal = url => url.replace(/^https?:\/\//, 'webcal://');

// `errors` after a rejected Customisation form ({ weekStart, dateFormat }): shown under each field.
export function settingsPage(user, { base, msg, errors = {} }) {
  const eventsFeed = `${base}/feed/${user.feed_token}/events.ics`;
  const birthdaysFeed = `${base}/feed/${user.feed_token}/birthdays.ics`;

  return page('Settings', user, 'settings', {
    ...notices(msg),
    errors,
    version: packageJson.version, // shown under the title; bump it in package.json
    eventsFeed,
    eventsWebcal: webcal(eventsFeed),
    birthdaysFeed,
    birthdaysWebcal: webcal(birthdaysFeed),
    weekStarts: options(WEEK_START_CHOICES.map(day => [day, WEEKDAYS[day]]), user.week_start),
    // Each format is shown as today's date written that way.
    dateFormats: options(Object.keys(DATE_FORMATS).map(key => [key, formatDate(today(), key)]), user.date_format),
    showBirthdays: Boolean(user.show_birthdays),
  });
}

// ---- profile ----

// After a rejected form, `errors` shows under each field ({ name, birthday, color } in About me,
// { current, password } in Security), and `about` holds the About me values as they were typed.
export function profilePage(user, { passkeys, msg, errors = {}, about = user }) {
  return page('Profile', user, 'profile', {
    ...notices(msg),
    errors,
    name: about.name,
    birthday: about.birthday ?? '',
    today: today(),
    color: about.color,
    isPrivate: Boolean(about.is_private ?? user.is_private),
    maxColor: COLORS - 1,
    initials: initials(about.name || user.name),
    minPassword: MIN_PASSWORD,
    passkeys: passkeys.map(passkey => ({
      id: passkey.id,
      label: passkey.label,
      added: formatDate(passkey.created_at.slice(0, 10), user.date_format),
    })),
  });
}

// ---- administration (admin only; the route enforces it, this only draws it) ----

// `errors.members` after a rejected member action: shown under the Members title.
export function adminPage(user, { base, invites, members, log, msg, errors = {} }) {
  return page('Administration', user, 'admin', {
    ...notices(msg),
    errors,
    members: members.map(member => ({ ...member, isMe: member.id === user.id })),
    invites: invites.map(invite => ({
      label: invite.user_name ? `Reset for ${invite.user_name}` : 'Invite',
      url: `${base}/invite/${invite.token}`,
    })),
    // Newest first. Times are stored as local ISO strings: the date part is formatted, the clock kept.
    log: log.toReversed().map(entry => ({
      number: entry.number,
      time: `${formatDate(entry.time.slice(0, 10), user.date_format)} ${entry.time.slice(11, 19)}`,
      ip: entry.ip,
      user: entry.user,
      known: entry.known,
      action: entry.action,
    })),
  });
}
