import ical from 'node-ical';
import { all, get, run, now, tx } from './db.js';
import { addDays, wallClock, today, SLOTS, DEFAULT_BUSY_MINUTES, DEFAULT_SYNC_DAYS } from './lib.js';

// ---- Calendar Integration: free days worked out from members' own calendars (secret iCal links) ----
// Every hour (server.js) each member's links are read, and each of their next sync_days days (today included)
// gets the parts of it events do not take up: no event at all = free all day. The member's rules (Settings) say how
// much makes a part busy, which parts always are, which titles to leave out, and how many days to fill. Days the
// member set by hand (manual_days, written by POST /free) are never touched. Declined invitations are not in
// Google's feed at all.

const FETCH_TIMEOUT_MS = 10_000;
const MAX_CALENDAR_BYTES = 5 * 1024 * 1024;

// Each slot's wall-clock hours, start included, end excluded. Before 6:00 belongs to no slot.
const SLOT_HOURS = { am: [6, 12], pm: [12, 18], eve: [18, 24] };

/** "YYYY-MM-DD HH:MM" wall-clock time -> minutes, for lengths. Read as UTC, so a DST switch adds no hour. */
const toMinutes = wallClockTime => Date.parse(wallClockTime.replace(' ', 'T') + ':00Z') / 60_000;

/**
 * One event instance as wall-clock minutes (toMinutes), [start, end), in TIME_ZONE.
 * An all-day event's dates are midnights in the server's own zone, so its day is read with local getters.
 */
function wallClockSpan(instance) {
  if (instance.isFullDay) {
    const day = date => [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map(number => String(number).padStart(2, '0')).join('-');
    return [toMinutes(`${day(instance.start)} 00:00`), toMinutes(`${day(instance.end ?? instance.start)} 00:00`)];
  }
  const start = toMinutes(wallClock(instance.start));
  return [start, instance.end ? toMinutes(wallClock(instance.end)) : start]; // no end: an instant, takes nothing
}

/** A member's ignore_words as the lowercase words a title is checked for. */
const ignoredWords = ignoreWords => ignoreWords.toLowerCase().split(',').map(word => word.trim()).filter(Boolean);

/** Busy minutes inside [slotStart, slotEnd): the spans' overlaps added up, time two spans share counted once. */
function busyMinutes(busy, slotStart, slotEnd) {
  const inSlot = busy.map(([start, end]) => [Math.max(start, slotStart), Math.min(end, slotEnd)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let coveredUntil = slotStart;
  for (const [start, end] of inSlot) {
    total += Math.max(0, end - Math.max(start, coveredUntil));
    coveredUntil = Math.max(coveredUntil, end);
  }
  return total;
}

/** The slots of `date` that the busy spans (wall-clock minutes) fill for at least `threshold` minutes. */
function takenSlots(date, busy, threshold) {
  const midnight = toMinutes(`${date} 00:00`);
  return SLOTS.filter(slot => {
    const [slotStart, slotEnd] = SLOT_HOURS[slot].map(hour => midnight + hour * 60);
    return busyMinutes(busy, slotStart, slotEnd) >= threshold;
  });
}

/** A Meshtime events row as wall-clock minutes like wallClockSpan. A start time with no end takes its whole slot. */
function eventSpan({ date, end_date: endDate, start_time: startTime, end_time: endTime }) {
  const midnight = toMinutes(`${date} 00:00`);
  if (!startTime) {
    return [midnight, toMinutes(`${addDays(endDate, 1)} 00:00`)];
  }
  if (endTime) {
    return [toMinutes(`${date} ${startTime}`), toMinutes(`${endDate} ${endTime}`)];
  }
  // ponytail: "Dinner 19:00" means the evening here, where an iCal feed would read an instant that takes nothing
  const hour = Number(startTime.slice(0, 2));
  const hours = Object.values(SLOT_HOURS).find(([from, to]) => from <= hour && hour < to);
  return hours ? hours.map(slotHour => midnight + slotHour * 60) : [midnight, midnight];
}

/**
 * A member's free parts of `date` (['all'] or slots, as free_days holds them) without what Meshtime `events`
 * take up, by their Calendar Integration rules: busy_minutes and ignore_words. Their always-busy slots are left
 * out: the day already has them, or the member set it by hand. [] when nothing is left.
 */
export function freePartsAround(parts, date, events, {
  busy_minutes: busyThreshold = DEFAULT_BUSY_MINUTES, ignore_words: ignoreWords = '',
} = {}) {
  const words = ignoredWords(ignoreWords);
  const busy = events.filter(event => !words.some(word => event.title.toLowerCase().includes(word))).map(eventSpan);
  const taken = takenSlots(date, busy, busyThreshold);
  const free = (parts.includes('all') ? SLOTS : parts).filter(slot => !taken.includes(slot));
  return free.length === SLOTS.length ? ['all'] : free;
}

/**
 * The parsed calendars (node-ical's parseICS output, several are merged) -> Map(date -> free parts) for
 * every day from `fromDate` to `toDate`: ['all'], one or two slots, or [] when every slot is busy.
 * Cancelled events block nothing; events shown as Free are left out beforehand if needed (withoutFreeEvents).
 * `rules` is the member's users row (busy_minutes, busy_slots, ignore_words); left out, the defaults.
 */
export function freePartsByDay(calendars, fromDate, toDate, {
  busy_minutes: busyThreshold = DEFAULT_BUSY_MINUTES, busy_slots: busySlots = '', ignore_words: ignoreWords = '',
} = {}) {
  const words = ignoredWords(ignoreWords);
  const alwaysBusy = new Set(busySlots.split(' '));
  // a day either side, so an event crossing a window edge in another timezone is still seen
  const from = new Date(addDays(fromDate, -1) + 'T00:00:00Z');
  const to = new Date(addDays(toDate, 2) + 'T00:00:00Z');
  const busy = [];
  for (const calendar of calendars) {
    for (const event of Object.values(calendar)) {
      if (event.type !== 'VEVENT' || event.status === 'CANCELLED') {
        continue;
      }
      for (const instance of ical.expandRecurringEvent(event, { from, to, expandOngoing: true })) {
        // the instance's own title: a moved occurrence can be renamed. With LANGUAGE it is { params, val }.
        const title = String(instance.summary?.val ?? instance.summary ?? '').toLowerCase();
        if (words.some(word => title.includes(word))) {
          continue;
        }
        busy.push(wallClockSpan(instance));
      }
    }
  }

  const days = new Map();
  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const taken = takenSlots(date, busy, busyThreshold);
    const freeSlots = SLOTS.filter(slot => !alwaysBusy.has(weekday + slot) && !taken.includes(slot));
    days.set(date, freeSlots.length === SLOTS.length ? ['all'] : freeSlots);
  }
  return days;
}

/** A parsed calendar without its events shown as Free (TRANSP:TRANSPARENT, Google's "Show as: Free"). */
export const withoutFreeEvents = calendar =>
  Object.fromEntries(Object.entries(calendar).filter(([, event]) => event.transparency !== 'TRANSPARENT'));

/**
 * Downloads and parses one secret iCal link. Throws an Error whose message can be shown to the member: our own are a
 * key in src/locales, with the HTTP status after a space for sync.httpStatus (syncErrorText in src/i18n.js reads
 * them); node-ical's are its own text.
 */
export async function fetchCalendar(url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  } catch (err) {
    // the cause (DNS, TLS, timeout...) is kept for errors.log; the member only sees the message
    throw new Error('sync.unreachable', { cause: err });
  }
  if (!response.ok) {
    throw new Error(`sync.httpStatus ${response.status}`);
  }
  if (Number(response.headers.get('content-length')) > MAX_CALENDAR_BYTES) {
    throw new Error('sync.tooBig');
  }
  const text = await response.text();
  if (text.length > MAX_CALENDAR_BYTES || !text.includes('BEGIN:VCALENDAR')) {
    throw new Error(text.length > MAX_CALENDAR_BYTES ? 'sync.tooBig' : 'sync.notIcal');
  }
  return ical.sync.parseICS(text);
}

/**
 * Reads all of one member's links and rewrites their free days in the window. If any link fails, nothing
 * is written: a calendar that is down for an hour must not mark every day free.
 */
export async function syncUser(userId) {
  const links = all('SELECT id, url, count_free, last_error FROM calendar_links WHERE user_id = ?', userId);
  const rules = get('SELECT busy_minutes, busy_slots, ignore_words, sync_days FROM users WHERE id = ?', userId);
  if (links.length === 0) {
    return;
  }
  const calendars = [];
  let failed = false;
  for (const link of links) {
    try {
      const calendar = await fetchCalendar(link.url);
      calendars.push(link.count_free ? calendar : withoutFreeEvents(calendar));
      run('UPDATE calendar_links SET last_synced_at = ?, last_error = NULL WHERE id = ?', now(), link.id);
    } catch (err) {
      failed = true;
      // Only when the error changes: a link that stays broken would otherwise add an entry every hour.
      // The URL itself is a secret (it reads the member's calendar), so only its host is logged.
      if (err.message !== link.last_error) {
        console.warn('Calendar link failed to sync',
          { linkId: link.id, userId, host: URL.parse(link.url)?.host }, err);
      }
      run('UPDATE calendar_links SET last_error = ? WHERE id = ?', err.message, link.id);
    }
  }
  if (failed) {
    return;
  }

  const fromDate = today();
  const toDate = addDays(fromDate, (rules.sync_days ?? DEFAULT_SYNC_DAYS) - 1);
  const days = freePartsByDay(calendars, fromDate, toDate, rules);
  tx(() => {
    // past the window (it was made shorter): no longer the calendar's to fill, so not free until set by hand
    run(`DELETE FROM free_days WHERE user_id = ? AND date > ?
         AND date NOT IN (SELECT date FROM manual_days WHERE user_id = ?)`, userId, toDate, userId);
    for (const [date, parts] of days) {
      if (get('SELECT 1 FROM manual_days WHERE user_id = ? AND date = ?', userId, date)) {
        continue;
      }
      if (parts.length === 0) {
        run('DELETE FROM free_days WHERE user_id = ? AND date = ?', userId, date);
      } else {
        run(`INSERT INTO free_days(user_id, date, part, part2) VALUES (?,?,?,?)
          ON CONFLICT DO UPDATE SET part = excluded.part, part2 = excluded.part2`,
        userId, date, parts[0], parts[1] ?? null);
      }
    }
  });
}

/** Every member with a link, one after the other. Never throws: it runs on a timer. */
export async function syncAll() {
  for (const { user_id: userId } of all('SELECT DISTINCT user_id FROM calendar_links')) {
    try {
      await syncUser(userId);
    } catch (err) {
      console.error('Calendar sync failed for user', userId, err);
    }
  }
}
