import { all, get, run, now, tx } from './db.js';
import * as auth from './auth.js';
import * as views from './views.js';
import { logEvent, tailLog, LOG_PATH, ERROR_LOG_PATH } from './log.js';
import { createReadStream, existsSync } from 'node:fs';
import { fetchCalendar, syncUser, freePartsAround } from './sync.js';
import { t, syncErrorText } from './i18n.js';
import {
  isValidDate, isValidMonth, monthInfo, isValidWeekStart, isValidDateFormat, isValidColor, eventError,
  bestDates, buildIcs, birthdayIn, birthdayRrule, today, randomColor, ANSWERS, MAX_DATES, MIN_PASSWORD, BASE_URL,
  RP_ID, SLOTS, MAX_SLOTS_PER_DAY, toggleSlot, isValidBusyMinutes, isValidSyncDays, isValidLanguage,
} from './lib.js';

export const routes = [];

// Registers a route. `path` is regex source anchored to the whole pathname, so named groups
// like (?<id>\d+) arrive as ctx.params.id. Public routes skip the login check in server.js.
const on = (method, path, handler, isPublic = false) =>
  routes.push({ method, path: new RegExp(`^${path}$`), handler, public: isPublic });

// Every message a member reads is in their language (ctx.lang, server.js): ctx.fail takes a key in src/locales,
// form errors are translated here with t(ctx.lang, key), as they go into the page. The log stays in English.

/** Form values are untrusted: trim and cap the length before anything else touches them. */
const cleanText = (value, maxLength) => (value ?? '').toString().trim().slice(0, maxLength);

// A rejected form never leads to an error page: its page is drawn again with an `errors` object,
// { field: message }, and the template shows each message in red under that field (or under the
// section title for errors about the whole form). Error pages are left for links that lead nowhere.
const hasErrors = errors => Object.keys(errors).length > 0;

/** Calendar forms post the month they were rendered for, so a redirect lands back on it. */
const postedMonth = ctx => {
  const month = ctx.body.get('m');
  return isValidMonth(month) ? month : today().slice(0, 7);
};
/**
 * Back to the month, in the view the form was posted from. g is always in the URL, empty for "everyone
 * I can see", because a calendar URL without g opens on the member's default group.
 */
const backToMonth = ctx => {
  const group = calendarGroup(ctx);
  return '/?m=' + postedMonth(ctx) + '&g=' + (group ? group.id : '');
};

const TOO_MANY = 'errors.tooMany';
const BANNED = 'banned (too many attempts)'; // the log's name for a login the rate limit refused

/** Is the groups feature on (Administration → Options)? For routes with no logged-in ctx.user to ask. */
const groupsEnabled = () => Boolean(get('SELECT groups_enabled FROM app_settings').groups_enabled);

/** Logs an action done by the logged-in member. */
const logUser = (ctx, action) => logEvent({ ip: ctx.ip, user: ctx.user.name, known: true, action });

const startSession = (ctx, userId) => {
  ctx.setCookie('sid', auth.createSession(userId), auth.SESSION_SECONDS);
  ctx.redirect('/');
};

// ---- auth ----
on('GET', '/login', ctx => ctx.user ? ctx.redirect('/') : ctx.html(views.loginPage(ctx.lang)), true);

on('POST', '/login', async ctx => {
  const name = cleanText(ctx.body.get('name'), 40);
  const user = get('SELECT * FROM users WHERE name = ?', name);
  const log = action => logEvent({ ip: ctx.ip, user: user?.name ?? name, known: Boolean(user), action });
  if (!auth.loginAllowed(ctx.ip, name)) {
    log(BANNED);
    return ctx.html(views.loginPage(ctx.lang, t(ctx.lang, TOO_MANY)), 429);
  }
  // Hash even for an unknown name, so the response time does not reveal which names exist.
  const passwordOk = await auth.verifyPassword(ctx.body.get('password') || '', user?.password_hash ?? auth.DUMMY_HASH);
  if (!user || !passwordOk) {
    log('login failed (password)');
    auth.loginFailed(ctx.ip, name);
    return ctx.html(views.loginPage(ctx.lang, t(ctx.lang, 'errors.wrongLogin')), 401);
  }
  log('login ok (password)');
  startSession(ctx, user.id);
}, true);

on('POST', '/logout', ctx => {
  // No ctx.user means the session was already gone, and server.js logged that as a timeout.
  if (ctx.user) {
    logUser(ctx, 'logout');
  }
  if (ctx.sid) {
    auth.deleteSession(ctx.sid);
  }
  ctx.setCookie('sid', '', 0);
  ctx.redirect('/login');
}, true);

// ---- passkeys ----
// Two requests each way: fetch a challenge, then post what the authenticator signed over it.
// public/app.js posts these form-encoded like every other form, so server.js needs no special case.

// Issuing a challenge is only gated per client, so a stranger's failures never hide the passkey button.
on('POST', '/login/passkey/options', ctx => {
  if (auth.loginAllowed(ctx.ip)) {
    return ctx.json({ challenge: auth.createChallenge(), rpId: RP_ID });
  }
  logEvent({ ip: ctx.ip, action: BANNED }); // no passkey chosen yet, so no user to name
  ctx.json({ error: t(ctx.lang, TOO_MANY) }, 429);
}, true);

on('POST', '/login/passkey', ctx => {
  const credentialId = ctx.body.get('id') || '';
  const owner = auth.credentialOwner(credentialId);
  // An unknown passkey has no member behind it: log a short prefix of its id instead.
  const logName = owner ?? 'passkey ' + credentialId.slice(0, 16);
  const log = action => logEvent({ ip: ctx.ip, user: logName, known: Boolean(owner), action });
  if (!auth.loginAllowed(ctx.ip, credentialId)) {
    log(BANNED);
    return ctx.json({ error: t(ctx.lang, TOO_MANY) }, 429);
  }
  const challenge = ctx.body.get('challenge') || '';

  // Spend the challenge first: a replayed body dies here even if its signature is still perfectly good.
  const user = auth.consumeChallenge(challenge) && auth.credentialUser({
    id: credentialId,
    clientDataJSON: ctx.body.get('clientDataJSON') || '',
    authenticatorData: ctx.body.get('authenticatorData') || '',
    signature: ctx.body.get('signature') || '',
    challenge,
  });

  if (!user) {
    log('login failed (passkey)');
    auth.loginFailed(ctx.ip, credentialId); // passkey attempts share the password login's rate limit
    return ctx.json({ error: t(ctx.lang, 'errors.passkeyUnknown') }, 401);
  }
  log('login ok (passkey)');
  ctx.setCookie('sid', auth.createSession(user.id), auth.SESSION_SECONDS);
  ctx.json({ ok: true }); // the client navigates; a 303 here would make fetch load the page for nothing
}, true);

const INVITE_GONE = 'errors.inviteGone';

on('GET', '/invite/(?<token>[\\w-]+)', ctx => {
  const invite = auth.getInvite(ctx.params.token);
  if (!invite) {
    return ctx.fail(410, INVITE_GONE);
  }
  ctx.html(views.invitePage(ctx.lang, invite.token, invite.user_name));
}, true);

// One form, two jobs: with invite.user_id it resets that user's password, otherwise it creates an account.
on('POST', '/invite/(?<token>[\\w-]+)', async ctx => {
  const invite = auth.getInvite(ctx.params.token);
  if (!invite) {
    return ctx.fail(410, INVITE_GONE);
  }

  const password = ctx.body.get('password') || '';
  const name = cleanText(ctx.body.get('name'), 40);
  const isReset = Boolean(invite.user_id);
  const errors = {};
  if (!isReset && !name) {
    errors.name = t(ctx.lang, 'errors.nameRequired');
  } else if (!isReset && get('SELECT 1 FROM users WHERE name = ?', name)) {
    errors.name = t(ctx.lang, 'errors.nameTaken');
  }
  if (password.length < MIN_PASSWORD) {
    errors.password = t(ctx.lang, 'errors.passwordShort', { min: MIN_PASSWORD });
  }
  if (hasErrors(errors)) {
    return ctx.html(views.invitePage(ctx.lang, invite.token, invite.user_name, { errors, name }), 400);
  }

  const passwordHash = await auth.hashPassword(password);
  const userId = tx(() => {
    // Consumed inside the transaction: two submissions of the same link cannot both succeed.
    if (!auth.consumeInvite(invite.token)) {
      throw Object.assign(new Error(INVITE_GONE), { status: 410 });
    }
    if (isReset) {
      run('UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, invite.user_id);
      // A reset is a recovery: log out every device and drop every passkey, so nothing an intruder
      // planted on the account keeps working. The member re-adds their passkeys in Profile.
      auth.deleteUserSessions(invite.user_id);
      auth.deleteUserCredentials(invite.user_id);
      return invite.user_id;
    }
    // Joining while groups are off: public, like every event and poll made then (there is no choice to make).
    // The language this page was in becomes theirs, so their calendar feeds speak it from the start.
    return run(`INSERT INTO users(name, password_hash, feed_token, is_admin, created_at, color, is_private, language)
                VALUES (?,?,?,?,?,?,?,?)`,
      name, passwordHash, auth.token(), invite.is_admin, now(), randomColor(), groupsEnabled() ? 1 : 0,
      ctx.lang ?? null).lastInsertRowid;
  });
  logEvent({ ip: ctx.ip, user: isReset ? invite.user_name : name, known: true,
    action: isReset ? 'password reset by link' : `account created by invite${invite.is_admin ? ' (admin)' : ''}` });
  startSession(ctx, userId);
}, true);

// ---- calendar ----

// While an admin has groups turned off (Administration → Options) everyone and everything is seen as public.
// The private flags and group shares are left as they are, so turning groups back on brings them back.
const GROUPS_OFF = '(SELECT groups_enabled FROM app_settings) = 0';

// Whose free days a viewer may see: their own, public accounts', and those of anyone sharing a group with them.
// A public event or poll goes with its creator the same way. For a users table aliased `u`. `viewer` is an SQL
// expression: '?' to pass a user id (twice), or a column, to ask it for every user at once (a poll's audience).
const sharesGroupWith = viewer => `EXISTS (
  SELECT 1 FROM group_members theirs JOIN group_members mine ON mine.group_id = theirs.group_id
  WHERE theirs.user_id = u.id AND mine.user_id = ${viewer})`;
const visibleTo = viewer => `(${GROUPS_OFF} OR u.id = ${viewer} OR u.is_private = 0 OR ${sharesGroupWith(viewer)})`;
// Takes my user id twice.
const VISIBLE_TO_ME = visibleTo('?');
// Whose birthday I see: my own and those of anyone sharing a group with me; a public account is not enough.
// Takes my user id twice.
const BIRTHDAY_VISIBLE_TO_ME = `(${GROUPS_OFF} OR u.id = ? OR ${sharesGroupWith('?')})`;
// The one-group view: only that group's members, public or not. Takes the group id.
const IN_GROUP = 'EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = ? AND m.user_id = u.id)';

// Events, for events `e` joined to their creator `u`. A public event (is_private = 0) is seen by everyone
// who sees its creator; a private one only by its creator and the members of the groups it is shared with.
// Takes my user id four times.
const EVENT_VISIBLE_TO_ME = `(${GROUPS_OFF} OR e.created_by = ? OR (e.is_private = 0 AND ${VISIBLE_TO_ME}) OR EXISTS (
  SELECT 1 FROM event_groups shared JOIN group_members mine ON mine.group_id = shared.group_id
  WHERE shared.event_id = e.id AND mine.user_id = ?))`;
// One group's events (its view on the calendar, and its feed): its members' public events, and the private
// ones shared with it. Takes the group id twice.
const EVENT_IN_GROUP = `(${IN_GROUP} AND (e.is_private = 0 OR EXISTS (
  SELECT 1 FROM event_groups shared WHERE shared.event_id = e.id AND shared.group_id = ?)))`;

// Polls, for polls `p` joined to their creator `u`: the same rule as events, with poll_groups.
// `viewer` as in visibleTo: '?' takes the user id four times.
const pollVisibleTo = viewer => `(${GROUPS_OFF} OR p.created_by = ${viewer} OR (p.is_private = 0 AND ${visibleTo(viewer)}) OR EXISTS (
  SELECT 1 FROM poll_groups shared JOIN group_members mine ON mine.group_id = shared.group_id
  WHERE shared.poll_id = p.id AND mine.user_id = ${viewer}))`;

/** The groups I am in, by name: the calendar's group selector and the groups page. */
const myGroups = userId => all(`SELECT g.* FROM member_groups g
                                JOIN group_members m ON m.group_id = g.id
                                WHERE m.user_id = ? ORDER BY g.name COLLATE NOCASE, g.id`, userId);

/**
 * The group the calendar shows on its own (?g= on a page, a posted g from its forms), or null for
 * "everyone I can see". A page opened with no g at all shows my default group (users.default_group_id);
 * an empty g is an explicit "everyone". A group I am not in is ignored, so a stale or guessed id shows
 * nothing extra, and a default group I have since left falls back to everyone. Groups off: always everyone.
 */
function calendarGroup(ctx) {
  if (!ctx.user.groups_enabled) {
    return null; // groups are off (Administration → Options): always everyone
  }
  let requested;
  if (ctx.body) {
    requested = ctx.body.get('g');
  } else if (ctx.url.searchParams.has('g')) {
    requested = ctx.url.searchParams.get('g');
  } else {
    requested = ctx.user.default_group_id;
  }
  const groupId = Number(requested);
  if (!groupId) {
    return null;
  }
  return get(`SELECT g.* FROM member_groups g JOIN group_members m ON m.group_id = g.id
              WHERE g.id = ? AND m.user_id = ?`, groupId, ctx.user.id) ?? null;
}

/** A free_days row's part and part2 as one list: ['all'], ['am'], ['am', 'eve']... */
const freeParts = row => (row.part2 ? [row.part, row.part2] : [row.part]);

/** Draws one month of the calendar. `error` goes under the month title (a rejected /free). */
function showCalendar(ctx, yearMonth, { status = 200, error } = {}) {
  // Every day of the weeks the month touches, so the continuous calendar can fill its first and last weeks
  // with the months around it. ISO dates compare as strings.
  const { gridStart, gridEnd, prev, next } = monthInfo(yearMonth, ctx.user.week_start);
  // Whose free days and events are drawn, and who "everyone" is for the green days: one group, or
  // everyone I can see. Events follow their creator too, unless they are private (see EVENT_VISIBLE_TO_ME).
  const group = calendarGroup(ctx);
  const me = ctx.user.id;
  const audience = group
    ? { sql: IN_GROUP, params: [group.id], eventSql: EVENT_IN_GROUP, eventParams: [group.id, group.id],
        birthdaySql: IN_GROUP, birthdayParams: [group.id] }
    : { sql: VISIBLE_TO_ME, params: [me, me], eventSql: EVENT_VISIBLE_TO_ME, eventParams: [me, me, me, me],
        birthdaySql: BIRTHDAY_VISIBLE_TO_ME, birthdayParams: [me, me] };

  // Every event shown that touches those weeks, including ones that started before or end after them.
  // All-day ones first.
  const events = all(`SELECT e.*, u.name AS creator FROM events e
                      JOIN users u ON u.id = e.created_by
                      WHERE e.date <= ? AND e.end_date >= ? AND ${audience.eventSql}
                      ORDER BY e.date, e.start_time IS NOT NULL, e.start_time, e.id`,
                      gridEnd, gridStart, ...audience.eventParams);

  // A private event this view does not show (another group's) takes up its groups' members: here they are
  // only free around it, by their Calendar Integration rules. My own days stay as I set them, for the day menu.
  const shownEventIds = new Set(events.map(event => event.id));
  const hiddenEvents = new Map(); // user id -> the hidden events they are in
  for (const row of all(`SELECT DISTINCT e.id, e.title, e.date, e.end_date, e.start_time, e.end_time, m.user_id
                         FROM events e JOIN event_groups shared ON shared.event_id = e.id
                         JOIN group_members m ON m.group_id = shared.group_id
                         WHERE e.is_private = 1 AND e.date <= ? AND e.end_date >= ? AND m.user_id != ?`,
                         gridEnd, gridStart, me)) {
    if (!shownEventIds.has(row.id)) {
      hiddenEvents.set(row.user_id, [...hiddenEvents.get(row.user_id) ?? [], row]);
    }
  }

  // date -> everyone shown who is free that day, for the initials in each cell,
  // and date -> which parts of it I am free (['all'], or one or two of 'am' | 'pm' | 'eve')
  const free = new Map();
  const mine = new Map();
  for (const row of all(`SELECT f.date, f.part, f.part2, f.user_id, u.name, u.color, u.busy_minutes, u.ignore_words
                         FROM free_days f JOIN users u ON u.id = f.user_id
                         WHERE f.date BETWEEN ? AND ? AND ${audience.sql} ORDER BY u.name`,
                         gridStart, gridEnd, ...audience.params)) {
    const busyWith = (hiddenEvents.get(row.user_id) ?? [])
      .filter(event => event.date <= row.date && row.date <= event.end_date);
    const parts = busyWith.length ? freePartsAround(freeParts(row), row.date, busyWith, row) : freeParts(row);
    if (parts.length === 0) {
      continue;
    }
    if (!free.has(row.date)) {
      free.set(row.date, []);
    }
    free.get(row.date).push({ name: row.name, color: row.color, parts, isMe: row.user_id === ctx.user.id });
    if (row.user_id === ctx.user.id) {
      mine.set(row.date, parts);
    }
  }
  // With a calendar connected: the days I set by hand, so the day menu shows which ones are Automatic
  const manualDays = get('SELECT 1 FROM calendar_links WHERE user_id = ?', me)
    ? new Set(all('SELECT date FROM manual_days WHERE user_id = ? AND date BETWEEN ? AND ?', me, gridStart, gridEnd)
      .map(row => row.date))
    : null;

  // a day is "everyone free" at this count
  const members = get(`SELECT COUNT(*) AS n FROM users u WHERE ${audience.sql}`, ...audience.params).n;
  // Birthdays are not events rows: each one is worked out from users.birthday for the months on screen
  // (the weeks shown reach into the months before and after).
  const birthdays = [];
  if (ctx.user.show_birthdays) {
    for (const member of all(`SELECT u.name, u.color, u.birthday FROM users u
                              WHERE u.birthday IS NOT NULL AND ${audience.birthdaySql}`, ...audience.birthdayParams)) {
      for (const shownMonth of [prev, yearMonth, next]) {
        const date = birthdayIn(shownMonth, member.birthday);
        if (date && gridStart <= date && date <= gridEnd) {
          birthdays.push({ name: member.name, color: member.color, date });
        }
      }
    }
  }

  ctx.html(views.calendarPage(ctx.user, yearMonth, {
    free, mine, events, birthdays, today: today(), members, error, group, groups: myGroups(ctx.user.id), manualDays,
  }), status);
}

on('GET', '/', ctx => {
  const requestedMonth = ctx.url.searchParams.get('m');
  showCalendar(ctx, isValidMonth(requestedMonth) ? requestedMonth : today().slice(0, 7));
});

// "Make default": the view on screen (a group, or everyone when g is empty) becomes the one the calendar
// opens on. calendarGroup has already checked I am in the group, so a forged id saves "everyone".
on('POST', '/calendar/default', ctx => {
  const group = calendarGroup(ctx);
  run('UPDATE users SET default_group_id = ? WHERE id = ?', group ? group.id : null, ctx.user.id);
  ctx.redirect(backToMonth(ctx));
});

// Two ways in. A plain click on a day sends no `part` and toggles it: try the delete first, insert
// "all day" only if there was nothing to delete. The long-press / double-click menu sends `part`:
// 'all' sets the whole day, 'none' clears it, and 'am', 'pm' or 'eve' toggles that slot (see toggleSlot),
// so opening the menu again is how a second slot gets added to the same day. 'auto' (only offered with a
// calendar connected) hands the day back to Calendar Integration.
on('POST', '/free', async ctx => {
  const date = ctx.body.get('date');
  const part = ctx.body.get('part');
  if (!isValidDate(date)) {
    return showCalendar(ctx, postedMonth(ctx), { status: 400, error: t(ctx.lang, 'errors.invalidDate') });
  }

  // No longer set by hand. It keeps what it shows until the sync rewrites it: at once inside the sync's window
  // (the member's next sync_days days) when every calendar answers, otherwise on a later hourly sync. A past day stays.
  if (part === 'auto') {
    run('DELETE FROM manual_days WHERE user_id = ? AND date = ?', ctx.user.id, date);
    await syncUser(ctx.user.id);
    return ctx.redirect(backToMonth(ctx));
  }

  const clearDay = () => run('DELETE FROM free_days WHERE user_id = ? AND date = ?', ctx.user.id, date).changes;
  const setDay = (first, second = null) => run(`INSERT INTO free_days(user_id, date, part, part2) VALUES (?,?,?,?)
    ON CONFLICT DO UPDATE SET part = excluded.part, part2 = excluded.part2`, ctx.user.id, date, first, second);

  if (part === null) {
    if (clearDay() === 0) {
      setDay('all');
    }
  } else if (part === 'none') {
    clearDay();
  } else if (part === 'all') {
    setDay('all');
  } else if (SLOTS.includes(part)) {
    const current = get('SELECT part, part2 FROM free_days WHERE user_id = ? AND date = ?', ctx.user.id, date);
    const parts = toggleSlot(current ? freeParts(current) : [], part);
    if (parts === null) {
      const error = t(ctx.lang, 'errors.tooManySlots', { max: MAX_SLOTS_PER_DAY });
      return showCalendar(ctx, postedMonth(ctx), { status: 400, error });
    }
    if (parts.length === 0) {
      clearDay();
    } else {
      setDay(...parts);
    }
  } else {
    return showCalendar(ctx, postedMonth(ctx), { status: 400, error: t(ctx.lang, 'errors.invalidPart') });
  }
  // set by hand: the calendar sync (src/sync.js) leaves this day alone from now on
  run('INSERT OR IGNORE INTO manual_days(user_id, date) VALUES (?, ?)', ctx.user.id, date);
  ctx.redirect(backToMonth(ctx));
});

// ---- events: one page adds and edits (views.eventPage) ----

/**
 * The "Who sees it" fields of the event and poll forms (templates/share-with.html): { isPrivate, groupIds, error }.
 * A private event or poll needs at least one group, and only groups of its creator (`creatorGroups`) count:
 * any other id is dropped. A public one is shared with no group. `what` names it in the error.
 * While groups are off the form has no Who sees it: a new one is public, and one being changed keeps `current`
 * (its saved choice) for when groups are turned back on.
 */
function readSharing(ctx, creatorGroups, what, current = { isPrivate: 0, groupIds: [] }) {
  if (!ctx.user.groups_enabled) {
    return current;
  }
  const visibility = ctx.body.get('visibility');
  const postedGroupIds = ctx.body.getAll('group_ids').map(Number);
  if (visibility !== 'public' && visibility !== 'private') {
    return { isPrivate: 0, groupIds: postedGroupIds, error: t(ctx.lang, 'errors.pickVisibility') };
  }
  if (visibility === 'public') {
    return { isPrivate: 0, groupIds: [] };
  }
  const creatorGroupIds = new Set(creatorGroups.map(group => group.id));
  const groupIds = [...new Set(postedGroupIds)].filter(groupId => creatorGroupIds.has(groupId));
  const error = groupIds.length === 0 ? t(ctx.lang, `errors.privateNeedsGroup.${what}`) : undefined;
  return { isPrivate: 1, groupIds, error };
}

// The tables holding which groups a private event or poll is shared with.
const SHARES = {
  event: { table: 'event_groups', column: 'event_id' },
  poll: { table: 'poll_groups', column: 'poll_id' },
};

/** Replaces the groups a private event or poll (`kind`) is shared with; a public one has none. Run inside a tx. */
function saveShares(kind, id, groupIds) {
  const { table, column } = SHARES[kind];
  run(`DELETE FROM ${table} WHERE ${column} = ?`, id);
  for (const groupId of groupIds) {
    run(`INSERT INTO ${table}(${column}, group_id) VALUES (?,?)`, id, groupId);
  }
}

/** The groups a private event or poll is shared with, as ids. */
const sharedGroupIds = (kind, id) =>
  all(`SELECT group_id FROM ${SHARES[kind].table} WHERE ${SHARES[kind].column} = ?`, id).map(row => row.group_id);

/**
 * The event form, in the shape of an events row so a rejected form re-renders with what was typed.
 * The optional fields arrive as '' when left empty: those become NULL (end_date: the start date).
 * `creatorGroups` are the groups of the event's creator: a private event can only be shared with those.
 * `currentSharing`: an edited event's saved Who sees it, kept while groups are off (readSharing).
 */
function readEventForm(ctx, creatorGroups, currentSharing) {
  const colorText = ctx.body.get('color') || '';
  // The time inputs are only hidden when "All day" is ticked, so the browser still sends them: drop them.
  const allDay = ctx.body.get('all_day') === '1';
  const sharing = readSharing(ctx, creatorGroups, 'event', currentSharing);
  const event = {
    title: cleanText(ctx.body.get('title'), 100),
    date: ctx.body.get('date') || '',
    end_date: ctx.body.get('end_date') || null,
    start_time: allDay ? null : ctx.body.get('start_time') || null,
    end_time: allDay ? null : ctx.body.get('end_time') || null,
    color: colorText === '' ? null : Number(colorText),
    is_private: sharing.isPrivate,
    // not columns: the box as it was posted, and the groups ticked (only kept for a private event)
    allDay,
    groupIds: sharing.groupIds,
  };
  const errors = {};
  if (!event.title) {
    errors.title = t(ctx.lang, 'errors.titleRequired');
  }
  const whenError = eventError({
    date: event.date, endDate: event.end_date, startTime: event.start_time, endTime: event.end_time,
  });
  if (whenError) {
    errors[whenError.field] = t(ctx.lang, whenError.message);
  }
  if (!allDay && !event.start_time) {
    errors.start ??= t(ctx.lang, 'errors.pickStartTime');
  }
  if (event.color !== null && !isValidColor(event.color)) {
    errors.color = t(ctx.lang, 'errors.invalidColor');
  }
  if (sharing.error) {
    errors.visibility = sharing.error;
  }
  event.end_date ||= event.date;
  return { event, errors };
}

/** The event with this id, if the member may change it: their own, or any event if they are an admin. */
const editableEvent = ctx => {
  const event = get('SELECT * FROM events WHERE id = ?', Number(ctx.params.id));
  if (!event) {
    return ctx.fail(404, 'errors.eventNotFound');
  }
  if (event.created_by !== ctx.user.id && !ctx.user.is_admin) {
    return ctx.fail(403, 'errors.eventForbidden');
  }
  return event;
};

// ?date= prefills the start date, e.g. for a link from a given day.
on('GET', '/events/new', ctx => {
  const date = ctx.url.searchParams.get('date');
  ctx.html(views.eventPage(ctx.user, {
    event: { date: isValidDate(date) ? date : '' },
    groups: myGroups(ctx.user.id),
  }));
});

on('POST', '/events', ctx => {
  const groups = myGroups(ctx.user.id);
  const { event, errors } = readEventForm(ctx, groups);
  if (hasErrors(errors)) {
    return ctx.html(views.eventPage(ctx.user, { event, errors, groups }), 400);
  }
  tx(() => {
    const eventId = run(`INSERT INTO events(title, date, end_date, start_time, end_time, color, is_private,
                                            created_by, created_at)
                         VALUES (?,?,?,?,?,?,?,?,?)`,
      event.title, event.date, event.end_date, event.start_time, event.end_time, event.color, event.is_private,
      ctx.user.id, now()).lastInsertRowid;
    saveShares('event', eventId, event.groupIds);
  });
  ctx.redirect('/?m=' + event.date.slice(0, 7));
});

on('GET', '/events/(?<id>\\d+)', ctx => {
  const event = editableEvent(ctx);
  if (event) {
    event.groupIds = sharedGroupIds('event', event.id);
    // An admin editing someone else's event shares it with the creator's groups, not their own.
    ctx.html(views.eventPage(ctx.user, { event, groups: myGroups(event.created_by) }));
  }
});

on('POST', '/events/(?<id>\\d+)', ctx => {
  const existing = editableEvent(ctx);
  if (!existing) {
    return;
  }
  const groups = myGroups(existing.created_by);
  const { event, errors } = readEventForm(ctx, groups,
    { isPrivate: existing.is_private, groupIds: sharedGroupIds('event', existing.id) });
  event.id = existing.id;
  if (hasErrors(errors)) {
    return ctx.html(views.eventPage(ctx.user, { event, errors, groups }), 400);
  }
  tx(() => {
    run(`UPDATE events SET title = ?, date = ?, end_date = ?, start_time = ?, end_time = ?, color = ?, is_private = ?
         WHERE id = ?`,
      event.title, event.date, event.end_date, event.start_time, event.end_time, event.color, event.is_private,
      existing.id);
    saveShares('event', existing.id, event.groupIds);
  });
  ctx.redirect('/?m=' + event.date.slice(0, 7));
});

// The WHERE clause is the permission check: your own events, or any event if you are an admin.
on('POST', '/events/(?<id>\\d+)/delete', ctx => {
  run('DELETE FROM events WHERE id = ? AND (created_by = ? OR ? = 1)',
    Number(ctx.params.id), ctx.user.id, ctx.user.is_admin);
  ctx.redirect(backToMonth(ctx));
});

// ---- polls ----
// Same public / private rule as events (pollVisibleTo). A poll is for everyone who can see it: they are the
// ones it waits for, and the only ones who can open, answer or confirm it.

/**
 * Everything pollPage needs, if `user` may see the poll: the poll, its dates, the members it is for, their
 * votes, who of them still owes an answer, the groups it is shared with and the ones it could be (its
 * creator's), and its event once confirmed, if `user` may see that event too.
 * null for a poll that does not exist or that `user` may not see: the same answer, so an id gives nothing away.
 */
function loadPoll(pollId, user) {
  const me = user.id;
  const poll = get(`SELECT p.* FROM polls p JOIN users u ON u.id = p.created_by
                    WHERE p.id = ? AND ${pollVisibleTo('?')}`, pollId, me, me, me, me);
  if (!poll) {
    return null;
  }

  const dates = all('SELECT date FROM poll_dates WHERE poll_id = ? ORDER BY date', pollId).map(row => row.date);
  // Who it is for: every user who can see it, worked out for all of them at once (v is each candidate).
  const members = all(`SELECT v.id, v.name FROM users v
                       JOIN polls p ON p.id = ? JOIN users u ON u.id = p.created_by
                       WHERE ${pollVisibleTo('v.id')} ORDER BY v.name`, pollId);
  // Answers from someone it is no longer for (they left the group it is shared with) no longer count.
  const memberIds = new Set(members.map(member => member.id));
  const votes = all('SELECT date, user_id, answer FROM poll_votes WHERE poll_id = ?', pollId)
    .filter(vote => memberIds.has(vote.user_id));

  // A member has finished only once they answered every proposed date.
  const datesAnsweredBy = {}; // user_id -> Set of dates
  for (const vote of votes) {
    (datesAnsweredBy[vote.user_id] ??= new Set()).add(vote.date);
  }
  const missing = members
    .filter(member => (datesAnsweredBy[member.id]?.size ?? 0) < dates.length)
    .map(member => member.name);

  return {
    poll,
    dates,
    members,
    votes,
    missing,
    complete: missing.length === 0,
    best: poll.chosen_date ? [poll.chosen_date] : bestDates(dates, votes),
    // Set once the date is confirmed, and only if I may see the event: it can be edited to private later.
    event: get(`SELECT e.* FROM events e JOIN users u ON u.id = e.created_by
                WHERE e.poll_id = ? AND ${EVENT_VISIBLE_TO_ME}`, pollId, me, me, me, me),
    groupIds: sharedGroupIds('poll', pollId),
    creatorGroups: myGroups(poll.created_by),
  };
}

// The polls I may see, open first, newest first. `members` counts who each is for, `voters` those of them
// who answered every date (v is each user, asked the same pollVisibleTo question as the page).
const POLL_LIST_SQL = `
SELECT p.*,
  (SELECT COUNT(*) FROM users v
     WHERE ${pollVisibleTo('v.id')} AND NOT EXISTS (
       SELECT 1 FROM poll_dates d WHERE d.poll_id = p.id
         AND NOT EXISTS (SELECT 1 FROM poll_votes pv
                           WHERE pv.poll_id = p.id AND pv.date = d.date AND pv.user_id = v.id))) AS voters,
  (SELECT COUNT(*) FROM users v WHERE ${pollVisibleTo('v.id')}) AS members
FROM polls p
JOIN users u ON u.id = p.created_by
WHERE ${pollVisibleTo('?')}
ORDER BY p.closed_at IS NOT NULL, p.created_at DESC`;

/** Only its creator or an admin may close a poll or change who sees it. */
const managesPoll = (user, poll) => poll.created_by === user.id || Boolean(user.is_admin);

on('GET', '/polls', ctx => {
  const me = ctx.user.id;
  ctx.html(views.pollsPage(ctx.user, all(POLL_LIST_SQL, me, me, me, me)));
});
on('GET', '/polls/new', ctx => ctx.html(views.newPollPage(ctx.user, { groups: myGroups(ctx.user.id) })));

on('POST', '/polls/new', ctx => {
  const title = cleanText(ctx.body.get('title'), 100);
  const dates = [...new Set(ctx.body.getAll('dates').filter(Boolean))].sort(); // drop blanks and duplicates
  const groups = myGroups(ctx.user.id);
  const sharing = readSharing(ctx, groups, 'poll');
  const errors = {};
  if (!title) {
    errors.title = t(ctx.lang, 'errors.titleRequired');
  }
  if (!dates.length || dates.length > MAX_DATES || !dates.every(isValidDate)) {
    errors.dates = t(ctx.lang, 'errors.pollDates', { max: MAX_DATES });
  }
  if (sharing.error) {
    errors.visibility = sharing.error;
  }
  if (hasErrors(errors)) {
    return ctx.html(views.newPollPage(ctx.user, { errors, title, groups, sharing }), 400);
  }

  const pollId = tx(() => {
    const id = run('INSERT INTO polls(title, created_by, created_at, is_private) VALUES (?,?,?,?)',
      title, ctx.user.id, now(), sharing.isPrivate).lastInsertRowid;
    for (const date of dates) {
      run('INSERT INTO poll_dates(poll_id, date) VALUES (?,?)', id, date);
    }
    saveShares('poll', id, sharing.groupIds);
    return id;
  });
  ctx.redirect('/polls/' + pollId);
});

on('GET', '/polls/(?<id>\\d+)', ctx => {
  const data = loadPoll(Number(ctx.params.id), ctx.user);
  if (!data) {
    return ctx.fail(404, 'errors.pollNotFound');
  }
  ctx.html(views.pollPage(ctx.user, data));
});

/** The poll page again after a rejected form: errors.answers under the title, errors.result in the result,
 *  errors.visibility in Who sees it. */
const rejectPoll = (ctx, data, status, errors) => ctx.html(views.pollPage(ctx.user, { ...data, errors }), status);

// Saving answers replaces this user's previous ones. Dates left on "—" stay unanswered.
on('POST', '/polls/(?<id>\\d+)', ctx => {
  const pollId = Number(ctx.params.id);
  const data = loadPoll(pollId, ctx.user);
  if (!data) {
    return ctx.fail(404, 'errors.pollNotFound');
  }
  if (data.poll.closed_at) {
    return rejectPoll(ctx, data, 409, { answers: t(ctx.lang, 'errors.pollClosed') });
  }

  tx(() => {
    for (const date of data.dates) {
      const answer = ctx.body.get('v_' + date);
      if (!ANSWERS.includes(answer)) {
        continue;
      }
      run(`INSERT INTO poll_votes(poll_id, date, user_id, answer) VALUES (?,?,?,?)
           ON CONFLICT DO UPDATE SET answer = excluded.answer`, pollId, date, ctx.user.id, answer);
    }
  });
  ctx.redirect('/polls/' + pollId);
});

on('POST', '/polls/(?<id>\\d+)/close', ctx => {
  const pollId = Number(ctx.params.id);
  const data = loadPoll(pollId, ctx.user);
  if (!data) {
    return ctx.fail(404, 'errors.pollNotFound');
  }
  if (managesPoll(ctx.user, data.poll)) {
    run('UPDATE polls SET closed_at = ? WHERE id = ? AND closed_at IS NULL', now(), pollId);
  }
  ctx.redirect('/polls/' + pollId);
});

// Who sees it: public, or private for some of its creator's groups. Like events, an admin changing someone
// else's poll picks from the creator's groups. Answers already given stay; only who it is for changes.
on('POST', '/polls/(?<id>\\d+)/visibility', ctx => {
  const pollId = Number(ctx.params.id);
  const data = loadPoll(pollId, ctx.user);
  if (!data) {
    return ctx.fail(404, 'errors.pollNotFound');
  }
  if (!managesPoll(ctx.user, data.poll)) {
    return ctx.fail(403, 'errors.pollForbidden');
  }
  const sharing = readSharing(ctx, data.creatorGroups, 'poll',
    { isPrivate: data.poll.is_private, groupIds: data.groupIds });
  if (sharing.error) {
    const posted = { ...data, poll: { ...data.poll, is_private: sharing.isPrivate }, groupIds: sharing.groupIds };
    return rejectPoll(ctx, posted, 400, { visibility: sharing.error });
  }
  tx(() => {
    run('UPDATE polls SET is_private = ? WHERE id = ?', sharing.isPrivate, pollId);
    saveShares('poll', pollId, sharing.groupIds);
  });
  logUser(ctx, `poll ${pollId} made ${sharing.isPrivate ? 'private' : 'public'}`);
  ctx.redirect('/polls/' + pollId);
});

// Turns the winning date into a calendar event and closes the poll. The event belongs to the poll's creator
// and is seen by the same people as the poll: same public / private choice, same groups. Anyone the poll is
// for may confirm it.
on('POST', '/polls/(?<id>\\d+)/confirm', ctx => {
  const pollId = Number(ctx.params.id);
  const data = loadPoll(pollId, ctx.user);
  const date = ctx.body.get('date');
  if (!data) {
    return ctx.fail(404, 'errors.pollNotFound');
  }
  if (!data.complete && !data.poll.closed_at) {
    return rejectPoll(ctx, data, 409, { answers: t(ctx.lang, 'errors.notEveryoneAnswered') });
  }
  // Only a winning date may be confirmed; the form offers exactly these, so this is the server-side twin.
  if (!data.best.includes(date)) {
    return rejectPoll(ctx, data, 400, { result: t(ctx.lang, 'errors.notBestDate') });
  }

  tx(() => {
    // Idempotent: events.poll_id is UNIQUE, so a double click adds nothing. Checked on every event, not
    // only the ones I can see (data.event), or a hidden one would make the insert fail.
    if (get('SELECT 1 FROM events WHERE poll_id = ?', pollId)) {
      return;
    }
    const eventId = run(`INSERT INTO events(title, date, end_date, created_by, poll_id, created_at, is_private)
                         VALUES (?,?,?,?,?,?,?)`,
      data.poll.title, date, date, data.poll.created_by, pollId, now(), data.poll.is_private).lastInsertRowid;
    saveShares('event', eventId, data.groupIds);
    run('UPDATE polls SET chosen_date = ?, closed_at = COALESCE(closed_at, ?) WHERE id = ?', date, now(), pollId);
  });
  ctx.redirect('/polls/' + pollId);
});

// ---- groups: sharing one lets private members see each other's free days ----

// Registers a /groups route: while an admin has groups turned off they answer 404, like a page that is not there.
const onGroups = (method, path, handler) => on(method, path, ctx => {
  if (!ctx.user.groups_enabled) {
    return ctx.fail(404, 'errors.groupsOff');
  }
  return handler(ctx);
});

// Any member can invite; the invited member accepts or declines. Its creator and admins in it manage it
// (rename, remove members, cancel invites, delete). Admins can also add a member directly, no invite.

/** Can this user rename, prune or delete the group? Its creator, or an admin who is in it. */
const managesGroup = (user, group) => group.created_by === user.id || Boolean(user.is_admin);

/**
 * Someone is out of a group (left, removed, or their account deleted). Run inside a tx, after their
 * group_members row is gone:
 * - their private events and polls stop being shared with it: those are only ever shared with groups their
 *   creator is in, or people joining later would see them without sharing any group with the creator;
 * - if they created it, its longest-standing remaining member takes it over, so it stays manageable.
 *   Nobody left: created_by goes NULL, and the caller deletes the empty group.
 */
function afterLeavingGroup(groupId, userId) {
  run(`DELETE FROM event_groups
       WHERE group_id = ? AND event_id IN (SELECT id FROM events WHERE created_by = ?)`, groupId, userId);
  run(`DELETE FROM poll_groups
       WHERE group_id = ? AND poll_id IN (SELECT id FROM polls WHERE created_by = ?)`, groupId, userId);
  run(`UPDATE member_groups SET created_by = (
         SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at, user_id LIMIT 1)
       WHERE id = ? AND created_by = ?`, groupId, groupId, userId);
}

/** Deletes the group if nobody is left in it. Run inside a tx. */
const deleteGroupIfEmpty = groupId =>
  run('DELETE FROM member_groups WHERE id = ? AND NOT EXISTS (SELECT 1 FROM group_members WHERE group_id = ?)',
    groupId, groupId);

// A group's own events: the private ones shared with it (event_groups). Public events are left out: they
// belong to everyone who sees their creator, not to this group. For a group id and today's date.
const GROUP_EVENT_SQL = `SELECT e.*, u.name AS creator FROM events e
                         JOIN event_groups shared ON shared.event_id = e.id AND shared.group_id = ?
                         JOIN users u ON u.id = e.created_by`;

/**
 * The group's next event: the first one not over yet (one running today counts). With none coming,
 * its most recent past one, flagged isLast. Undefined when the group never had an event.
 */
function groupHeadlineEvent(groupId) {
  const next = get(`${GROUP_EVENT_SQL} WHERE e.end_date >= ?
                    ORDER BY e.date, e.start_time IS NOT NULL, e.start_time, e.id LIMIT 1`, groupId, today());
  if (next) {
    return next;
  }
  const last = get(`${GROUP_EVENT_SQL} WHERE e.end_date < ?
                    ORDER BY e.end_date DESC, e.date DESC, e.start_time DESC, e.id DESC LIMIT 1`, groupId, today());
  return last && { ...last, isLast: true };
}

/** The groups page. errors[groupId] goes under that group's title, errors.create under New group. */
function showGroups(ctx, { status = 200, errors = {} } = {}) {
  const groups = myGroups(ctx.user.id).map(group => ({
    ...group,
    creator: get('SELECT name FROM users WHERE id = ?', group.created_by)?.name,
    members: all(`SELECT u.id, u.name, u.color FROM group_members m JOIN users u ON u.id = m.user_id
                  WHERE m.group_id = ? ORDER BY u.name`, group.id),
    headlineEvent: groupHeadlineEvent(group.id),
    invited: all(`SELECT u.id, u.name FROM group_invites i JOIN users u ON u.id = i.user_id
                  WHERE i.group_id = ? ORDER BY u.name`, group.id),
    // who can still be invited: not in it, no invite waiting. An admin's list has everyone; anyone else's only the
    // people they know (public, or in one of their groups), as suggestions: they can still type any other name.
    invitable: all(`SELECT u.id, u.name FROM users u WHERE (? OR ${VISIBLE_TO_ME})
                      AND u.id NOT IN (SELECT user_id FROM group_members WHERE group_id = ?)
                      AND u.id NOT IN (SELECT user_id FROM group_invites WHERE group_id = ?)
                    ORDER BY u.name`, ctx.user.is_admin ? 1 : 0, ctx.user.id, ctx.user.id, group.id, group.id),
    canManage: managesGroup(ctx.user, group),
  }));
  const invites = all(`SELECT g.id, g.name, u.name AS invited_by FROM group_invites i
                       JOIN member_groups g ON g.id = i.group_id
                       LEFT JOIN users u ON u.id = i.invited_by
                       WHERE i.user_id = ? ORDER BY i.created_at`, ctx.user.id);
  ctx.html(views.groupsPage(ctx.user, {
    groups, invites, base: BASE_URL, msg: ctx.url.searchParams.get('msg'), invitedName: ctx.url.searchParams.get('to'),
    errors,
  }), status);
}

/** The group in the URL, if I am in it; otherwise answers 404 / 403 and returns nothing. */
function groupForMember(ctx) {
  const group = get('SELECT * FROM member_groups WHERE id = ?', Number(ctx.params.id));
  if (!group) {
    return ctx.fail(404, 'errors.groupNotFound');
  }
  if (!get('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?', group.id, ctx.user.id)) {
    return ctx.fail(403, 'errors.notInGroup');
  }
  return group;
}

/** The group in the URL, only for its creator or an admin (in the group or not); otherwise answers 404 / 403. */
function groupForManager(ctx) {
  const group = get('SELECT * FROM member_groups WHERE id = ?', Number(ctx.params.id));
  if (!group) {
    return ctx.fail(404, 'errors.groupNotFound');
  }
  if (!managesGroup(ctx.user, group)) {
    return ctx.fail(403, 'errors.groupForbidden');
  }
  return group;
}

/**
 * The member picked in a group's Invite form, or an error message for the group. Admins pick from a list
 * (user_id); everyone else types a name, which may be anyone's, known to them or not.
 */
function invitee(ctx, group) {
  let target;
  if (ctx.body.has('user_id')) {
    target = get('SELECT id, name FROM users WHERE id = ?', Number(ctx.body.get('user_id')));
    if (!target) {
      return { error: t(ctx.lang, 'errors.pickInvitee') };
    }
  } else {
    const name = (ctx.body.get('name') || '').trim();
    if (!name) {
      return { error: t(ctx.lang, 'errors.typeInvitee') };
    }
    target = get('SELECT id, name FROM users WHERE name = ?', name); // names are unique, ignoring case
    if (!target) {
      return { error: t(ctx.lang, 'errors.noSuchMember', { name }) };
    }
  }
  if (get('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?', group.id, target.id)) {
    return { error: t(ctx.lang, 'errors.alreadyInGroup', { name: target.name }) };
  }
  return { target };
}

const GROUP_NAME_MAX = 40;

onGroups('GET', '/groups', ctx => showGroups(ctx));

onGroups('POST', '/groups', ctx => {
  const name = cleanText(ctx.body.get('name'), GROUP_NAME_MAX);
  if (!name) {
    return showGroups(ctx, { status: 400, errors: { create: t(ctx.lang, 'errors.groupNameRequired') } });
  }
  // The color the New group panel was showing; a missing or bad one (an old page, a forged form) gets a fresh one.
  const postedColor = Number(ctx.body.get('color') ?? NaN);
  const color = isValidColor(postedColor) ? postedColor : randomColor();
  tx(() => {
    const groupId = run('INSERT INTO member_groups(name, created_by, created_at, color) VALUES (?,?,?,?)',
      name, ctx.user.id, now(), color).lastInsertRowid;
    run('INSERT INTO group_members(group_id, user_id, joined_at) VALUES (?,?,?)', groupId, ctx.user.id, now());
  });
  logUser(ctx, `group created ${JSON.stringify(name)}`);
  ctx.redirect('/groups?msg=group_created');
});

onGroups('POST', '/groups/(?<id>\\d+)/invite', ctx => {
  const group = groupForMember(ctx);
  if (!group) {
    return;
  }
  const { target, error } = invitee(ctx, group);
  if (error) {
    return showGroups(ctx, { status: 400, errors: { [group.id]: error } });
  }
  // A second invite for the same person is a no-op, not an error: the first one is still waiting.
  run(`INSERT INTO group_invites(group_id, user_id, invited_by, created_at) VALUES (?,?,?,?)
       ON CONFLICT DO NOTHING`, group.id, target.id, ctx.user.id, now());
  logUser(ctx, `invited ${JSON.stringify(target.name)} to group ${JSON.stringify(group.name)}`);
  ctx.redirect(`/groups?msg=invited&to=${encodeURIComponent(target.name)}`);
});

// Admins skip the invite: the member is in at once (and any invite waiting for them is spent).
onGroups('POST', '/groups/(?<id>\\d+)/add', ctx => {
  const group = groupForMember(ctx);
  if (!group) {
    return;
  }
  if (!ctx.user.is_admin) {
    return ctx.fail(403, 'errors.adminsOnlyAdd');
  }
  const { target, error } = invitee(ctx, group);
  if (error) {
    return showGroups(ctx, { status: 400, errors: { [group.id]: error } });
  }
  tx(() => {
    run('INSERT INTO group_members(group_id, user_id, joined_at) VALUES (?,?,?)', group.id, target.id, now());
    run('DELETE FROM group_invites WHERE group_id = ? AND user_id = ?', group.id, target.id);
  });
  logUser(ctx, `admin: added ${JSON.stringify(target.name)} to group ${JSON.stringify(group.name)}`);
  ctx.redirect('/groups?msg=added');
});

// Answering an invite: only the invited member can, so the lookup is by my id, not a membership.
onGroups('POST', '/groups/(?<id>\\d+)/(?<answer>accept|decline)', ctx => {
  const groupId = Number(ctx.params.id);
  const group = get(`SELECT g.* FROM group_invites i JOIN member_groups g ON g.id = i.group_id
                     WHERE i.group_id = ? AND i.user_id = ?`, groupId, ctx.user.id);
  if (!group) {
    return ctx.fail(404, 'errors.inviteNotWaiting');
  }
  const accepted = ctx.params.answer === 'accept';
  tx(() => {
    run('DELETE FROM group_invites WHERE group_id = ? AND user_id = ?', groupId, ctx.user.id);
    if (accepted) {
      run('INSERT INTO group_members(group_id, user_id, joined_at) VALUES (?,?,?)', groupId, ctx.user.id, now());
    }
  });
  logUser(ctx, `${accepted ? 'joined' : 'declined'} group ${JSON.stringify(group.name)}`);
  ctx.redirect('/groups?msg=' + (accepted ? 'joined' : 'declined'));
});

// The last one out deletes the group: nobody would be left to see it or manage it.
onGroups('POST', '/groups/(?<id>\\d+)/leave', ctx => {
  const group = groupForMember(ctx);
  if (!group) {
    return;
  }
  tx(() => {
    run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', group.id, ctx.user.id);
    afterLeavingGroup(group.id, ctx.user.id);
    deleteGroupIfEmpty(group.id);
  });
  logUser(ctx, `left group ${JSON.stringify(group.name)}`);
  ctx.redirect('/groups?msg=left');
});

onGroups('POST', '/groups/(?<id>\\d+)/rename', ctx => {
  const group = groupForManager(ctx);
  if (!group) {
    return;
  }
  const name = cleanText(ctx.body.get('name'), GROUP_NAME_MAX);
  if (!name) {
    return showGroups(ctx, { status: 400, errors: { [group.id]: t(ctx.lang, 'errors.groupNameRequired') } });
  }
  run('UPDATE member_groups SET name = ? WHERE id = ?', name, group.id);
  ctx.redirect('/groups?msg=renamed');
});

// Removing yourself is what Leave is for, so a manager can only remove the others.
onGroups('POST', '/groups/(?<id>\\d+)/members/(?<userId>\\d+)/remove', ctx => {
  const group = groupForManager(ctx);
  if (!group) {
    return;
  }
  const memberId = Number(ctx.params.userId);
  if (memberId === ctx.user.id) {
    return showGroups(ctx, { status: 400, errors: { [group.id]: t(ctx.lang, 'errors.useLeave') } });
  }
  // A removed creator hands the group over like one who leaves (an admin can remove the creator).
  const removed = tx(() => {
    const changes = run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', group.id, memberId).changes;
    afterLeavingGroup(group.id, memberId);
    return changes;
  });
  if (removed) {
    const name = get('SELECT name FROM users WHERE id = ?', memberId)?.name;
    logUser(ctx, `removed ${JSON.stringify(name)} from group ${JSON.stringify(group.name)}`);
  }
  ctx.redirect('/groups?msg=member_removed');
});

onGroups('POST', '/groups/(?<id>\\d+)/invites/(?<userId>\\d+)/cancel', ctx => {
  const group = groupForManager(ctx);
  if (!group) {
    return;
  }
  run('DELETE FROM group_invites WHERE group_id = ? AND user_id = ?', group.id, Number(ctx.params.userId));
  ctx.redirect('/groups?msg=invite_cancelled');
});

// ON DELETE CASCADE takes its members and pending invites with it.
onGroups('POST', '/groups/(?<id>\\d+)/delete', ctx => {
  const group = groupForManager(ctx);
  if (!group) {
    return;
  }
  run('DELETE FROM member_groups WHERE id = ?', group.id);
  logUser(ctx, `group deleted ${JSON.stringify(group.name)}`);
  ctx.redirect('/groups?msg=group_deleted');
});

// ---- settings ----

/** The settings page; after a rejected form, `errors` shows under its fields and opens its panel. */
const showSettings = (ctx, { status = 200, errors = {} } = {}) => ctx.html(views.settingsPage(ctx.user, {
  base: BASE_URL,
  groups: myGroups(ctx.user.id),
  invites: auth.openInvites(ctx.user.id),
  calendarLinks: all(`SELECT id, url, label, count_free, last_synced_at, last_error FROM calendar_links
                      WHERE user_id = ? ORDER BY id`, ctx.user.id),
  msg: ctx.url.searchParams.get('msg'),
  errors,
}), status);

on('GET', '/settings', ctx => showSettings(ctx));

on('POST', '/settings/rotate-feed', ctx => {
  run('UPDATE users SET feed_token = ? WHERE id = ?', auth.token(), ctx.user.id);
  logUser(ctx, 'feed links rotated');
  ctx.redirect('/settings?msg=rotated');
});

// A new-account link from any member, while an admin allows it (Administration → Options). The page hides the
// button when it is off; this check is what actually stops a forged post. Never an admin or reset link.
on('POST', '/settings/invite', ctx => {
  if (!ctx.user.member_invites) {
    return ctx.fail(403, 'errors.memberInvitesOff');
  }
  const inviteToken = auth.createInvite({ createdBy: ctx.user.id });
  logUser(ctx, 'invite link created');
  // app.js (data-copy-link forms) asks for JSON: it copies the link itself, then reloads the page.
  if (ctx.req.headers.accept === 'application/json') {
    return ctx.json({ url: `${BASE_URL}/invite/${inviteToken}` });
  }
  ctx.redirect('/settings?msg=invite');
});

// ---- Calendar Integration: free days from my own calendars (src/sync.js) ----

// The secret iCal link is read once before it is saved, so a wrong link is refused with the reason.
// webcal:// is the same address over https. Only https: the server fetches what members paste.
// ponytail: private / LAN addresses are not blocked; add that if people you do not trust can get an account.
on('POST', '/settings/calendars', async ctx => {
  const url = cleanText(ctx.body.get('url'), 2000).replace(/^webcal:\/\//i, 'https://');
  const label = cleanText(ctx.body.get('label'), 60);
  const countFree = ctx.body.get('count_free') === '1' ? 1 : 0;
  if (!/^https:\/\/[^\s]+$/i.test(url)) {
    return showSettings(ctx, { status: 400, errors: { calendar: t(ctx.lang, 'errors.calendarLink') } });
  }
  try {
    await fetchCalendar(url);
  } catch (err) {
    return showSettings(ctx, { status: 400, errors: { calendar: syncErrorText(ctx.lang, err.message) } });
  }
  tx(() => {
    // the first calendar: days already marked by hand stay as they are
    if (!get('SELECT 1 FROM calendar_links WHERE user_id = ?', ctx.user.id)) {
      run(`INSERT OR IGNORE INTO manual_days(user_id, date)
           SELECT user_id, date FROM free_days WHERE user_id = ? AND date >= ?`, ctx.user.id, today());
    }
    run('INSERT INTO calendar_links(user_id, url, label, count_free, created_at) VALUES (?, ?, ?, ?, ?)',
      ctx.user.id, url, label, countFree, now());
  });
  logUser(ctx, 'calendar connected');
  await syncUser(ctx.user.id);
  ctx.redirect('/settings?msg=calendar_added');
});

/** The calendar link in the URL, for its owner or an admin; otherwise answers 404 / 403 and returns nothing. */
function calendarLinkForOwner(ctx) {
  const link = get('SELECT id, user_id FROM calendar_links WHERE id = ?', Number(ctx.params.id));
  if (!link) {
    return ctx.fail(404, 'errors.calendarNotFound');
  }
  if (link.user_id !== ctx.user.id && !ctx.user.is_admin) {
    return ctx.fail(403, 'errors.calendarForbidden');
  }
  return link;
}

// "Count events shown as Free": changed any time, and the owner's days are worked out again at once.
on('POST', '/settings/calendars/(?<id>\\d+)', async ctx => {
  const link = calendarLinkForOwner(ctx);
  if (!link) {
    return;
  }
  const countFree = ctx.body.get('count_free') === '1' ? 1 : 0; // an unchecked checkbox posts nothing
  run('UPDATE calendar_links SET count_free = ? WHERE id = ?', countFree, link.id);
  await syncUser(link.user_id);
  ctx.redirect('/settings?msg=calendar_saved');
});

// Its owner or an admin. Removing the owner's last calendar also clears the free days it filled in from today
// on; days set by hand stay.
on('POST', '/settings/calendars/(?<id>\\d+)/delete', async ctx => {
  const link = calendarLinkForOwner(ctx);
  if (!link) {
    return;
  }
  const ownerId = link.user_id;
  run('DELETE FROM calendar_links WHERE id = ?', link.id);
  if (get('SELECT 1 FROM calendar_links WHERE user_id = ?', ownerId)) {
    await syncUser(ownerId);
  } else {
    run(`DELETE FROM free_days WHERE user_id = ? AND date >= ?
         AND date NOT IN (SELECT date FROM manual_days WHERE user_id = ?)`, ownerId, today(), ownerId);
  }
  logUser(ctx, ownerId === ctx.user.id ? 'calendar removed' : `admin: calendar removed for user ${ownerId}`);
  ctx.redirect('/settings?msg=calendar_removed');
});

on('POST', '/settings/calendars/sync', async ctx => {
  await syncUser(ctx.user.id);
  ctx.redirect('/settings?msg=calendar_synced');
});

// The Rules form: one per member, for all their calendars; saving works the days out again at once.
// busy: one checkbox per always-busy "<weekday><slot>" ('1am' = Monday morning); anything else is dropped.
const BUSY_SLOT = new RegExp(`^[0-6](${SLOTS.join('|')})$`);
on('POST', '/settings/calendars/rules', async ctx => {
  const busyMinutes = Number(ctx.body.get('busy_minutes'));
  const syncDays = Number(ctx.body.get('sync_days'));
  if (!isValidBusyMinutes(busyMinutes)) {
    return showSettings(ctx, { status: 400, errors: { rules: t(ctx.lang, 'errors.busyThreshold') } });
  }
  if (!isValidSyncDays(syncDays)) {
    return showSettings(ctx, { status: 400, errors: { rules: t(ctx.lang, 'errors.syncDays') } });
  }
  const busySlots = [...new Set(ctx.body.getAll('busy').filter(value => BUSY_SLOT.test(value)))].sort().join(' ');
  const ignoreWords = cleanText(ctx.body.get('ignore_words'), 500).split(',')
    .map(word => word.trim()).filter(Boolean).join(', ');
  run('UPDATE users SET busy_minutes = ?, busy_slots = ?, ignore_words = ?, sync_days = ? WHERE id = ?',
    busyMinutes, busySlots, ignoreWords, syncDays, ctx.user.id);
  await syncUser(ctx.user.id);
  ctx.redirect('/settings?msg=calendar_rules');
});

// The whole Customisation panel is one form: every value is checked before any is saved.
on('POST', '/settings/customisation', ctx => {
  const weekStart = Number(ctx.body.get('week_start'));
  const dateFormat = ctx.body.get('date_format');
  const showBirthdays = ctx.body.get('show_birthdays') === '1' ? 1 : 0; // an unchecked checkbox posts nothing: hide
  const hideFreeBorder = ctx.body.get('hide_free_border') === '1' ? 1 : 0; // unchecked: keep the border
  const hideOwnInitials = ctx.body.get('hide_own_initials') === '1' ? 1 : 0; // unchecked: show my initials
  const continuousCalendar = ctx.body.get('continuous_calendar') === '1' ? 1 : 0; // unchecked: blank cells
  const errors = {};
  if (!isValidWeekStart(weekStart)) {
    errors.weekStart = t(ctx.lang, 'errors.weekStart');
  }
  if (!isValidDateFormat(dateFormat)) {
    errors.dateFormat = t(ctx.lang, 'errors.dateFormat');
  }
  if (hasErrors(errors)) {
    return showSettings(ctx, { status: 400, errors });
  }
  run('UPDATE users SET week_start = ?, date_format = ?, show_birthdays = ?, hide_free_border = ?, '
    + 'hide_own_initials = ?, continuous_calendar = ? WHERE id = ?',
    weekStart, dateFormat, showBirthdays, hideFreeBorder, hideOwnInitials, continuousCalendar, ctx.user.id);
  ctx.redirect('/settings?msg=customisation');
});

// ---- profile: who you are (name, birthday, color) and how you log in ----

/**
 * The profile page. After a rejected form, `errors` shows under its fields and opens its panel,
 * and `about` holds the About me values as they were typed, so nothing has to be typed twice.
 */
const showProfile = (ctx, { status = 200, errors = {}, about } = {}) => ctx.html(views.profilePage(ctx.user, {
  msg: ctx.url.searchParams.get('msg'),
  passkeys: auth.userCredentials(ctx.user.id),
  errors,
  about,
}), status);

on('GET', '/profile', ctx => showProfile(ctx));

// The whole About me panel is one form: every value is checked before any is saved.
// The name is also the login, so it stays unique (users.name is COLLATE NOCASE). Changing only
// your own capitalisation is allowed, hence `id != ?`. An empty birthday clears it; no future dates
// (the input's max says the same to the browser).
on('POST', '/profile/about', ctx => {
  const name = cleanText(ctx.body.get('name'), 40);
  const birthday = ctx.body.get('birthday') || '';
  const color = Number(ctx.body.get('color'));
  const privacy = ctx.body.get('privacy'); // 'private' | 'public'
  const errors = {};
  if (!name) {
    errors.name = t(ctx.lang, 'errors.nameRequired');
  } else if (get('SELECT 1 FROM users WHERE name = ? AND id != ?', name, ctx.user.id)) {
    errors.name = t(ctx.lang, 'errors.nameTaken');
  }
  if (birthday && !isValidDate(birthday)) {
    errors.birthday = t(ctx.lang, 'errors.invalidDate');
  } else if (birthday > today()) {
    errors.birthday = t(ctx.lang, 'errors.birthdayFuture');
  }
  if (!isValidColor(color)) {
    errors.color = t(ctx.lang, 'errors.invalidColor');
  }
  // Groups off: the page has no Account choice, and the saved one is kept for when groups come back.
  if (ctx.user.groups_enabled && privacy !== 'private' && privacy !== 'public') {
    errors.privacy = t(ctx.lang, 'errors.pickPrivacy');
  }
  const isPrivate = ctx.user.groups_enabled ? (privacy === 'public' ? 0 : 1) : ctx.user.is_private;
  if (hasErrors(errors)) {
    // An invalid color cannot be drawn, so the slider goes back to the saved one.
    const about = { name, birthday, color: errors.color ? ctx.user.color : color, is_private: isPrivate };
    return showProfile(ctx, { status: 400, errors, about });
  }
  run('UPDATE users SET name = ?, birthday = ?, color = ?, is_private = ? WHERE id = ?',
    name, birthday || null, color, isPrivate, ctx.user.id);
  // Logged under the old name, so the log links the two.
  if (name !== ctx.user.name) {
    logUser(ctx, `name changed to ${JSON.stringify(name)}`);
  }
  ctx.redirect('/profile?msg=about');
});

on('POST', '/profile/password', async ctx => {
  const newPassword = ctx.body.get('password') || '';
  const errors = {};
  if (!(await auth.verifyPassword(ctx.body.get('current') || '', ctx.user.password_hash))) {
    errors.current = t(ctx.lang, 'errors.currentPasswordWrong');
  }
  if (newPassword.length < MIN_PASSWORD) {
    errors.password = t(ctx.lang, 'errors.newPasswordShort', { min: MIN_PASSWORD });
  }
  if (hasErrors(errors)) {
    return showProfile(ctx, { status: 400, errors });
  }

  run('UPDATE users SET password_hash = ? WHERE id = ?', await auth.hashPassword(newPassword), ctx.user.id);
  // Log every device out, then hand this browser a fresh session so the user stays put.
  auth.deleteUserSessions(ctx.user.id);
  ctx.setCookie('sid', auth.createSession(ctx.user.id), auth.SESSION_SECONDS);
  logUser(ctx, 'password changed');
  ctx.redirect('/profile?msg=password');
});

// The user handle for the discoverable credential is the numeric user id: opaque, stable, no PII.
// excludeCredentials stops one authenticator from registering itself against the same account twice.
on('POST', '/profile/passkeys/options', ctx => ctx.json({
  challenge: auth.createChallenge(),
  rpId: RP_ID,
  userId: String(ctx.user.id),
  name: ctx.user.name,
  exclude: auth.userCredentials(ctx.user.id).map(credential => credential.id),
}));

on('POST', '/profile/passkeys', ctx => {
  const challenge = ctx.body.get('challenge') || '';
  const label = cleanText(ctx.body.get('label'), 40) || t(ctx.lang, 'profile.defaultLabel');
  const added = auth.consumeChallenge(challenge) && auth.addCredential({
    userId: ctx.user.id,
    id: ctx.body.get('id') || '',
    publicKey: ctx.body.get('publicKey') || '',
    alg: Number(ctx.body.get('alg')),
    label,
    clientDataJSON: ctx.body.get('clientDataJSON') || '',
    authenticatorData: ctx.body.get('authenticatorData') || '',
    challenge,
  });
  logUser(ctx, added ? `passkey added ${JSON.stringify(label)}` : 'passkey add failed');
  added ? ctx.json({ ok: true }) : ctx.json({ error: t(ctx.lang, 'errors.passkeyUnverified') }, 400);
});

// A plain form, so removing a passkey works with JS off.
on('POST', '/profile/passkeys/delete', ctx => {
  // Only logged when a row actually went: a stale form for an already removed passkey is not an event.
  if (auth.deleteCredential(ctx.body.get('id') || '', ctx.user).changes) {
    logUser(ctx, 'passkey removed');
  }
  ctx.redirect('/profile?msg=passkey_removed');
});

// ---- administration ----
// Everything admin-only lives under /admin. The guard is here, not in the view, so a future
// admin tool only has to be added to this section to inherit it.

const requireAdmin = ctx => ctx.user.is_admin || ctx.fail(403, 'errors.adminsOnly');

/** The administration page. errors.members goes under the Members title (a rejected member action). */
const showAdmin = (ctx, { status = 200, errors = {} } = {}) => ctx.html(views.adminPage(ctx.user, {
  base: BASE_URL,
  msg: ctx.url.searchParams.get('msg'),
  invites: auth.openInvites(),
  members: all('SELECT id, name, is_admin FROM users ORDER BY name'),
  log: tailLog(200),
  errors,
}), status);

on('GET', '/admin', ctx => requireAdmin(ctx) && showAdmin(ctx));

/** A whole log file as a download. Streamed, since logs only ever grow. */
function sendLogFile(ctx, path, fileName) {
  if (!requireAdmin(ctx)) {
    return;
  }
  ctx.res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Cache-Control': 'private, no-store',
  });
  if (ctx.req.method === 'HEAD' || !existsSync(path)) {
    return ctx.res.end(); // nothing logged yet: empty file
  }
  createReadStream(path).pipe(ctx.res);
}

on('GET', '/admin/log', ctx => sendLogFile(ctx, LOG_PATH, 'meshtime.log'));
on('GET', '/admin/errors', ctx => sendLogFile(ctx, ERROR_LOG_PATH, 'errors.log'));

on('POST', '/admin/invite', ctx => {
  if (!requireAdmin(ctx)) {
    return;
  }
  const userId = ctx.body.get('user_id') ? Number(ctx.body.get('user_id')) : null;
  const target = userId && get('SELECT name FROM users WHERE id = ?', userId);
  if (userId && !target) {
    return showAdmin(ctx, { status: 400, errors: { members: t(ctx.lang, 'errors.memberGone') } });
  }
  const inviteToken = auth.createInvite({ createdBy: ctx.user.id, userId }); // userId set => password-reset link
  logUser(ctx, target ? `admin: reset link created for ${JSON.stringify(target.name)}` : 'admin: invite link created');
  // app.js (data-copy-link forms) asks for JSON: it copies the link itself, then reloads the page.
  if (ctx.req.headers.accept === 'application/json') {
    return ctx.json({ url: `${BASE_URL}/invite/${inviteToken}` });
  }
  ctx.redirect('/admin?msg=invite');
});

// The Options panel is one form. An unchecked checkbox posts nothing: off.
on('POST', '/admin/options', ctx => {
  if (!requireAdmin(ctx)) {
    return;
  }
  const memberInvites = ctx.body.get('member_invites') === '1' ? 1 : 0;
  // A hidden groups_enabled=0 comes before the checkbox (admin.html), so the field is always posted. A form
  // without it (an admin page left open over an update) leaves groups as they are instead of turning them off.
  const groupsOn = ctx.body.has('groups_enabled')
    ? (ctx.body.getAll('groups_enabled').includes('1') ? 1 : 0)
    : ctx.user.groups_enabled;
  tx(() => {
    // Nothing else changes: while groups are off, GROUPS_OFF shows everyone and everything as public.
    run('UPDATE app_settings SET member_invites = ?, groups_enabled = ?', memberInvites, groupsOn);
    if (!memberInvites) {
      // Turning it off takes effect now: the links members made and nobody used yet stop working too.
      run(`DELETE FROM invites WHERE used_at IS NULL AND user_id IS NULL
             AND created_by IN (SELECT id FROM users WHERE is_admin = 0)`);
    }
  });
  logUser(ctx, `admin: member invite links turned ${memberInvites ? 'on' : 'off'}`);
  if (groupsOn !== ctx.user.groups_enabled) {
    logUser(ctx, `admin: groups turned ${groupsOn ? 'on' : 'off'}`);
  }
  ctx.redirect('/admin?msg=options');
});

// Offboarding. ON DELETE CASCADE takes sessions, passkeys, votes, free days, reset links, group
// memberships and invites with the row, and the feed token dies with it. Their events and polls are deleted
// too: handing them to the admin would show them to whoever sees the admin, not the audience they were for.
// Groups they created go to another member (afterLeavingGroup).
on('POST', '/admin/members/(?<id>\\d+)/delete', ctx => {
  if (!requireAdmin(ctx)) {
    return;
  }
  const memberId = Number(ctx.params.id);
  if (memberId === ctx.user.id) {
    return showAdmin(ctx, { status: 400, errors: { members: t(ctx.lang, 'errors.removeSelf') } });
  }
  const member = get('SELECT name FROM users WHERE id = ?', memberId);
  if (!member) {
    return showAdmin(ctx, { status: 404, errors: { members: t(ctx.lang, 'errors.memberGone') } });
  }
  tx(() => {
    const groupIds = all('SELECT group_id FROM group_members WHERE user_id = ?', memberId).map(row => row.group_id);
    run('DELETE FROM group_members WHERE user_id = ?', memberId);
    for (const groupId of groupIds) {
      afterLeavingGroup(groupId, memberId);
      deleteGroupIfEmpty(groupId);
    }
    // ON DELETE CASCADE drops their shares, and a poll's dates and votes
    run('DELETE FROM events WHERE created_by = ?', memberId);
    run('DELETE FROM polls WHERE created_by = ?', memberId);
    run('DELETE FROM users WHERE id = ?', memberId);
  });
  logUser(ctx, `admin: member removed ${JSON.stringify(member.name)}`);
  ctx.redirect('/admin?msg=removed');
});

// ---- ICS feeds: the only unauthenticated data routes; the token in the URL is the credential ----
// A feed is read by a calendar app's server, not the member's browser, so it speaks its owner's language
// (users.language), English while they never picked one.
const ICS_HEADERS = { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, no-cache' };

// One feed per group: its members' public events and the private ones shared with it; nobody else's.
// The token is the subscriber's own, so the link dies when they leave the group or rotate their links.
on('GET', '/feed/(?<token>[\\w-]+)/groups/(?<id>\\d+)\\.ics', ctx => {
  if (!groupsEnabled()) {
    return ctx.fail(404, 'errors.feedNotFound');
  }
  const group = get(`SELECT g.id, g.name FROM users u
                     JOIN group_members m ON m.user_id = u.id
                     JOIN member_groups g ON g.id = m.group_id
                     WHERE u.feed_token = ? AND g.id = ?`, ctx.params.token, Number(ctx.params.id));
  if (!group) {
    return ctx.fail(404, 'errors.feedNotFound');
  }
  const host = new URL(BASE_URL).host;

  const items = all(`SELECT e.* FROM events e JOIN users u ON u.id = e.created_by WHERE ${EVENT_IN_GROUP}`,
    group.id, group.id)
    .map(event => ({
    uid: 'event-' + event.id,
    date: event.date,
    endDate: event.end_date,
    startTime: event.start_time,
    endTime: event.end_time,
    summary: event.title,
    stamp: event.created_at,
  }));

  ctx.text(buildIcs({ name: `Meshtime · ${group.name}`, host, items }), 200, ICS_HEADERS);
}, true);

// Every event, in one feed: only while groups are off (Administration → Options), when there are no group
// feeds and everything is public. With groups on it answers 404, so it can never leak a private event.
on('GET', '/feed/(?<token>[\\w-]+)/events\\.ics', ctx => {
  const owner = get('SELECT language FROM users WHERE feed_token = ?', ctx.params.token);
  if (groupsEnabled() || !owner) {
    return ctx.fail(404, 'errors.feedNotFound');
  }
  // GROUPS_OFF is already true here; kept so the feed stays safe on its own
  const items = all(`SELECT * FROM events WHERE ${GROUPS_OFF}`).map(event => ({
    uid: 'event-' + event.id,
    date: event.date,
    endDate: event.end_date,
    startTime: event.start_time,
    endTime: event.end_time,
    summary: event.title,
    stamp: event.created_at,
  }));
  const name = `Meshtime · ${t(owner.language, 'feeds.allEvents')}`;
  ctx.text(buildIcs({ name, host: new URL(BASE_URL).host, items }), 200, ICS_HEADERS);
}, true);

// One yearly recurring all-day event per member who gave a birthday, starting on the birthday itself:
// the subscriber's own and their groups' members' (BIRTHDAY_VISIBLE_TO_ME).
on('GET', '/feed/(?<token>[\\w-]+)/birthdays\\.ics', ctx => {
  const viewer = get('SELECT id, language FROM users WHERE feed_token = ?', ctx.params.token);
  if (!viewer) {
    return ctx.fail(404, 'errors.feedNotFound');
  }
  const items = all(`SELECT u.id, u.name, u.birthday, u.created_at FROM users u
                     WHERE u.birthday IS NOT NULL AND ${BIRTHDAY_VISIBLE_TO_ME}`, viewer.id, viewer.id).map(member => ({
    uid: 'birthday-' + member.id,
    date: member.birthday,
    rrule: birthdayRrule(member.birthday),
    summary: `🎉 ${t(viewer.language, 'calendar.birthday', { name: member.name })}`,
    stamp: member.created_at,
  }));
  const name = `Meshtime · ${t(viewer.language, 'feeds.birthdays')}`;
  ctx.text(buildIcs({ name, host: new URL(BASE_URL).host, items }), 200, ICS_HEADERS);
}, true);

// ---- language: the menu at the end of the nav (src/templates/language-menu.html) ----

/**
 * Where the language menu sends someone back to: `back`, the page it was picked on, kept on this site. A page that
 * answered a form (a rejected /profile/about) has no GET route of its own: the nearest page above it then
 * (/profile). Anything else, or another site, goes to the calendar.
 */
function backPath(back) {
  const url = URL.parse(back ?? '/', 'http://meshtime.invalid');
  if (url?.host !== 'meshtime.invalid') {
    return '/';
  }
  let path = url.pathname;
  while (path !== '/' && !routes.some(route => route.method === 'GET' && route.path.test(path))) {
    path = path.slice(0, path.lastIndexOf('/')) || '/';
  }
  return path === url.pathname ? path + url.search : path;
}

const LANGUAGE_COOKIE_SECONDS = 365 * 24 * 60 * 60; // a year, like app.js's hour12 cookie

// Saved on the account when logged in, and in a cookie either way, so the login page keeps it after logging out.
on('POST', '/language', ctx => {
  const lang = ctx.body.get('lang');
  if (!isValidLanguage(lang)) {
    return ctx.fail(400, 'errors.invalidLanguage');
  }
  if (ctx.user) {
    run('UPDATE users SET language = ? WHERE id = ?', lang, ctx.user.id);
  }
  ctx.setCookie('lang', lang, LANGUAGE_COOKIE_SECONDS);
  ctx.redirect(backPath(ctx.body.get('back')));
}, true);
