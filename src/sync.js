import ical from 'node-ical';
import { all, get, run, now, tx } from './db.js';
import { addDays, wallClock, SLOTS, BUSY_HOURS } from './lib.js';

// ---- Calendar Integration: free days worked out from members' own calendars (secret iCal links) ----
// Every hour (server.js) each member's links are read, and every day from today to SYNC_DAYS ahead gets
// the parts of it events do not take up (BUSY_HOURS): no event at all = free all day. Days the member set by hand
// (manual_days, written by POST /free) are never touched.

export const SYNC_DAYS = 60;
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

/**
 * The parsed calendars (node-ical's parseICS output, several are merged) -> Map(date -> free parts) for
 * every day from `fromDate` to `toDate`: ['all'], one or two slots, or [] when every slot is busy.
 * Cancelled events block nothing; events shown as Free are left out beforehand if needed (withoutFreeEvents).
 */
export function freePartsByDay(calendars, fromDate, toDate) {
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
        busy.push(wallClockSpan(instance));
      }
    }
  }

  // busy minutes inside [slotStart, slotEnd): the events' overlaps added up, time two events share counted once
  const busyMinutes = (slotStart, slotEnd) => {
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
  };

  const days = new Map();
  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    const midnight = toMinutes(`${date} 00:00`);
    const freeSlots = SLOTS.filter(slot => {
      const [slotStart, slotEnd] = SLOT_HOURS[slot].map(hour => midnight + hour * 60);
      return busyMinutes(slotStart, slotEnd) < BUSY_HOURS * 60;
    });
    days.set(date, freeSlots.length === SLOTS.length ? ['all'] : freeSlots);
  }
  return days;
}

/** A parsed calendar without its events shown as Free (TRANSP:TRANSPARENT, Google's "Show as: Free"). */
export const withoutFreeEvents = calendar =>
  Object.fromEntries(Object.entries(calendar).filter(([, event]) => event.transparency !== 'TRANSPARENT'));

/** Downloads and parses one secret iCal link. Throws an Error whose message can be shown to the member. */
export async function fetchCalendar(url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  } catch {
    throw new Error('Could not reach that link.');
  }
  if (!response.ok) {
    throw new Error(`The calendar answered ${response.status}. Check that the link is the secret iCal address.`);
  }
  if (Number(response.headers.get('content-length')) > MAX_CALENDAR_BYTES) {
    throw new Error('That calendar is too big (over 5 MB).');
  }
  const text = await response.text();
  if (text.length > MAX_CALENDAR_BYTES || !text.includes('BEGIN:VCALENDAR')) {
    throw new Error(text.length > MAX_CALENDAR_BYTES ? 'That calendar is too big (over 5 MB).'
      : 'That link is not an iCal calendar.');
  }
  return ical.sync.parseICS(text);
}

/** Today's date in TIME_ZONE. */
export const syncToday = () => wallClock(new Date()).slice(0, 10);

/**
 * Reads all of one member's links and rewrites their free days in the window. If any link fails, nothing
 * is written: a calendar that is down for an hour must not mark every day free.
 */
export async function syncUser(userId) {
  const links = all('SELECT id, url, count_free FROM calendar_links WHERE user_id = ?', userId);
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
      run('UPDATE calendar_links SET last_error = ? WHERE id = ?', err.message, link.id);
    }
  }
  if (failed) {
    return;
  }

  const fromDate = syncToday();
  const days = freePartsByDay(calendars, fromDate, addDays(fromDate, SYNC_DAYS));
  tx(() => {
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
