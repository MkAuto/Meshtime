import { all } from './db.js';
import { occurrences, freeParts } from './lib.js';
import { freePartsAround } from './sync.js';

// Who sees whom: the SQL every page (src/routes.js) and AI access (src/api.js) filter people, events and polls with,
// and the free days a member sees, as the calendar draws them.

// While an admin has groups turned off (Administration → Options) everyone and everything is seen as public.
// The private flags and group shares are left as they are, so turning groups back on brings them back.
export const GROUPS_OFF = '(SELECT groups_enabled FROM app_settings) = 0';

// Whose free days and name a viewer may see: their own, and those of anyone sharing a group with them. A public
// event or poll (only made while groups are off) goes with its creator the same way. For a users table aliased `u`. `viewer` is an SQL
// expression: '?' to pass a user id (twice), or a column, to ask it for every user at once (a poll's audience).
export const sharesGroupWith = viewer => `EXISTS (
  SELECT 1 FROM group_members theirs JOIN group_members mine ON mine.group_id = theirs.group_id
  WHERE theirs.user_id = u.id AND mine.user_id = ${viewer})`;
export const visibleTo = viewer => `(${GROUPS_OFF} OR u.id = ${viewer} OR ${sharesGroupWith(viewer)})`;
// Takes my user id twice.
export const VISIBLE_TO_ME = visibleTo('?');
// Whose birthday I see: my own and those of anyone sharing a group with me.
// Takes my user id twice.
export const BIRTHDAY_VISIBLE_TO_ME = `(${GROUPS_OFF} OR u.id = ? OR ${sharesGroupWith('?')})`;
// The one-group view: only that group's members. Takes the group id.
export const IN_GROUP = 'EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = ? AND m.user_id = u.id)';
// The Custom view: me and the people I ticked in its list (custom_view_members). Takes my user id twice. Only ever
// ANDed with one of the *_VISIBLE_TO_ME above, so someone I ticked and can no longer see drops out of it.
export const IN_MY_CUSTOM_VIEW = `(u.id = ? OR EXISTS (
  SELECT 1 FROM custom_view_members c WHERE c.user_id = ? AND c.member_id = u.id))`;

// Events, for events `e` joined to their creator `u`. A public event (is_private = 0) is seen by everyone
// who sees its creator; a private one only by its creator and the members of the groups it is shared with.
// Takes my user id four times.
export const EVENT_VISIBLE_TO_ME = `(${GROUPS_OFF} OR e.created_by = ? OR (e.is_private = 0 AND ${VISIBLE_TO_ME}) OR EXISTS (
  SELECT 1 FROM event_groups shared JOIN group_members mine ON mine.group_id = shared.group_id
  WHERE shared.event_id = e.id AND mine.user_id = ?))`;
// One group's events (its view on the calendar, and its feed): its members' public events, and the private
// ones shared with it. Takes the group id twice.
export const EVENT_IN_GROUP = `(${IN_GROUP} AND (e.is_private = 0 OR EXISTS (
  SELECT 1 FROM event_groups shared WHERE shared.event_id = e.id AND shared.group_id = ?)))`;

// Polls, for polls `p` joined to their creator `u`: the same rule as events, with poll_groups.
// `viewer` as in visibleTo: '?' takes the user id four times.
export const pollVisibleTo = viewer => `(${GROUPS_OFF} OR p.created_by = ${viewer} OR (p.is_private = 0 AND ${visibleTo(viewer)}) OR EXISTS (
  SELECT 1 FROM poll_groups shared JOIN group_members mine ON mine.group_id = shared.group_id
  WHERE shared.poll_id = p.id AND mine.user_id = ${viewer}))`;


// The times of a repeating event changed or skipped on their own (event_changes), as one JSON object for each
// events row aliased `e`: { [on_date]: changes }, what occurrences and timeOn read.
export const WITH_CHANGES = `(SELECT json_group_object(on_date, json(changes)) FROM event_changes WHERE event_id = e.id)
                      AS changes`;

/** The calendar's Custom view, in place of a group: g=custom picks it, and its id carries it in links and forms. */
export const CUSTOM_VIEW = { id: 'custom', custom: true };

/**
 * Whose free days, events and birthdays `me` sees, as SQL for users `u` and events `e`: in one group (a
 * member_groups row they are in), their Custom view (CUSTOM_VIEW), only some people (`{ people: [user ids] }`, each
 * still one they see), or everyone they see (null).
 */
export function audienceFor(me, view) {
  if (view === CUSTOM_VIEW) {
    return {
      sql: `(${VISIBLE_TO_ME} AND ${IN_MY_CUSTOM_VIEW})`, params: [me, me, me, me],
      eventSql: `(${EVENT_VISIBLE_TO_ME} AND ${IN_MY_CUSTOM_VIEW})`, eventParams: [me, me, me, me, me, me],
      birthdaySql: `(${BIRTHDAY_VISIBLE_TO_ME} AND ${IN_MY_CUSTOM_VIEW})`, birthdayParams: [me, me, me, me],
    };
  }
  if (view?.people) {
    const ids = `u.id IN (${view.people.map(() => '?').join(',') || 'NULL'})`;
    return {
      sql: `(${VISIBLE_TO_ME} AND ${ids})`, params: [me, me, ...view.people],
      eventSql: EVENT_VISIBLE_TO_ME, eventParams: [me, me, me, me],
      birthdaySql: `(${BIRTHDAY_VISIBLE_TO_ME} AND ${ids})`, birthdayParams: [me, me, ...view.people],
    };
  }
  if (view) {
    return { sql: IN_GROUP, params: [view.id], eventSql: EVENT_IN_GROUP, eventParams: [view.id, view.id],
      birthdaySql: IN_GROUP, birthdayParams: [view.id] };
  }
  return { sql: VISIBLE_TO_ME, params: [me, me], eventSql: EVENT_VISIBLE_TO_ME, eventParams: [me, me, me, me],
    birthdaySql: BIRTHDAY_VISIBLE_TO_ME, birthdayParams: [me, me] };
}

/**
 * What `me` sees of `audience` (audienceFor) from `from` to `to`: `events`, every event shown that touches those
 * days, each time a repeating one comes back in them (occurrences), all-day ones first; and `freeDays`, by date then
 * name, [{ date, user_id, name, color, parts }].
 */
export function calendarDays(me, audience, from, to) {
  const events = occurrences(all(`SELECT e.*, u.name AS creator, ${WITH_CHANGES} FROM events e
                                  JOIN users u ON u.id = e.created_by
                                  WHERE e.date <= ? AND (e.end_date >= ? OR e.rrule IS NOT NULL)
                                    AND ${audience.eventSql}`,
  to, from, ...audience.eventParams), from, to);

  // A private event this view does not show (another group's) takes up its groups' members: here they are
  // only free around it, by their Calendar Integration rules. My own days stay as I set them, for the day menu.
  const shownEventIds = new Set(events.map(event => event.id));
  const hiddenEvents = new Map(); // user id -> the hidden events they are in
  for (const row of occurrences(all(`SELECT DISTINCT e.id, e.title, e.date, e.end_date, e.start_time, e.end_time,
                                       e.rrule, ${WITH_CHANGES}, m.user_id
                                     FROM events e JOIN event_groups shared ON shared.event_id = e.id
                                     JOIN group_members m ON m.group_id = shared.group_id
                                     WHERE e.is_private = 1 AND e.date <= ?
                                       AND (e.end_date >= ? OR e.rrule IS NOT NULL) AND m.user_id != ?`,
  to, from, me), from, to)) {
    if (!shownEventIds.has(row.id)) {
      hiddenEvents.set(row.user_id, [...hiddenEvents.get(row.user_id) ?? [], row]);
    }
  }

  const freeDays = [];
  for (const row of all(`SELECT f.date, f.part, f.part2, f.user_id, u.name, u.color, u.busy_minutes, u.ignore_words
                         FROM free_days f JOIN users u ON u.id = f.user_id
                         WHERE f.date BETWEEN ? AND ? AND ${audience.sql} ORDER BY f.date, u.name`,
  from, to, ...audience.params)) {
    const busyWith = (hiddenEvents.get(row.user_id) ?? [])
      .filter(event => event.date <= row.date && row.date <= event.end_date);
    const parts = busyWith.length ? freePartsAround(freeParts(row), row.date, busyWith, row) : freeParts(row);
    if (parts.length > 0) {
      freeDays.push({ date: row.date, user_id: row.user_id, name: row.name, color: row.color, parts });
    }
  }
  return { events, freeDays };
}
