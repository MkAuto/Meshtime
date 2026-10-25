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
  weekdays: intlNames(intl, { weekday: 'short' }, 7, index => Date.UTC(2023, 0, 1 + index)),
  monthYear: new Intl.DateTimeFormat(intl, { month: 'long', year: 'numeric', timeZone: 'UTC' }),  // October 2026
  monthDay: new Intl.DateTimeFormat(intl, { month: 'short', day: 'numeric', timeZone: 'UTC' }),   // Nov 1, 1 nov.
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
// How many days from today it fills (users.sync_days): 1, 2 or 3 weeks, or 1, 1.5 or 2 months of 30 days
// (labels: settings.syncDaysChoices).
export const SYNC_DAYS_CHOICES = [7, 14, 21, 30, 45, 60];
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

// ---- event times ----
// Times are 'HH:MM' wall-clock strings with no timezone: whatever the group means by "19:00".

export const isValidTime = text => /^([01]\d|2[0-3]):[0-5]\d$/.test(text || '');

/**
 * Why an event's when is unusable, or null when it is fine. endDate/times may be null.
 * `field` says which row of the event form the message goes under: 'start' (date + time) or 'end'.
 * `message` is its key in src/locales.
 */
export function eventError({ date, endDate, startTime, endTime, repeats = null, repeatUntil = null }) {
  if (!isValidDate(date)) {
    return { field: 'start', message: 'errors.event.startDate' };
  }
  if (repeats && !Object.hasOwn(REPEATS, repeats)) {
    return { field: 'repeat', message: 'errors.event.repeat' };
  }
  if (repeats && repeatUntil && (!isValidDate(repeatUntil) || repeatUntil < date)) {
    return { field: 'repeat', message: 'errors.event.repeatUntil' };
  }
  // each one must end before the next starts: a week-long event cannot come back every week
  const { days, months } = REPEATS[repeats] ?? {};
  if (repeats && isValidDate(endDate) && daysBetween(date, endDate) >= (days ?? 28 * months)) {
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
// events.repeats: how often an event comes back (NULL: never), until events.repeat_until if set (the last date
// one may start). Its own date..end_date is the first; every other one is the same length, moved by a step.
// A month without that day (the 31st, February 29) has none, as RRULE does.
export const REPEATS = {
  weekly: { days: 7, rrule: 'FREQ=WEEKLY' },
  biweekly: { days: 14, rrule: 'FREQ=WEEKLY;INTERVAL=2' },
  monthly: { months: 1, rrule: 'FREQ=MONTHLY' },
  yearly: { months: 12, rrule: 'FREQ=YEARLY' },
};

const daysBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / 864e5;

/** The start of occurrence `n` (0 = the event's own date), or null when that month has no such day. */
function occurrenceDate(date, { days, months }, n) {
  if (days) {
    return addDays(date, days * n);
  }
  const [year, month, day] = date.split('-').map(Number);
  const moved = new Date(Date.UTC(year, month - 1 + months * n, day));
  return moved.getUTCDate() === day ? moved.toISOString().slice(0, 10) : null;
}

/**
 * Every occurrence of `events` that touches from..to, each a copy of its event at its own date and end_date,
 * sorted like the calendar lists them: by day, all-day first, then by start time. One that does not repeat is
 * its own only occurrence.
 * ponytail: walks each repeating event from its first date, fine for years of weekly events; jump straight to
 * `from` if a group ever has thousands.
 */
export function occurrences(events, from, to) {
  const found = [];
  for (const event of events) {
    const repeat = REPEATS[event.repeats];
    const length = daysBetween(event.date, event.end_date);
    for (let n = 0; ; n++) {
      const date = repeat ? occurrenceDate(event.date, repeat, n) : event.date;
      if (date > to || (repeat && event.repeat_until && date > event.repeat_until)) {
        break;
      }
      const endDate = date && addDays(date, length);
      if (date && endDate >= from) {
        found.push({ ...event, date, end_date: endDate });
      }
      if (!repeat) {
        break;
      }
    }
  }
  return found.sort((a, b) => a.date.localeCompare(b.date) || Boolean(a.start_time) - Boolean(b.start_time)
    || (a.start_time ?? '').localeCompare(b.start_time ?? '') || a.id - b.id);
}

export const DEFAULT_WEEK_START = 0; // Sunday
// The first days a member may pick, in the order Settings lists them: Saturday, Sunday, Monday.
export const WEEK_START_CHOICES = [6, 0, 1];
/** A member or event color: an index into the COLORS hues. */
export const isValidColor = value => Number.isInteger(value) && value >= 0 && value < COLORS;

export const isValidWeekStart = value => WEEK_START_CHOICES.includes(value);
/** The short weekday names of `lang`, starting from weekStart (0 = Sunday): ['Mon', 'Tue', ...]. */
export function weekdayNames(weekStart, lang) {
  const { weekdays } = namesIn(lang);
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

/** The RRULE of a repeating events row (REPEATS), null for one that does not repeat. UNTIL is the same kind of
 *  value as DTSTART (RFC 5545): a date for an all-day event, a floating time at the end of that day otherwise. */
export function eventRrule({ repeats, repeat_until: until, start_time: startTime }) {
  if (!REPEATS[repeats]) {
    return null;
  }
  const end = until && (startTime ? icsLocalTime(until, '23:59') : until.replaceAll('-', ''));
  return REPEATS[repeats].rrule + (end ? `;UNTIL=${end}` : '');
}

// items: [{ uid, date 'YYYY-MM-DD', endDate?, startTime?, endTime?, summary, location?, rrule?, stamp (ISO) }]
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
      lines.push('RRULE:' + item.rrule);
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
