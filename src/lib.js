import { createHash, createPublicKey, verify } from 'node:crypto';

// Pure helpers: no DB, no HTTP. Covered by test.js.

export const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

// Dates are plain 'YYYY-MM-DD' strings in UTC everywhere: DB, forms, URLs and ICS.
export const today = () => new Date().toISOString().slice(0, 10);

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

export function addDays(isoDate, days) {
  const date = new Date(isoDate + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Written out by hand: Intl's short months drop the period ("Sept" in en-GB, "Sep" in en-US).
const SHORT_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];

const pad2 = number => String(number).padStart(2, '0');

// How a member wants dates shown (users.date_format). Display only: storage, forms and URLs stay 'YYYY-MM-DD'.
export const DATE_FORMATS = {
  'd-mon-y': (year, month, day) => `${day} ${SHORT_MONTHS[month - 1]} ${year}`,   // 29 Sept. 2026
  'mon-d-y': (year, month, day) => `${SHORT_MONTHS[month - 1]} ${day}, ${year}`,  // Sept. 29, 2026
  'dd/mm/yyyy': (year, month, day) => `${pad2(day)}/${pad2(month)}/${year}`,      // 29/09/2026
  'mm/dd/yyyy': (year, month, day) => `${pad2(month)}/${pad2(day)}/${year}`,      // 09/29/2026
  'yyyy-mm-dd': (year, month, day) => `${year}-${pad2(month)}-${pad2(day)}`,      // 2026-09-29
};

export const DEFAULT_DATE_FORMAT = 'd-mon-y';
export const isValidDateFormat = value => Object.hasOwn(DATE_FORMATS, value);

export function formatDate(isoDate, format) {
  const match = /^(\d{4})-(\d\d)-(\d\d)$/.exec(isoDate ?? '');
  if (!match) {
    return isoDate;
  }
  const render = DATE_FORMATS[isValidDateFormat(format) ? format : DEFAULT_DATE_FORMAT];
  return render(...match.slice(1).map(Number));
}

// ---- event times ----
// Times are 'HH:MM' wall-clock strings with no timezone: whatever the group means by "19:00".

export const isValidTime = text => /^([01]\d|2[0-3]):[0-5]\d$/.test(text || '');

/** Why an event's when is unusable, or null when it is fine. endDate/times may be null. */
export function eventError({ date, endDate, startTime, endTime }) {
  if (!isValidDate(date)) {
    return 'A valid start date is required.';
  }
  if (endDate && (!isValidDate(endDate) || endDate < date)) {
    return 'The end date must be on or after the start date.';
  }
  if ((startTime && !isValidTime(startTime)) || (endTime && !isValidTime(endTime))) {
    return 'Invalid time.';
  }
  if (endTime && !startTime) {
    return 'An end time needs a start time.';
  }
  const multiDay = endDate && endDate !== date;
  // A timed event over several days has no sensible end without one (the ICS feed needs it).
  if (multiDay && startTime && !endTime) {
    return 'A timed event over several days needs an end time.';
  }
  if (!multiDay && endTime && endTime <= startTime) {
    return 'The end time must be after the start time.';
  }
  return null;
}

/** '3 Oct. 2026 19:00–22:00', '3 Oct. 2026 – 5 Oct. 2026', ... in the member's date format. */
export function formatEventWhen({ date, end_date, start_time, end_time }, format) {
  const start = formatDate(date, format) + (start_time ? ' ' + start_time : '');
  if (end_date && end_date !== date) {
    return `${start} – ${formatDate(end_date, format)}${end_time ? ' ' + end_time : ''}`;
  }
  return end_time ? `${start}–${end_time}` : start;
}

/**
 * Event id -> lane (0 = top row) for every multi-day event, so its bar sits at the same height on each
 * day it covers. Greedy: each event takes the lowest lane whose last event ended before it starts.
 * `events` must be sorted by start date. One-day events get no lane; they are listed under the bars.
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
    lanes.set(event.id, lane);
  }
  return lanes;
}

// Weekday names in getUTCDay() order, so index == day number. weekStart rotates them.
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DEFAULT_WEEK_START = 0; // Sunday
// The first days a member may pick, in the order Settings lists them: Saturday, Sunday, Monday.
export const WEEK_START_CHOICES = [6, 0, 1];
export const isValidWeekStart = value => WEEK_START_CHOICES.includes(value);
export const weekdayNames = weekStart => [...WEEKDAYS.slice(weekStart), ...WEEKDAYS.slice(0, weekStart)];

// Everything calendarPage needs to draw one month, given 'YYYY-MM'.
// weekStart is the user's first day of the week (0 = Sunday .. 6 = Saturday).
export function monthInfo(yearMonth, weekStart = DEFAULT_WEEK_START) {
  const [year, month] = yearMonth.split('-').map(Number);
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const lastDay = new Date(Date.UTC(year, month, 0)); // day 0 of the next month
  return {
    days: lastDay.getUTCDate(),
    pad: (firstDay.getUTCDay() - weekStart + 7) % 7, // empty cells before day 1
    prev: new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7),
    next: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7),
    label: firstDay.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

// Calendar day states -> CSS class of the same name in style.css "/* day states */".
// Add a state: one predicate here + one CSS rule. All matching states apply.
// Which part of a day a member is free (free_days.part). 'all' is what a plain click sets and covers
// the three others. Changing this list rebuilds free_days on the next start (see src/db.js).
export const DAY_PARTS = ['all', 'am', 'pm', 'eve'];
export const isValidDayPart = value => DAY_PARTS.includes(value);
const SLOTS = DAY_PARTS.filter(part => part !== 'all'); // morning, afternoon, evening

/** How many of `who` are free during one slot of the day: all-day members count for every slot. */
const freeDuring = (who, slot) => who.filter(member => member.part === 'all' || member.part === slot).length;

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
  .replace(/\r?\n/g, '\\n');

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

// items: [{ uid, date 'YYYY-MM-DD', endDate?, startTime?, endTime?, summary, stamp (ISO) }]
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
    lines.push('SUMMARY:' + escapeIcsText(item.summary), 'END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---- WebAuthn / passkeys ----
// The one security boundary of passkey login, kept pure so test.js can exercise it without a DB.
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
