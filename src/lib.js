// Pure helpers: no DB, no HTTP. Covered by test.js.

export const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

// Dates are plain 'YYYY-MM-DD' strings in UTC everywhere: DB, forms, URLs and ICS.
export const today = () => new Date().toISOString().slice(0, 10);

export const isValidMonth = text => /^\d{4}-(0[1-9]|1[0-2])$/.test(text || '');

// A real calendar date within two years of now. Anything else (including junk) is rejected.
export function isValidDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text || '')) return false;
  const date = new Date(text + 'T00:00:00Z');
  if (Number.isNaN(date.getTime())) return false;
  // Round-trip check: Date rolls 2026-02-30 forward into March instead of failing.
  if (date.toISOString().slice(0, 10) !== text) return false;
  const year = date.getUTCFullYear();
  const currentYear = new Date().getUTCFullYear();
  return year >= currentYear - 2 && year <= currentYear + 2;
}

export function addDays(isoDate, days) {
  const date = new Date(isoDate + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Everything calendarPage needs to draw one month, given 'YYYY-MM'.
export function monthInfo(yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const lastDay = new Date(Date.UTC(year, month, 0)); // day 0 of the next month
  return {
    days: lastDay.getUTCDate(),
    pad: (firstDay.getUTCDay() + 6) % 7, // empty cells before day 1, in a Monday-first grid
    prev: new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7),
    next: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7),
    label: firstDay.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

// Calendar day states -> CSS class of the same name in style.css "/* day states */".
// Add a state: one predicate here + one CSS rule. All matching states apply.
export const DAY_STATES = {
  all: ({ who, members }) => who.length > 0 && who.length >= members, // everyone free: green + check
  mine: ({ mine }) => mine,                                          // I am free: accent outline
};
export const dayClass = day => Object.keys(DAY_STATES).filter(state => DAY_STATES[state](day)).join(' ');

// User colors: palette index -> .c0 .. .c12 in style.css. Add a .cN rule there and bump COLORS.
export const COLORS = 13;
export const randomColor = () => Math.floor(Math.random() * COLORS);

// Poll size cap: enforced in routes.js, rendered as fieldset data-max for public/app.js.
export const MAX_DATES = 30;

// The three poll answers. Mirrors the CHECK constraint on poll_votes.answer in db.js.
export const ANSWERS = ['yes', 'maybe', 'no'];

// Most "yes", then fewest "no", then earliest date. Returns every date tied at the top,
// so the UI can ask the user to pick. votes: [{ date, answer }]; "maybe" counts for neither side.
export function bestDates(dates, votes) {
  if (!dates.length) return [];

  const tally = Object.fromEntries(dates.map(date => [date, { yes: 0, no: 0 }]));
  for (const vote of votes) {
    const counts = tally[vote.date];
    if (counts && vote.answer in counts) counts[vote.answer]++;
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

// items: [{ uid, date 'YYYY-MM-DD', summary, stamp (ISO), transparent? }]
// transparent marks an event as "does not block my time", used by the "who is free" feed.
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
    lines.push(
      'BEGIN:VEVENT',
      `UID:${item.uid}@${host}`,
      'DTSTAMP:' + icsTimestamp(item.stamp),
      // All-day event: DTEND is exclusive, so it points at the next day.
      'DTSTART;VALUE=DATE:' + item.date.replaceAll('-', ''),
      'DTEND;VALUE=DATE:' + addDays(item.date, 1).replaceAll('-', ''),
      'SUMMARY:' + escapeIcsText(item.summary));
    if (item.transparent) lines.push('TRANSP:TRANSPARENT');
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
