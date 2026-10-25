import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import Mustache from 'mustache';
import packageJson from '../package.json' with { type: 'json' };
import {
  monthInfo, addDays, formatDate, formatMonthDay, formatTime, formatEventWhen, eventLanes, dayClass, weekdayNames, today,
  wallClock, BUSY_CHOICES, DEFAULT_BUSY_MINUTES, SLOTS, DATE_FORMATS, WEEK_START_CHOICES, ANSWERS, COLORS, MAX_DATES,
  SYNC_DAYS_CHOICES, DEFAULT_SYNC_DAYS, MIN_PASSWORD, LANGUAGES, DEFAULT_LANGUAGE, isValidLanguage, randomColor,
  REPEATS,
} from './lib.js';
import { t, dictionary, hasText, syncErrorText } from './i18n.js';

// Each page is a Mustache template in src/templates/ (https://mustache.github.io/mustache.5.html).
// The functions here only work out the values it shows; the markup lives in the template.
// {{value}} is HTML-escaped, {{{value}}} is not (only used for the page body inside the layout, and for the few
// texts in src/locales that hold a link or bold: they are ours, never typed by a member).
// Texts come from src/locales (src/i18n.js): every template gets its language's as `t`, {{t.settings.title}}.
// A text with a value in it ({{name}}) is filled in here with t(), and given to the template ready to show.
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

/**
 * The confirmation for ?msg= (notices.<msg> in src/locales: the settings, profile and admin routes redirect with
 * one), for the notices partial. Form errors are shown under their fields instead.
 */
const notices = (msg, lang) => ({ notice: msg && hasText(`notices.${msg}`) ? t(lang, `notices.${msg}`) : undefined });

/**
 * Is the groups feature on (Administration → Options)? Off, pages show no groups and no public / private choice.
 * A user without the field (a test's hand-made one) counts as on, the default.
 */
const groupsEnabled = user => user?.groups_enabled !== 0;

/**
 * Wraps a page's own HTML in the shell (head, header, nav, language menu). `user` is null on logged-out pages.
 * `visitor` is who the page is for: { lang, path }, the language it is in and the URL it was asked for (the
 * language menu comes back to it). A member's own come with them (server.js); logged-out pages pass theirs.
 */
export function layout(title, user, body, visitor = user ?? {}) {
  const lang = isValidLanguage(visitor.lang) ? visitor.lang : DEFAULT_LANGUAGE;
  return render('layout', {
    title, user, body, styleUrl: STYLE_URL, scriptUrl: SCRIPT_URL, groupsEnabled: groupsEnabled(user),
    lang,
    t: dictionary(lang),
    logout: user && t(lang, 'layout.logout', { name: user.name }),
    back: visitor.path ?? '/',
    languages: LANGUAGES.map(({ code, name }) => ({ code, name, current: code === lang })),
  });
}

/** Renders template `name` with `values`, inside the shell. Every template gets groupsEnabled and t. */
const page = (title, user, name, values, visitor = user ?? {}) =>
  layout(title, user, render(name, { ...values, groupsEnabled: groupsEnabled(user), t: dictionary(visitor.lang) }),
    visitor);

/** Options for a <select>: `selected` marks the current one. */
const options = (entries, current) => entries.map(([value, label]) => ({ value, label, selected: value === current }));

/** The feed-link partial's values for one feed: its URL, its name, and the label of its box. */
const feedLink = (lang, name, feed) => ({ name, feed, linkLabel: t(lang, 'feeds.linkFor', { name }) });

/**
 * `message` is a key in src/locales, or a text already in the visitor's language. `visitor` ({ lang, path }) is
 * for when nobody is logged in; a member's own come with them.
 */
export const errorPage = (status, message, user, visitor = user ?? {}) =>
  page(t(visitor.lang, 'error.title', { status }), user, 'error', { status, message: t(visitor.lang, message) },
    visitor);

// ---- auth pages ----

export const loginPage = (lang, error) => page(t(lang, 'login.title'), null, 'login', { error }, { lang, path: '/login' });

// One page for both invite kinds: resetName is set only for a password-reset link.
// After a rejected form, `errors` ({ name, password }) shows under each field and `name` is kept.
export function invitePage(lang, token, resetName, { errors = {}, name = '' } = {}) {
  return page(t(lang, resetName ? 'invite.resetTitle' : 'invite.joinTitle'), null, 'invite', {
    token,
    errors,
    name,
    isReset: Boolean(resetName),
    heading: resetName ? t(lang, 'invite.resetHeading', { name: resetName }) : t(lang, 'invite.createHeading'),
    button: t(lang, resetName ? 'invite.resetButton' : 'invite.createButton'),
    minPassword: MIN_PASSWORD,
    passwordLabel: t(lang, 'invite.password', { min: MIN_PASSWORD }),
  }, { lang, path: `/invite/${token}` });
}

// ---- calendar ----

// The long-press / double-click menu: each button posts its value as `part` to /free (labels: dayParts.choice).
// auto: Calendar Integration decides the day again, only offered with a calendar connected.
const PART_CHOICES = ['all', 'am', 'pm', 'eve', 'none', 'auto'];

/** ['am', 'eve'] -> 'morning and evening', as tooltips say free_days.part */
const partsLabel = (parts, lang) =>
  parts.map(part => t(lang, `dayParts.label.${part}`)).join(` ${t(lang, 'calendar.and')} `);

/** ' colored cN' for an event with a bar color (events.color), '' for the default look. */
const eventColor = event => event.color == null ? '' : ` colored c${event.color}`;

const MS_PER_DAY = 864e5;

/** An event's when and how it repeats, as tooltips and lists show it: '3 Oct 2026 19:00 · Every week'. */
function eventDetails(event, user) {
  const { lang, date_format: format } = user;
  const repeats = event.repeats && t(lang, `event.repeats.${event.repeats}`);
  return [
    formatEventWhen(event, format, user.hour12, lang),
    event.repeat_until
      ? t(lang, 'event.repeatsUntil', { repeats, date: formatDate(event.repeat_until, format, lang) })
      : repeats,
  ].filter(Boolean).join(' · ');
}

// An event's location, linked to a map search for it (lists): Google Maps' universal link opens its app on a
// phone, the website elsewhere. ponytail: Google only.
const place = location => location && {
  name: location, url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`,
};

// `error` is set when a /free post was rejected: it shows under the month title.
// `group` is the one group shown on its own (null: everyone I can see); `groups` fills the selector.
export function calendarPage(user, yearMonth, {
  free, mine, events, birthdays, today, members, error, group = null, groups = [], manualDays = null,
}) {
  // manualDays: the dates I set by hand, or null without a calendar connected (no Automatic in the menu)
  const { lang } = user;
  const month = monthInfo(yearMonth, user.week_start, lang);
  const lanes = eventLanes(events);
  const eventTooltip = event => t(lang, 'calendar.eventTooltip', {
    title: event.title, when: [eventDetails(event, user), event.location].filter(Boolean).join(' · '),
    creator: event.creator,
  });

  // Continuous (Settings → Customisation, on unless turned off): the first and last weeks are filled with the
  // days of the months around this one, like Google Calendar. Off: blank cells before day 1, nothing after.
  const continuous = user.continuous_calendar !== 0;
  const firstDate = continuous ? month.gridStart : `${yearMonth}-01`;
  const cellCount = continuous ? month.pad + month.days + month.trail : month.days;
  const leadingBlanks = continuous ? 0 : month.pad;

  const days = [];
  for (let index = 0; index < cellCount; index++) {
    const date = addDays(firstDate, index);
    const day = Number(date.slice(8));
    const inMonth = date.slice(0, 7) === yearMonth;
    const whoIsFree = free.get(date) || [];
    const myParts = mine.get(date); // undefined when I have not marked this day
    const dayEvents = events.filter(event => event.date <= date && date <= event.end_date);

    // A bar is labelled where it starts, and again in the first cell and at the start of each week row.
    const column = (leadingBlanks + index) % 7;
    const startsRow = index === 0 || column === 0;
    // How many cells the label may run over: to the end of the event, the week row or the last cell.
    const labelRun = event => Math.min(
      (Date.parse(event.end_date) - Date.parse(date)) / MS_PER_DAY + 1,
      7 - column,
      cellCount - index,
    );
    const label = event =>
      (event.start_time && event.date === date ? formatTime(event.start_time, user.hour12) + ' ' : '') + event.title;

    // Multi-day events sit in their lane; a lane with nothing today stays as a gap.
    const bars = [];
    for (const event of dayEvents) {
      if (lanes.has(event)) {
        bars[lanes.get(event)] = event;
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
      // every day of the month before or after says which month it is ("Nov 1"), so it is never mistaken
      // for a day of this one
      day: inMonth ? day : formatMonthDay(date, lang),
      date,
      classes: `day ${dayStates}${date === today ? ' today' : ''}${inMonth ? '' : ' outside'}`,
      tooltip: myParts ? t(lang, 'calendar.dayMine', { parts: partsLabel(myParts, lang) }) : t(lang, 'calendar.dayFree'),
      dateLabel: formatDate(date, user.date_format, lang),
      // what the menu marks as current: my parts or 'none', and 'auto' when the calendar decides the day
      parts: [...(myParts ?? ['none']), ...(manualDays && !manualDays.has(date) ? ['auto'] : [])].join(' '),
      // Settings → Customisation can leave my own initials out; the day still counts me as free
      free: whoIsFree.filter(member => !(member.isMe && user.hide_own_initials)).map(member => ({
        color: member.color,
        tooltip: t(lang, 'calendar.memberTooltip', { name: member.name, parts: partsLabel(member.parts, lang) }),
        initials: initials(member.name),
        // the small am / pm / eve next to the initials, a second one stacked under the first
        slots: member.parts.includes('all') ? [] : member.parts.map(part => t(lang, `dayParts.short.${part}`)),
      })),
      bars: barValues,
      birthdays: birthdays.filter(member => member.date === date)
        .map(member => ({ color: member.color, label: t(lang, 'calendar.birthday', { name: member.name }) })),
      oneDay: dayEvents.filter(event => !lanes.has(event)).map(event => ({
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
    // Settings → Customisation: no outline on my own free days
    gridClasses: `grid c${user.color}${user.hide_free_border ? ' no-free-border' : ''}`,
    // always set, empty for everyone: a link without g would open the default group instead
    groupQuery: `&g=${group ? group.id : ''}`,
    // "Make default" is offered only when the view on screen is not already the default
    isDefaultView: (group ? group.id : null) === (user.default_group_id ?? null),
    groupChoices: groups.map(choice => ({ value: choice.id, label: choice.name, selected: choice.id === group?.id })),
    weekdays: weekdayNames(user.week_start, lang),
    padding: Array.from({ length: leadingBlanks }, () => ({})),
    days,
    partChoices: PART_CHOICES
      .filter(value => value !== 'auto' || manualDays)
      .map(value => ({ value, label: t(lang, `dayParts.choice.${value}`), classes: value === 'none' ? 'danger' : '' })),
    // the list under the calendar is this month's only, even when the grid shows days around it
    events: events
      .filter(event => event.date <= `${yearMonth}-31` && event.end_date >= `${yearMonth}-01`)
      .map(event => ({
        id: event.id,
        title: event.title,
        by: t(lang, 'common.by', { name: event.creator }),
        when: eventDetails(event, user),
        place: place(event.location),
        classes: event.end_date < today ? 'past' : '', // its last day is before today
        canEdit: event.created_by === user.id || Boolean(user.is_admin),
      })),
  });
}

// ---- groups ----

// `groups` are mine, each with members / invited / invitable / canManage (see showGroups in routes.js);
// `invites` are the ones waiting for my answer. errors[groupId] shows in that group, errors.create in New group.
// `base` is BASE_URL, for each group's private calendar feed link. `invitedName`: who an invite just went to.
export function groupsPage(user, { groups, invites, base, msg, invitedName, errors = {} }) {
  const { lang } = user;
  return page(t(lang, 'groups.title'), user, 'groups', {
    ...(msg === 'invited' && invitedName ? { notice: t(lang, 'groups.invitedTo', { name: invitedName }) }
      : notices(msg, lang)),
    invites: invites.map(invite => ({
      ...invite,
      from: invite.invited_by && t(lang, 'groups.from', { name: invite.invited_by }),
    })),
    createError: errors.create,
    newGroupColor: randomColor(),
    isAdmin: Boolean(user.is_admin),
    groups: groups.map(group => ({
      id: group.id,
      ...feedLink(lang, group.name, groupFeedUrl(base, user, group.id)),
      color: group.color,
      ownedBy: t(lang, 'groups.ownedBy', { name: group.creator ?? t(lang, 'groups.removedMember') }),
      error: errors[group.id],
      canManage: group.canManage,
      confirmDelete: t(lang, 'groups.confirmDelete', { name: group.name }),
      confirmLeave: t(lang, 'groups.confirmLeave', { name: group.name }),
      members: group.members.map(member => ({
        groupId: group.id,
        id: member.id,
        name: member.name,
        color: member.color,
        initials: initials(member.name),
        // managers remove the others; they leave with Leave like everyone else
        removable: group.canManage && member.id !== user.id,
        confirmRemove: t(lang, 'groups.confirmRemove', { name: member.name }),
      })),
      invited: group.invited.map(person => ({ ...person, groupId: group.id })),
      // "Next event", or "Last event" when none is coming; still "Next event" (with a placeholder) for none at all
      eventHeading: t(lang, group.headlineEvent?.isLast ? 'groups.lastEvent' : 'groups.nextEvent'),
      headlineEvent: group.headlineEvent && {
        title: group.headlineEvent.title,
        when: eventDetails(group.headlineEvent, user),
        place: place(group.headlineEvent.location),
        by: t(lang, 'common.by', { name: group.headlineEvent.creator }),
        // the group's own calendar view, on the event's month
        calendarUrl: `/?m=${group.headlineEvent.date.slice(0, 7)}&g=${group.id}`,
      },
      invitable: group.invitable,
    })),
  });
}

// ---- events ----

/**
 * The "Who sees it" values of an event or poll form (templates/share-with.html): public or private, and
 * `groups` (its creator's) each ticked when its id is in `groupIds`.
 */
const sharingValues = (isPrivate, groupIds = [], groups = []) => ({
  isPrivate: Boolean(isPrivate),
  groupChoices: groups.map(group => ({
    id: group.id,
    name: group.name,
    color: group.color,
    checked: groupIds.includes(group.id),
  })),
});

// One page for both: event.id set means editing that event, otherwise adding one.
// `event` is an events row, or what was posted when the form is shown again with `errors`
// ({ title, start, end, color }: each shows under that part of the form).
// `groups` are the event creator's groups: the ones a private event can be shared with.
export function eventPage(user, { event, errors = {}, groups = [] }) {
  const { lang } = user;
  const editing = Boolean(event.id);
  const heading = t(lang, editing ? 'event.editTitle' : 'event.newTitle');
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
    button: t(lang, editing ? 'common.save' : 'event.add'),
    title: event.title ?? '',
    // a repeating event is one row: editing or deleting it changes every time it comes back
    confirmDelete: t(lang, event.repeats ? 'event.confirmDeleteAll' : 'event.confirmDelete', { title: event.title ?? '' }),
    allRepeats: editing && Boolean(event.repeats),
    date: event.date ?? '',
    // A saved event is all day when it has no start time; a rejected form keeps the box as posted.
    allDay: event.allDay ?? !event.start_time,
    startTime: event.start_time ?? '',
    // A one-day event shows no end date, so moving its start date does not leave the end behind.
    endDate: event.end_date && event.end_date !== event.date ? event.end_date : '',
    endTime: event.end_time ?? '',
    location: event.location ?? '',
    // '' (does not repeat) first, then every REPEATS key
    repeatChoices: options(['', ...Object.keys(REPEATS)]
      .map(value => [value, t(lang, `event.repeats.${value || 'none'}`)]), event.repeats ?? ''),
    repeatUntil: event.repeat_until ?? '',
    colors: [
      colorChoice('', t(lang, 'event.defaultColor')),
      ...Array.from({ length: COLORS }, (_, i) => colorChoice(i, t(lang, 'event.colorN', { n: i + 1 }))),
    ],
    ...sharingValues(event.is_private, event.groupIds, groups),
    month: (event.date || today()).slice(0, 7),
  });
}

// ---- polls ----

export function pollsPage(user, polls) {
  const { lang } = user;
  const status = poll => {
    if (!poll.closed_at) {
      const values = { voters: poll.voters, members: poll.members };
      return poll.deadline
        ? t(lang, 'polls.openUntil', { ...values, date: formatDate(poll.deadline, user.date_format, lang) })
        : t(lang, 'polls.open', values);
    }
    return poll.chosen_date ? `✓ ${formatDate(poll.chosen_date, user.date_format, lang)}` : t(lang, 'polls.closed');
  };
  return page(t(lang, 'polls.title'), user, 'polls', {
    polls: polls.map(poll => ({
      id: poll.id, title: poll.title, status: status(poll), toAnswer: !poll.closed_at && Boolean(poll.i_owe),
    })),
  });
}

// After a rejected form, `errors` ({ title, dates, deadline, visibility }) shows under each field, and `title`,
// `deadline` and `sharing` (who sees it, as posted) are kept. `groups` are mine: the ones a private poll can be
// shared with.
export const newPollPage = (user, { errors = {}, title = '', deadline = '', groups = [], sharing = {} } = {}) =>
  page(t(user.lang, 'newPoll.title'), user, 'new-poll', {
    errors,
    title,
    deadline,
    today: today(),
    maxDates: MAX_DATES,
    datesLegend: t(user.lang, 'newPoll.dates', { max: MAX_DATES }),
    ...sharingValues(sharing.isPrivate, sharing.groupIds, groups),
  });

// `errors` after a rejected form: `answers` shows under the title, `result` in the result section,
// `visibility` in Who sees it. `event` is null until confirmed, and when I may not see it (it can be made
// private later): then only the confirmed date shows. `creatorGroups` and `groupIds` fill Who sees it.
export function pollPage(user, {
  poll, dates, members, votes, missing, complete, best, event, groupIds = [], creatorGroups = [], errors = {},
  suggested = {},
}) {
  const { lang } = user;
  const answers = {}; // user_id -> { date: answer }
  for (const vote of votes) {
    (answers[vote.user_id] ??= {})[vote.date] = vote.answer;
  }
  const myAnswers = answers[user.id] || {};
  const countAnswer = (date, answer) => votes.filter(vote => vote.date === date && vote.answer === answer).length;
  const formatted = date => formatDate(date, user.date_format, lang);

  const isOpen = !poll.closed_at;
  const canManage = poll.created_by === user.id || Boolean(user.is_admin);
  // The result only makes sense once everyone answered, or the poll was closed early.
  const showResult = (complete || !isOpen) && best.length > 0;
  // You first, then everyone else A to Z. localeCompare puts "Élodie" next to "Eric", not after "Zoé".
  const sortedMembers = members.toSorted((a, b) =>
    (b.id === user.id) - (a.id === user.id) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  let status = t(lang, 'poll.closed');
  if (isOpen) {
    status = complete ? t(lang, 'poll.everyoneAnswered') : t(lang, 'poll.waitingFor', { names: missing.join(', ') });
    if (poll.deadline) {
      status += ' ' + t(lang, 'poll.until', { date: formatted(poll.deadline) });
    }
  }

  const rows = sortedMembers.map(member => {
    const isMe = member.id === user.id;
    return {
      name: isMe ? t(lang, 'poll.you', { name: member.name }) : member.name,
      cells: dates.map(date => {
        const answer = answers[member.id]?.[date];
        // not answered yet: starts on what my free time that day says (loadPoll), saved with the rest
        const suggestion = myAnswers[date] ? null : suggested[date];
        return {
          date,
          editable: isMe && isOpen,
          current: myAnswers[date] ?? null,
          suggested: Boolean(suggestion),
          options: ANSWERS.map(value => ({
            value, label: t(lang, `poll.answers.${value}`), selected: (myAnswers[date] ?? suggestion) === value,
          })),
          answerClass: answer || 'none',
          answerText: answer ? t(lang, `poll.answers.${answer}`) : '–',
        };
      }),
    };
  });

  const result = showResult && {
    heading: t(lang, best.length > 1 ? 'poll.bestDates' : 'poll.bestDate', { dates: best.map(formatted).join(', ') }),
    tied: best.length > 1,
    // a text with bold in it, so shown unescaped: the values going into it are escaped here
    addedAs: event && t(lang, 'poll.addedAs', {
      title: Mustache.escape(event.title), date: Mustache.escape(formatted(event.date)),
    }),
    eventMonth: event && event.date.slice(0, 7),
    confirmedFor: !event && poll.chosen_date ? t(lang, 'poll.confirmedFor', { date: formatted(poll.chosen_date) }) : null,
    choices: best.map(date => ({
      pollId: poll.id, date, label: t(lang, 'poll.addToCalendar', { date: formatted(date) }),
    })),
  };

  return page(poll.title, user, 'poll', {
    errors,
    id: poll.id,
    title: poll.title,
    status,
    isOpen,
    hasSuggestions: isOpen && dates.some(date => !myAnswers[date] && suggested[date]),
    canClose: isOpen && canManage,
    deadline: poll.deadline ?? '',
    today: today(),
    visibilityLabel: t(lang, 'poll.whoSees', { label: t(lang, poll.is_private ? 'poll.private' : 'poll.public') }),
    // the creator (or an admin) can change who sees it, as on the event page
    sharing: canManage && sharingValues(poll.is_private, groupIds, creatorGroups),
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

/** My own link to one group's events feed (routes.js, "ICS feeds"); Rotate in Settings replaces it. */
const groupFeedUrl = (base, user, groupId) => `${base}/feed/${user.feed_token}/groups/${groupId}.ics`;

// `errors` after a rejected Customisation form ({ weekStart, dateFormat }): shown under each field.
// `groups` are the ones I am in: each gets its events feed in the Calendar feeds panel.
// `invites`: my own open invite links, listed under Invite someone while admins allow it (user.member_invites).
// `calendarLinks`: my calendar_links rows, listed under Calendar Integration.
export function settingsPage(user, { base, groups = [], invites = [], calendarLinks = [], msg, errors = {} }) {
  const { lang } = user;
  const birthdaysFeed = `${base}/feed/${user.feed_token}/birthdays.ics`;
  const allEventsFeed = `${base}/feed/${user.feed_token}/events.ics`;
  const weekdays = weekdayNames(0, lang); // by day number

  return page(t(lang, 'settings.title'), user, 'settings', {
    ...notices(msg, lang),
    errors,
    memberInvites: Boolean(user.member_invites),
    invites: invites.map(invite => ({ url: `${base}/invite/${invite.token}` })),
    // Calendar Integration rules (users.busy_minutes, busy_slots, ignore_words, sync_days; src/sync.js)
    busyChoices: options(BUSY_CHOICES.map(minutes => [minutes, t(lang, `settings.busyChoices.${minutes}`)]),
      user.busy_minutes ?? DEFAULT_BUSY_MINUTES),
    syncDaysChoices: options(SYNC_DAYS_CHOICES.map(days => [days, t(lang, `settings.syncDaysChoices.${days}`)]),
      user.sync_days ?? DEFAULT_SYNC_DAYS),
    ignoreWords: user.ignore_words,
    slotNames: SLOTS.map(slot => t(lang, `dayParts.short.${slot}`).toUpperCase()),
    // Always busy: a row per weekday in my week's order, a checkbox per slot, valued '1am' for Monday morning
    busyGrid: weekdayNames(user.week_start, lang).map((name, index) => {
      const day = (user.week_start + index) % 7;
      const busySlots = (user.busy_slots ?? '').split(' ');
      return {
        name,
        slots: SLOTS.map(slot => ({
          value: day + slot,
          label: `${name} ${t(lang, `dayParts.short.${slot}`).toUpperCase()}`,
          checked: busySlots.includes(day + slot),
        })),
      };
    }),
    calendarLinks: calendarLinks.map(link => {
      const synced = link.last_synced_at && wallClock(new Date(link.last_synced_at));
      return {
        id: link.id,
        // the label, or the link's host: the full secret address is not shown again
        name: link.label || new URL(link.url).host,
        synced: synced && t(lang, 'settings.synced', {
          when: `${formatDate(synced.slice(0, 10), user.date_format, lang)} ${formatTime(synced.slice(11), user.hour12)}`,
        }),
        error: link.last_error && syncErrorText(lang, link.last_error),
        countFree: Boolean(link.count_free),
      };
    }),
    // shown under the title; bump it in package.json
    versionLabel: t(lang, 'settings.version', { version: packageJson.version }),
    birthdays: { ...feedLink(lang, t(lang, 'feeds.birthdays'), birthdaysFeed), webcal: webcal(birthdaysFeed) },
    // only offered while groups are off, when there are no group feeds (the route refuses it otherwise)
    allEvents: { ...feedLink(lang, t(lang, 'feeds.allEvents'), allEventsFeed), webcal: webcal(allEventsFeed) },
    groupFeeds: groups.map(group => {
      const feed = groupFeedUrl(base, user, group.id);
      return { ...feedLink(lang, group.name, feed), webcal: webcal(feed) };
    }),
    weekStarts: options(WEEK_START_CHOICES.map(day => [day, weekdays[day]]), user.week_start),
    // Each format is shown as today's date written that way.
    dateFormats: options(Object.keys(DATE_FORMATS).map(key => [key, formatDate(today(), key, lang)]), user.date_format),
    showBirthdays: Boolean(user.show_birthdays),
    hideFreeBorder: Boolean(user.hide_free_border),
    hideOwnInitials: Boolean(user.hide_own_initials),
    continuousCalendar: user.continuous_calendar !== 0, // on unless turned off, like the calendar
  });
}

// ---- profile ----

// After a rejected form, `errors` shows under each field ({ name, birthday, color } in About me,
// { current, password } in Security), and `about` holds the About me values as they were typed.
export function profilePage(user, { passkeys, msg, errors = {}, about = user }) {
  const { lang } = user;
  return page(t(lang, 'profile.title'), user, 'profile', {
    ...notices(msg, lang),
    errors,
    name: about.name,
    birthday: about.birthday ?? '',
    today: today(),
    color: about.color,
    isPrivate: Boolean(about.is_private ?? user.is_private),
    maxColor: COLORS - 1,
    initials: initials(about.name || user.name),
    minPassword: MIN_PASSWORD,
    newPasswordLabel: t(lang, 'profile.newPassword', { min: MIN_PASSWORD }),
    passkeys: passkeys.map(passkey => ({
      id: passkey.id,
      label: passkey.label,
      added: t(lang, 'profile.added', { date: formatDate(passkey.created_at.slice(0, 10), user.date_format, lang) }),
    })),
  });
}

// ---- administration (admin only; the route enforces it, this only draws it) ----

// `errors.members` after a rejected member action: shown under the Members title.
export function adminPage(user, { base, invites, members, log, msg, errors = {} }) {
  const { lang } = user;
  return page(t(lang, 'admin.title'), user, 'admin', {
    ...notices(msg, lang),
    errors,
    members: members.map(member => ({
      ...member,
      isMe: member.id === user.id,
      confirmRemove: t(lang, 'admin.confirmRemove', { name: member.name }),
    })),
    memberInvites: Boolean(user.member_invites),
    invites: invites.map(invite => ({
      // a member's own link (Settings, when Options allows it) says whose it is
      label: invite.user_name ? t(lang, 'admin.resetFor', { name: invite.user_name })
        : invite.created_by && invite.created_by !== user.id ? t(lang, 'admin.inviteFrom', { name: invite.creator })
          : t(lang, 'admin.invite'),
      url: `${base}/invite/${invite.token}`,
    })),
    // Newest first. Times are stored as local ISO strings: the date part is formatted, the clock kept.
    log: log.toReversed().map(entry => ({
      number: entry.number,
      time: `${formatDate(entry.time.slice(0, 10), user.date_format, lang)} ${entry.time.slice(11, 19)}`,
      ip: entry.ip,
      user: entry.user,
      known: entry.known,
      action: entry.action,
    })),
  });
}
