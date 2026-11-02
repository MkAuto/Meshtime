import { createHash, createPublicKey, verify } from 'node:crypto';

// Pure helpers: no DB, no HTTP. Covered by test/lib.test.js (and test/auth.test.js, test/ics.test.js).

export const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

// ---- languages ----
// Every language the app speaks: its code (users.language, the lang cookie, src/locales/<code>.json), its name in
// itself (the language menu) and the Intl locale its month and weekday names come from. Adding one: a
// src/locales/<code>.json and a line here (README, "Adding a language").
export const LANGUAGES = [
  { code: 'en', name: 'English', intl: 'en' },
  { code: 'fr', name: 'Français', intl: 'fr-CA' },
];
export const DEFAULT_LANGUAGE = 'en';
export const isValidLanguage = code => LANGUAGES.some(language => language.code === code);

/**
 * The language a request is shown in: the member's own pick (users.language), else the lang cookie (picked while
 * logged out), else the first of the browser's languages we speak (Accept-Language: 'fr-CA,fr;q=0.9,en;q=0.8'),
 * else English.
 */
export function pickLanguage(saved, cookie, acceptLanguage = '') {
  // ponytail: q-values ignored, browsers already list their languages best first
  const browser = acceptLanguage.split(',').map(tag => tag.split(';')[0].trim().split('-')[0].toLowerCase());
  return [saved, cookie, ...browser].find(isValidLanguage) ?? DEFAULT_LANGUAGE;
}

// Month and weekday names in each language, from Intl, worked out once: 'Sep' / 'sept.', 'Sun' / 'dim.'.
const intlNames = (intl, options, count, dateAt) => Array.from({ length: count },
  (_, index) => new Intl.DateTimeFormat(intl, { ...options, timeZone: 'UTC' }).format(dateAt(index)));
const NAMES = Object.fromEntries(LANGUAGES.map(({ code, intl }) => [code, {
  months: intlNames(intl, { month: 'short' }, 12, index => Date.UTC(2000, index, 1)),
  // 2023-01-01 was a Sunday: getUTCDay() order, so index == day number
  weekdays: Object.fromEntries(['short', 'long', 'narrow'].map(style =>
    [style, intlNames(intl, { weekday: style }, 7, index => Date.UTC(2023, 0, 1 + index))])),
  monthYear: new Intl.DateTimeFormat(intl, { month: 'long', year: 'numeric', timeZone: 'UTC' }),  // October 2026
  monthDay: new Intl.DateTimeFormat(intl, { month: 'short', day: 'numeric', timeZone: 'UTC' }),   // Nov 1, 1 nov.
  monthDayLong: new Intl.DateTimeFormat(intl, { month: 'long', day: 'numeric', timeZone: 'UTC' }), // November 1
}]));
/** The names of `lang`, English for an unknown one. */
const namesIn = lang => NAMES[lang] ?? NAMES[DEFAULT_LANGUAGE];

// Dates are plain 'YYYY-MM-DD' strings everywhere (DB, forms, URLs and ICS), worked on as UTC midnights.
// Today is the date on the wall clock in TIME_ZONE, the same day Calendar Integration and the logs use.
export const today = () => wallClock(new Date()).slice(0, 10);

export const isValidMonth = text => /^\d{4}-(0[1-9]|1[0-2])$/.test(text || '');

// A real 'YYYY-MM-DD' calendar date, any year. Anything else (including junk) is rejected.
export function isValidDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text || '')) {
    return false;
  }
  const date = new Date(text + 'T00:00:00Z');
  // Round-trip check: Date rolls 2026-02-30 forward into March instead of failing.
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

export function birthdayIn(yearMonth, birthday) {
  if (birthday?.slice(5, 7) !== yearMonth.slice(5)) {
    return null;
  }
  const date = `${yearMonth}-${birthday.slice(8)}`;
  return isValidDate(date) ? date : `${yearMonth}-28`;
}

export const birthdayRrule = birthday =>
  birthday.endsWith('-02-29') ? 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1' : 'FREQ=YEARLY';

export const TIME_ZONE = process.env.TZ || 'UTC';
// Calendar Integration: minutes of events that make a slot busy (users.busy_minutes), as Settings lists them
// (their labels: settings.busyChoices in src/locales). Every slot is 6 h, so 360 = only when events fill it;
// 1 = any event at all.
export const BUSY_CHOICES = [1, 60, 120, 180, 240, 360];
export const DEFAULT_BUSY_MINUTES = 120;
export const isValidBusyMinutes = value => BUSY_CHOICES.includes(value);
// How many days from today it fills (users.sync_days): 1, 2 or 3 weeks, or 1, 1.5, 2, 3, 4, 5 or 6 months of 30 days
// (labels: settings.syncDaysChoices).
export const SYNC_DAYS_CHOICES = [7, 14, 21, 30, 45, 60, 90, 120, 150, 180];
export const DEFAULT_SYNC_DAYS = 30;
export const isValidSyncDays = value => SYNC_DAYS_CHOICES.includes(value);
const wallClockFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIME_ZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

/** A Date as "YYYY-MM-DD HH:MM" in TIME_ZONE. */
export const wallClock = date => wallClockFormat.format(date);

export function addDays(isoDate, days) {
  const date = new Date(isoDate + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const pad2 = number => String(number).padStart(2, '0');

// How a member wants dates shown (users.date_format). Display only: storage, forms and URLs stay 'YYYY-MM-DD'.
// The order is the member's pick in every language; only `mon`, the short month name, follows the language.
export const DATE_FORMATS = {
  'd-mon-y': (year, month, day, mon) => `${day} ${mon} ${year}`,              // 29 Sep 2026, 29 sept. 2026
  'mon-d-y': (year, month, day, mon) => `${mon} ${day}, ${year}`,             // Sep 29, 2026
  'dd/mm/yyyy': (year, month, day) => `${pad2(day)}/${pad2(month)}/${year}`,  // 29/09/2026
  'mm/dd/yyyy': (year, month, day) => `${pad2(month)}/${pad2(day)}/${year}`,  // 09/29/2026
  'yyyy-mm-dd': (year, month, day) => `${year}-${pad2(month)}-${pad2(day)}`,  // 2026-09-29
};

export const DEFAULT_DATE_FORMAT = 'd-mon-y';
export const isValidDateFormat = value => Object.hasOwn(DATE_FORMATS, value);

export function formatDate(isoDate, format, lang) {
  const match = /^(\d{4})-(\d\d)-(\d\d)$/.exec(isoDate ?? '');
  if (!match) {
    return isoDate;
  }
  const render = DATE_FORMATS[isValidDateFormat(format) ? format : DEFAULT_DATE_FORMAT];
  const [year, month, day] = match.slice(1).map(Number);
  return render(year, month, day, namesIn(lang).months[month - 1]);
}

/** '2026-11-01' as the calendar labels a day of the month around: 'Nov 1', '1 nov.' */
export const formatMonthDay = (isoDate, lang) => namesIn(lang).monthDay.format(new Date(isoDate + 'T00:00:00Z'));
/** ... and in full: 'November 1', '1 novembre' */
export const formatMonthDayLong = (isoDate, lang) =>
  namesIn(lang).monthDayLong.format(new Date(isoDate + 'T00:00:00Z'));

// ---- event times ----
// Times are 'HH:MM' wall-clock strings with no timezone: whatever the group means by "19:00".

export const isValidTime = text => /^([01]\d|2[0-3]):[0-5]\d$/.test(text || '');

/**
 * Why an event's when is unusable, or null when it is fine. endDate/times may be null.
 * `field` says which row of the event form the message goes under: 'start' (date + time) or 'end'.
 * `message` is its key in src/locales.
 */
export function eventError({ date, endDate, startTime, endTime, rule = null }) {
  if (!isValidDate(date)) {
    return { field: 'start', message: 'errors.event.startDate' };
  }
  // each time must end before the next starts: a week-long event cannot come back every week (rule: repeatRule)
  if (rule && isValidDate(endDate) && daysBetween(date, endDate) >= ruleGap(rule)) {
    return { field: 'repeat', message: 'errors.event.repeatTooLong' };
  }
  if (endDate && (!isValidDate(endDate) || endDate < date)) {
    return { field: 'end', message: 'errors.event.endDate' };
  }
  if (startTime && !isValidTime(startTime)) {
    return { field: 'start', message: 'errors.event.time' };
  }
  if (endTime && !isValidTime(endTime)) {
    return { field: 'end', message: 'errors.event.time' };
  }
  if (endTime && !startTime) {
    return { field: 'start', message: 'errors.event.endNeedsStart' };
  }
  const multiDay = endDate && endDate !== date;
  // A timed event over several days has no sensible end without one (the ICS feed needs it).
  if (multiDay && startTime && !endTime) {
    return { field: 'end', message: 'errors.event.multiDayEnd' };
  }
  if (!multiDay && endTime && endTime <= startTime) {
    return { field: 'end', message: 'errors.event.endAfterStart' };
  }
  return null;
}

/** An 'HH:MM' time as the member's device writes it (user.hour12, see app.js): '19:05', or '7:05 PM'. */
export function formatTime(time, hour12) {
  if (!hour12) {
    return time;
  }
  const hour = Number(time.slice(0, 2));
  return `${hour % 12 || 12}${time.slice(2)} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** '3 Oct 2026 19:00–22:00', '3 Oct 2026 – 5 Oct 2026', ... in the member's date and time format and language. */
export function formatEventWhen({ date, end_date, start_time, end_time }, format, hour12 = false, lang) {
  const start = formatDate(date, format, lang) + (start_time ? ' ' + formatTime(start_time, hour12) : '');
  if (end_date && end_date !== date) {
    return `${start} – ${formatDate(end_date, format, lang)}${end_time ? ' ' + formatTime(end_time, hour12) : ''}`;
  }
  return end_time ? `${start}–${formatTime(end_time, hour12)}` : start;
}

/**
 * Event -> lane (0 = top row) for every multi-day event, so its bar sits at the same height on each
 * day it covers. Greedy: each event takes the lowest lane whose last event ended before it starts.
 * `events` must be sorted by start date. One-day events get no lane; they are listed under the bars.
 * Keyed by the event object, not its id: the occurrences of a repeating event share one id.
 */
export function eventLanes(events) {
  const lanes = new Map();
  const laneEnds = []; // lane -> end_date of the last event placed in it
  for (const event of events) {
    if (event.end_date <= event.date) {
      continue;
    }
    let lane = laneEnds.findIndex(end => end < event.date);
    if (lane === -1) {
      lane = laneEnds.length;
    }
    laneEnds[lane] = event.end_date;
    lanes.set(event, lane);
  }
  return lanes;
}

// ---- repeating events ----
// events.rrule: how an event comes back, as an RFC 5545 RRULE: the part of one the event form makes (repeatRule),
// FREQ, INTERVAL, BYDAY (a weekly one's weekdays, or which weekday of the month: 2TU, -1FR for the last one) and
// COUNT or UNTIL. NULL: it does not. Its own date..end_date is the first time, always one its rule gives
// (firstTime); every other one is the same length. A month without that day (the 31st, February 29) has none, as
// RRULE says. event_changes (db.js) holds its times changed or skipped one by one, by the date the rule gave them.

export const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']; // getUTCDay() order
export const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
export const MAX_EVERY = 99; // Custom: repeat every 1..99
export const MAX_COUNT = 999; // Ends after 1..999 times

export const daysBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / 864e5;
const weekdayCode = date => WEEKDAY_CODES[new Date(date + 'T00:00:00Z').getUTCDay()];
const mondayFirst = code => (WEEKDAY_CODES.indexOf(code) + 6) % 7; // Monday 0 .. Sunday 6
const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate(); // month 1..12

/** Which of its weekday in its month `date` is: { nth: 1..5, last: true when in the month's last 7 days }. */
export function weekdayInMonth(date) {
  const [year, month, day] = date.split('-').map(Number);
  return { nth: Math.ceil(day / 7), last: day + 7 > daysInMonth(year, month) };
}

/** The day of the month a BYDAY like 2TU (its second Tuesday) or -1FR (its last Friday) is, in year-month. */
function dayByWeekday(year, month, byday) {
  const [, nth, code] = /^(-?\d)(\w\w)$/.exec(byday);
  const weekday = WEEKDAY_CODES.indexOf(code);
  if (nth > 0) {
    return 1 + (weekday - new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 7) % 7 + 7 * (nth - 1);
  }
  const last = daysInMonth(year, month);
  return last - (new Date(Date.UTC(year, month - 1, last)).getUTCDay() - weekday + 7) % 7;
}

/** 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10' as { freq, interval, byday, count, until }. null for none. */
export function parseRrule(text) {
  if (!text) {
    return null;
  }
  const parts = Object.fromEntries(text.split(';').map(part => part.split('=')));
  return {
    freq: parts.FREQ,
    interval: Number(parts.INTERVAL ?? 1),
    byday: parts.BYDAY?.split(','),
    count: parts.COUNT && Number(parts.COUNT),
    until: parts.UNTIL?.replace(/^(\d{4})(\d\d)(\d\d).*/, '$1-$2-$3'),
  };
}

/** The other way. */
export const formatRrule = ({ freq, interval = 1, byday, count, until }) => [
  `FREQ=${freq}`, interval > 1 && `INTERVAL=${interval}`, byday && `BYDAY=${byday.join(',')}`,
  count && `COUNT=${count}`, until && `UNTIL=${until.replaceAll('-', '')}`,
].filter(Boolean).join(';');

/** Whether two rules give the same dates, however each ends. */
export const sameRule = (a, b) =>
  formatRrule({ ...a, count: 0, until: '' }) === formatRrule({ ...b, count: 0, until: '' });

/**
 * Every date `rule` gives from `start` on, in order; endless without COUNT or UNTIL, so stop reading when done.
 * COUNT counts from the first, the skipped ones included, as RFC 5545 has it.
 */
function* ruleDates(start, { freq, interval = 1, byday, count, until }) {
  const [year, month, day] = start.split('-').map(Number);
  let made = 0;
  for (let step = 0; ; step += interval) {
    let dates;
    if (freq === 'DAILY') {
      dates = [addDays(start, step)];
    } else if (freq === 'WEEKLY') {
      const monday = addDays(start, 7 * step - mondayFirst(weekdayCode(start)));
      dates = byday.map(code => addDays(monday, mondayFirst(code))).sort();
    } else {
      const first = new Date(Date.UTC(year, month - 1 + (freq === 'MONTHLY' ? step : 12 * step), 1));
      const [thatYear, thatMonth] = [first.getUTCFullYear(), first.getUTCMonth() + 1];
      const thatDay = byday ? dayByWeekday(thatYear, thatMonth, byday[0]) : day;
      dates = thatDay <= daysInMonth(thatYear, thatMonth) ? [`${thatYear}-${pad2(thatMonth)}-${pad2(thatDay)}`] : [];
    }
    for (const date of dates.filter(date => date >= start)) {
      if ((until && date > until) || made === count) {
        return;
      }
      made++;
      yield date;
    }
  }
}

/** The first date `rule` gives on or after `date`: where a series asked to start then starts. Undefined: none. */
export const firstTime = (date, rule) => ruleDates(date, rule).next().value;

/** How many times the rule of a series starting on `start` gives before `date`. */
export function timesBefore(start, rule, date) {
  let count = 0;
  for (const time of ruleDates(start, rule)) {
    if (time >= date) {
      break;
    }
    count++;
  }
  return count;
}

/** The fewest days between two times `rule` gives: an event must end before it comes back (eventError). */
function ruleGap({ freq, interval = 1, byday }) {
  if (freq !== 'WEEKLY') {
    return { DAILY: 1, MONTHLY: 28, YEARLY: 365 }[freq] * interval;
  }
  const days = byday.map(mondayFirst).sort((a, b) => a - b);
  return Math.min(7 * interval - days.at(-1) + days[0], ...days.slice(1).map((day, i) => day - days[i]));
}

/**
 * The time of a repeating `event` its rule gave `on`, as it shows: moved to that date, with its own changes
 * (event.changes, event_changes as JSON: { [on]: { title, date, ... } }, null for a skipped one). `on` is kept.
 */
export function timeOn(event, on) {
  const changes = JSON.parse(event.changes || '{}')[on];
  return { ...event, date: on, end_date: addDays(on, daysBetween(event.date, event.end_date)), on, ...changes };
}

/**
 * Every time `events` happen that touches from..to, sorted like the calendar lists them: by day, all-day first,
 * then by start time. One that does not repeat is its own only time; a repeating one's are timeOn copies, without
 * the skipped ones.
 * ponytail: walks each repeating event from its first date, fine for years of daily events; jump straight to
 * `from` if a group ever has thousands.
 */
export function occurrences(events, from, to) {
  const found = [];
  for (const event of events) {
    const rule = parseRrule(event.rrule);
    if (!rule) {
      if (event.date <= to && event.end_date >= from) {
        found.push(event);
      }
      continue;
    }
    const changes = JSON.parse(event.changes || '{}');
    // a time moved in from after `to` still counts: the walk goes on to the last changed one
    const last = [to, ...Object.keys(changes)].sort().at(-1);
    for (const on of ruleDates(event.date, rule)) {
      if (on > last) {
        break;
      }
      const time = changes[on] === null ? null : timeOn(event, on);
      if (time && time.date <= to && time.end_date >= from) {
        found.push(time);
      }
    }
  }
  return found.sort((a, b) => a.date.localeCompare(b.date) || Boolean(a.start_time) - Boolean(b.start_time)
    || (a.start_time ?? '').localeCompare(b.start_time ?? '') || a.id - b.id);
}

// The Repeat menu: what each of its choices means for an event starting on `date`.
export const REPEAT_PRESETS = {
  daily: () => ({ freq: 'DAILY', interval: 1 }),
  weekly: date => ({ freq: 'WEEKLY', interval: 1, byday: [weekdayCode(date)] }),
  biweekly: date => ({ freq: 'WEEKLY', interval: 2, byday: [weekdayCode(date)] }),
  monthly: () => ({ freq: 'MONTHLY', interval: 1 }),
  // its second Tuesday; a fifth one is the month's last
  monthlyNth: date => ({ freq: 'MONTHLY', interval: 1,
    byday: [monthlyByday(date, weekdayInMonth(date).nth < 5 ? 'nth' : 'last')] }),
  yearly: () => ({ freq: 'YEARLY', interval: 1 }),
  weekdays: () => ({ freq: 'WEEKLY', interval: 1, byday: ['MO', 'TU', 'WE', 'TH', 'FR'] }),
};

/** Custom's monthly choice for a start date, as a BYDAY: 'nth' its 2TU, 'last' -1TU. Undefined: the date has none. */
function monthlyByday(date, choice) {
  const { nth, last } = weekdayInMonth(date);
  if (choice === 'nth' && nth < 5) {
    return nth + weekdayCode(date);
  }
  if (choice === 'last' && last) {
    return '-1' + weekdayCode(date);
  }
  return undefined;
}

/**
 * The rule the event form's Repeat fields ask for, for an event starting on `date` (a valid one): { rule }, null
 * when it does not repeat, or { error }, a key in src/locales. The fields as posted: repeats (the menu: '', a
 * REPEAT_PRESETS key or 'custom'), Custom's every, unit (FREQS), days (WEEKDAY_CODES) and monthly ('day', 'nth'
 * or 'last'), and ends ('never', 'on' or 'after') with endsOn / endsAfter.
 */
export function repeatRule({ repeats, every, unit, days = [], monthly, ends, endsOn, endsAfter }, date) {
  if (!repeats) {
    return { rule: null };
  }
  let rule;
  if (repeats === 'custom') {
    const interval = Number(every);
    if (!Number.isInteger(interval) || interval < 1 || interval > MAX_EVERY) {
      return { error: 'errors.event.repeatEvery' };
    }
    if (!FREQS.includes(unit) || !days.every(code => WEEKDAY_CODES.includes(code))) {
      return { error: 'errors.event.repeat' };
    }
    rule = { freq: unit, interval };
    if (unit === 'WEEKLY') {
      // none ticked: the start's own weekday, as RRULE has it
      rule.byday = days.length
        ? [...new Set(days)].sort((a, b) => mondayFirst(a) - mondayFirst(b))
        : [weekdayCode(date)];
    } else if (unit === 'MONTHLY' && monthly && monthly !== 'day') {
      rule.byday = [monthlyByday(date, monthly)];
      if (!rule.byday[0]) {
        return { error: 'errors.event.repeat' };
      }
    }
  } else if (Object.hasOwn(REPEAT_PRESETS, repeats)) {
    rule = REPEAT_PRESETS[repeats](date);
  } else {
    return { error: 'errors.event.repeat' };
  }
  if (ends === 'on') {
    if (!isValidDate(endsOn) || endsOn < date) {
      return { error: 'errors.event.repeatUntil' };
    }
    rule.until = endsOn;
  } else if (ends === 'after') {
    const count = Number(endsAfter);
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
      return { error: 'errors.event.repeatCount' };
    }
    rule.count = count;
  }
  return { rule };
}

/** The other way: a saved rule (null: none) as the Repeat fields show it, for an event starting on `date`. */
export function repeatForm(rule, date) {
  const preset = rule && Object.keys(REPEAT_PRESETS).find(name => sameRule(REPEAT_PRESETS[name](date), rule));
  return {
    repeats: rule ? preset ?? 'custom' : '',
    every: rule?.interval ?? 1,
    unit: rule?.freq ?? 'WEEKLY',
    days: rule?.freq === 'WEEKLY' ? rule.byday : [weekdayCode(date)],
    monthly: rule?.freq === 'MONTHLY' && rule.byday ? (rule.byday[0].startsWith('-') ? 'last' : 'nth') : 'day',
    ends: rule?.count ? 'after' : rule?.until ? 'on' : 'never',
    endsOn: rule?.until ?? '',
    endsAfter: rule?.count ?? '',
  };
}

export const DEFAULT_WEEK_START = 0; // Sunday
// The first days a member may pick, in the order Settings lists them: Saturday, Sunday, Monday.
export const WEEK_START_CHOICES = [6, 0, 1];
/** A member or event color: an index into the COLORS hues. */
export const isValidColor = value => Number.isInteger(value) && value >= 0 && value < COLORS;

export const isValidWeekStart = value => WEEK_START_CHOICES.includes(value);
/** The weekday names of `lang`, starting from weekStart (0 = Sunday): ['Mon', ...], ['Monday', ...] or ['M', ...]. */
export function weekdayNames(weekStart, lang, style = 'short') {
  const weekdays = namesIn(lang).weekdays[style];
  return [...weekdays.slice(weekStart), ...weekdays.slice(0, weekStart)];
}

// Everything calendarPage needs to draw one month, given 'YYYY-MM'.
// weekStart is the user's first day of the week (0 = Sunday .. 6 = Saturday); `lang` names the month.
export function monthInfo(yearMonth, weekStart = DEFAULT_WEEK_START, lang) {
  const [year, month] = yearMonth.split('-').map(Number);
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const lastDay = new Date(Date.UTC(year, month, 0)); // day 0 of the next month
  const days = lastDay.getUTCDate();
  const pad = (firstDay.getUTCDay() - weekStart + 7) % 7; // cells before day 1
  const trail = (7 - (pad + days) % 7) % 7; // cells after the last day, to finish its week
  return {
    days,
    pad,
    trail,
    // the whole weeks the month touches, first and last cell: the continuous calendar fills them all
    gridStart: addDays(`${yearMonth}-01`, -pad),
    gridEnd: addDays(`${yearMonth}-${String(days).padStart(2, '0')}`, trail),
    prev: new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7),
    next: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7),
    label: namesIn(lang).monthYear.format(firstDay),
  };
}

// Calendar day states -> CSS class of the same name in style.css "/* day states */".
// Add a state: one predicate here + one CSS rule. All matching states apply.
// Which part of a day a member is free (free_days.part). 'all' is what a plain click sets and covers
// the three others. Changing this list rebuilds free_days on the next start (see src/db.js).
export const DAY_PARTS = ['all', 'am', 'pm', 'eve'];
export const SLOTS = DAY_PARTS.filter(part => part !== 'all'); // morning, afternoon, evening
export const MAX_SLOTS_PER_DAY = 2;

export function toggleSlot(parts, slot) {
  const slots = parts.filter(part => part !== 'all');
  let newSlots;
  if (slots.includes(slot)) {
    newSlots = slots.filter(part => part !== slot);
  } else if (slots.length < MAX_SLOTS_PER_DAY) {
    newSlots = [...slots, slot];
  } else {
    return null;
  }
  return newSlots.sort((a, b) => DAY_PARTS.indexOf(a) - DAY_PARTS.indexOf(b));
}

/** How many of `who` are free during one slot of the day: all-day members count for every slot. */
const freeDuring = (who, slot) =>
  who.filter(member => member.parts.includes('all') || member.parts.includes(slot)).length;

export const DAY_STATES = {
  // everyone free at the same time: green + check. Someone AM-only and someone PM-only never overlap.
  all: ({ who, members }) => members > 0 && SLOTS.some(slot => freeDuring(who, slot) >= members),
  mine: ({ mine }) => mine, // I am free: accent outline
};
export const dayClass = day => Object.keys(DAY_STATES).filter(state => DAY_STATES[state](day)).join(' ');

// User colors: palette index -> .c0 .. .c12 in style.css. Add a .cN rule there and bump COLORS.
export const COLORS = 13;
export const randomColor = () => Math.floor(Math.random() * COLORS);

// Shortest password we accept. Enforced in routes.js and rendered as minlength in views.js,
// so the number lives here only.
export const MIN_PASSWORD = 12;

// Poll size cap: enforced in routes.js, rendered as fieldset data-max for public/app.js.
export const MAX_DATES = 30;

// The three poll answers. Mirrors the CHECK constraint on poll_votes.answer in db.js.
export const ANSWERS = ['yes', 'maybe', 'no'];

// Most "yes", then fewest "no", then earliest date. Returns every date tied at the top,
// so the UI can ask the user to pick. votes: [{ date, answer }]; "maybe" counts for neither side.
export function bestDates(dates, votes) {
  if (!dates.length) {
    return [];
  }

  const tally = Object.fromEntries(dates.map(date => [date, { yes: 0, no: 0 }]));
  for (const vote of votes) {
    const counts = tally[vote.date];
    if (counts && vote.answer in counts) {
      counts[vote.answer]++;
    }
  }

  const ranked = [...dates].sort((a, b) =>
    tally[b].yes - tally[a].yes ||
    tally[a].no - tally[b].no ||
    a.localeCompare(b));

  const winner = tally[ranked[0]];
  return ranked.filter(date => tally[date].yes === winner.yes && tally[date].no === winner.no);
}

// ---- ICS (RFC 5545) ----

const escapeIcsText = value => String(value)
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r\n|\r|\n/g, '\\n')
  .replace(/[\x00-\x1f\x7f]/g, '');

// 2026-09-14T11:40:00.123Z -> 20260914T114000Z
const icsTimestamp = iso => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

// Fold at 75 octets; continuation lines start with a space, so 74 octets of content.
// Iterating characters (not bytes) keeps multi-byte characters whole.
export function fold(line) {
  const chunks = [];
  let current = '';
  for (const char of line) {
    const limit = chunks.length ? 74 : 75;
    if (Buffer.byteLength(current + char) > limit) {
      chunks.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  chunks.push(current);
  return chunks.join('\r\n ');
}

// '2026-10-03' + '19:00' -> 20261003T190000, a floating local time (no Z, no TZID).
// ponytail: floating, so each subscriber's app reads it in its own zone. Fine while the group shares
// one zone; otherwise add TZID=America/Toronto and a VTIMEZONE block.
const icsLocalTime = (date, time) => date.replaceAll('-', '') + 'T' + time.replace(':', '') + '00';

/** An events row's RRULE for a feed. UNTIL is the same kind of value as DTSTART (RFC 5545): the date for an all-day
 *  event, as saved, and a floating time at the end of that day otherwise. */
export const eventRrule = ({ rrule, start_time: startTime }) =>
  rrule && startTime ? rrule.replace(/UNTIL=(\d{8})/, 'UNTIL=$1T235900') : rrule;

// DTSTART and its kind: a floating time, or a date for an all-day event
const icsStart = (date, time) => (time ? ':' + icsLocalTime(date, time) : ';VALUE=DATE:' + date.replaceAll('-', ''));

// items: [{ uid, date 'YYYY-MM-DD', endDate?, startTime?, endTime?, summary, location?, rrule?, stamp (ISO) }]
// A repeating one's skipped times are its exdates (dates). A time of it changed on its own is one more item with
// its uid and recurrenceId: { date, startTime } of the time it replaces, as the repeating one's DTSTART has them.
export function buildIcs({ name, host, items }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//meshtime//EN',
    'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:' + escapeIcsText(name),
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
  ];

  for (const item of items) {
    const endDate = item.endDate || item.date;
    lines.push('BEGIN:VEVENT', `UID:${item.uid}@${host}`, 'DTSTAMP:' + icsTimestamp(item.stamp));
    if (item.recurrenceId) {
      lines.push('RECURRENCE-ID' + icsStart(item.recurrenceId.date, item.recurrenceId.startTime));
    }
    if (item.startTime) {
      lines.push('DTSTART:' + icsLocalTime(item.date, item.startTime));
      // No end time: DTEND left out, which RFC 5545 reads as ending when it starts.
      if (item.endTime) {
        lines.push('DTEND:' + icsLocalTime(endDate, item.endTime));
      }
    } else {
      // All-day event: DTEND is exclusive, so it points at the day after the last one.
      lines.push('DTSTART;VALUE=DATE:' + item.date.replaceAll('-', ''),
        'DTEND;VALUE=DATE:' + addDays(endDate, 1).replaceAll('-', ''));
    }
    if (item.rrule) {
      lines.push('RRULE:' + item.rrule, ...(item.exdates ?? []).map(date => 'EXDATE' + icsStart(date, item.startTime)));
    }
    if (item.location) {
      lines.push('LOCATION:' + escapeIcsText(item.location));
    }
    lines.push('SUMMARY:' + escapeIcsText(item.summary), 'END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---- WebAuthn / passkeys ----
// The one security boundary of passkey login, kept pure so test/auth.test.js can exercise it without a DB.
//
// There is no CBOR decoder here on purpose: the browser hands us the credential public key already
// in SPKI DER (AuthenticatorAttestationResponse.getPublicKey) and the raw authenticator data
// (getAuthenticatorData), so node:crypto can consume both directly. WebAuthn Level 2, so
// Chrome 85+, Firefox 119+, Safari 16.4+.

/** The relying party id passkeys are scoped to. Derived from BASE_URL, so passkeys only work there. */
export const RP_ID = new URL(BASE_URL).hostname;
export const ORIGIN = new URL(BASE_URL).origin;

// COSE algorithms we accept: ES256, RS256, Ed25519. Anything else is refused at registration,
// so verifyWebAuthn never meets an algorithm crypto.verify would need extra options for.
export const COSE_ALGS = [-7, -257, -8];

const sha256Bytes = value => createHash('sha256').update(value).digest();

/**
 * True when an attestation (registration) or assertion (login) is genuine and meant for us.
 * All Buffer arguments. `signature` is absent for registration: attestation is requested as
 * "none", so there is nothing to verify against and checks 1-5 are the whole story.
 *
 * ponytail: no sign-counter / clone detection (synced passkeys all report 0), and
 * userVerification is "preferred". To make the biometric mandatory, also require flag bit 2 below.
 */
export function verifyWebAuthn({ clientDataJSON, authenticatorData, signature, publicKey, alg, type, challenge }) {
  let clientData;
  try { clientData = JSON.parse(clientDataJSON.toString('utf8')); } catch { return false; }

  // 1-3: the browser's side of the story. challenge is base64url, exactly as we issued it.
  if (clientData.type !== type) {
    return false;
  }
  if (clientData.challenge !== challenge) {
    return false;
  }
  if (clientData.origin !== ORIGIN) {
    return false;
  }
  if (clientData.crossOrigin) {
    return false;
  }

  // 4-5: the authenticator's side. 37 bytes is the minimum: rpIdHash(32) + flags(1) + counter(4).
  if (authenticatorData.length < 37) {
    return false;
  }
  if (!authenticatorData.subarray(0, 32).equals(sha256Bytes(RP_ID))) {
    return false;
  }
  if (!(authenticatorData[32] & 1)) {
    return false; // UP: a human actually touched the authenticator
  }

  if (!signature) {
    return true;
  }

  // 6: the signature covers the authenticator data and a hash of everything the browser said.
  const signed = Buffer.concat([authenticatorData, sha256Bytes(clientDataJSON)]);
  try {
    const key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
    // Ed25519 signs the message itself; the others take a digest. ES256 signatures are DER,
    // which is crypto.verify's default dsaEncoding, so there is nothing to configure.
    return verify(alg === -8 ? null : 'sha256', signed, key, signature);
  } catch {
    return false; // unparseable key or malformed signature: not a valid credential
  }
}
