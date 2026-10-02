import { all, get, run, now, tx } from './db.js';
import * as auth from './auth.js';
import * as views from './views.js';
import { logEvent, tailLog, LOG_PATH } from './log.js';
import { createReadStream, existsSync } from 'node:fs';
import {
  isValidDate, isValidMonth, isValidWeekStart, isValidDateFormat, isValidDayPart, isValidColor, eventError,
  bestDates, buildIcs, birthdayIn, birthdayRrule, today, randomColor, ANSWERS, MAX_DATES, MIN_PASSWORD, BASE_URL,
  RP_ID,
} from './lib.js';

export const routes = [];

// Registers a route. `path` is regex source anchored to the whole pathname, so named groups
// like (?<id>\d+) arrive as ctx.params.id. Public routes skip the login check in server.js.
const on = (method, path, handler, isPublic = false) =>
  routes.push({ method, path: new RegExp(`^${path}$`), handler, public: isPublic });

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
const backToMonth = ctx => '/?m=' + postedMonth(ctx);

const TOO_MANY = 'Too many attempts. Try again in 15 minutes.';
const BANNED = 'banned (too many attempts)'; // the log's name for a login the rate limit refused

/** Logs an action done by the logged-in member. */
const logUser = (ctx, action) => logEvent({ ip: ctx.ip, user: ctx.user.name, known: true, action });

const startSession = (ctx, userId) => {
  ctx.setCookie('sid', auth.createSession(userId), auth.SESSION_SECONDS);
  ctx.redirect('/');
};

// ---- auth ----
on('GET', '/login', ctx => ctx.user ? ctx.redirect('/') : ctx.html(views.loginPage()), true);

on('POST', '/login', async ctx => {
  const name = cleanText(ctx.body.get('name'), 40);
  const user = get('SELECT * FROM users WHERE name = ?', name);
  const log = action => logEvent({ ip: ctx.ip, user: user?.name ?? name, known: Boolean(user), action });
  if (!auth.loginAllowed(ctx.ip, name)) {
    log(BANNED);
    return ctx.html(views.loginPage(TOO_MANY), 429);
  }
  // Hash even for an unknown name, so the response time does not reveal which names exist.
  const passwordOk = await auth.verifyPassword(ctx.body.get('password') || '', user?.password_hash ?? auth.DUMMY_HASH);
  if (!user || !passwordOk) {
    log('login failed (password)');
    auth.loginFailed(ctx.ip, name);
    return ctx.html(views.loginPage('Wrong name or password.'), 401);
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
  ctx.json({ error: TOO_MANY }, 429);
}, true);

on('POST', '/login/passkey', ctx => {
  const credentialId = ctx.body.get('id') || '';
  const owner = auth.credentialOwner(credentialId);
  // An unknown passkey has no member behind it: log a short prefix of its id instead.
  const logName = owner ?? 'passkey ' + credentialId.slice(0, 16);
  const log = action => logEvent({ ip: ctx.ip, user: logName, known: Boolean(owner), action });
  if (!auth.loginAllowed(ctx.ip, credentialId)) {
    log(BANNED);
    return ctx.json({ error: TOO_MANY }, 429);
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
    return ctx.json({ error: 'That passkey is not recognised.' }, 401);
  }
  log('login ok (passkey)');
  ctx.setCookie('sid', auth.createSession(user.id), auth.SESSION_SECONDS);
  ctx.json({ ok: true }); // the client navigates; a 303 here would make fetch load the page for nothing
}, true);

const INVITE_GONE = 'This link is invalid, used, or expired.';

on('GET', '/invite/(?<token>[\\w-]+)', ctx => {
  const invite = auth.getInvite(ctx.params.token);
  if (!invite) {
    return ctx.fail(410, INVITE_GONE);
  }
  ctx.html(views.invitePage(invite.token, invite.user_name));
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
    errors.name = 'Name is required.';
  } else if (!isReset && get('SELECT 1 FROM users WHERE name = ?', name)) {
    errors.name = 'That name is already taken.';
  }
  if (password.length < MIN_PASSWORD) {
    errors.password = `Password must be at least ${MIN_PASSWORD} characters.`;
  }
  if (hasErrors(errors)) {
    return ctx.html(views.invitePage(invite.token, invite.user_name, { errors, name }), 400);
  }

  const passwordHash = await auth.hashPassword(password);
  const userId = tx(() => {
    // Consumed inside the transaction: two submissions of the same link cannot both succeed.
    if (!auth.consumeInvite(invite.token)) {
      throw Object.assign(new Error('invite gone'), { status: 410 });
    }
    if (isReset) {
      run('UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, invite.user_id);
      // A reset is a recovery: log out every device and drop every passkey, so nothing an intruder
      // planted on the account keeps working. The member re-adds their passkeys in Profile.
      auth.deleteUserSessions(invite.user_id);
      auth.deleteUserCredentials(invite.user_id);
      return invite.user_id;
    }
    return run(`INSERT INTO users(name, password_hash, feed_token, is_admin, created_at, color)
                VALUES (?,?,?,?,?,?)`,
      name, passwordHash, auth.token(), invite.is_admin, now(), randomColor()).lastInsertRowid;
  });
  logEvent({ ip: ctx.ip, user: isReset ? invite.user_name : name, known: true,
    action: isReset ? 'password reset by link' : `account created by invite${invite.is_admin ? ' (admin)' : ''}` });
  startSession(ctx, userId);
}, true);

// ---- calendar ----

/** Draws one month of the calendar. `error` goes under the month title (a rejected /free). */
function showCalendar(ctx, yearMonth, { status = 200, error } = {}) {
  const inMonth = yearMonth + '-%'; // dates are 'YYYY-MM-DD' strings, so LIKE is enough

  // date -> everyone who marked themselves free that day, for the initials in each cell
  const free = new Map();
  for (const row of all(`SELECT f.date, f.part, u.name, u.color FROM free_days f
                         JOIN users u ON u.id = f.user_id
                         WHERE f.date LIKE ? ORDER BY u.name`, inMonth)) {
    if (!free.has(row.date)) {
      free.set(row.date, []);
    }
    free.get(row.date).push({ name: row.name, color: row.color, part: row.part });
  }

  // date -> which part of it I am free ('all' | 'am' | 'pm')
  const mine = new Map(all('SELECT date, part FROM free_days WHERE user_id = ? AND date LIKE ?', ctx.user.id, inMonth)
    .map(row => [row.date, row.part]));
  // Every event that touches this month, including ones that started before or end after it.
  // ISO dates compare as strings, and '-31' is past the last day of any month. All-day ones first.
  const events = all(`SELECT e.*, u.name AS creator FROM events e
                      JOIN users u ON u.id = e.created_by
                      WHERE e.date <= ? AND e.end_date >= ?
                      ORDER BY e.date, e.start_time IS NOT NULL, e.start_time, e.id`,
                      yearMonth + '-31', yearMonth + '-01');
  const members = get('SELECT COUNT(*) AS n FROM users').n; // a day is "everyone free" at this count
  // Birthdays are not events rows: each one is worked out from users.birthday for the month shown.
  const birthdays = ctx.user.show_birthdays ? all('SELECT name, color, birthday FROM users WHERE birthday IS NOT NULL')
    .map(member => ({ name: member.name, color: member.color, date: birthdayIn(yearMonth, member.birthday) }))
    .filter(member => member.date) : [];

  ctx.html(views.calendarPage(ctx.user, yearMonth, { free, mine, events, birthdays, today: today(), members, error }),
    status);
}

on('GET', '/', ctx => {
  const requestedMonth = ctx.url.searchParams.get('m');
  showCalendar(ctx, isValidMonth(requestedMonth) ? requestedMonth : today().slice(0, 7));
});

// Two ways in. A plain click on a day sends no `part` and toggles it: try the delete first, insert
// "all day" only if there was nothing to delete. The long-press / double-click menu sends `part`:
// 'all', 'am', 'pm' or 'eve' sets exactly that, 'none' clears the day.
on('POST', '/free', ctx => {
  const date = ctx.body.get('date');
  const part = ctx.body.get('part');
  if (!isValidDate(date)) {
    return showCalendar(ctx, postedMonth(ctx), { status: 400, error: 'Invalid date.' });
  }

  if (part === null) {
    const removed = run('DELETE FROM free_days WHERE user_id = ? AND date = ?', ctx.user.id, date).changes;
    if (removed === 0) {
      run('INSERT INTO free_days(user_id, date) VALUES (?,?)', ctx.user.id, date);
    }
  } else if (part === 'none') {
    run('DELETE FROM free_days WHERE user_id = ? AND date = ?', ctx.user.id, date);
  } else if (isValidDayPart(part)) {
    run(`INSERT INTO free_days(user_id, date, part) VALUES (?,?,?)
         ON CONFLICT DO UPDATE SET part = excluded.part`, ctx.user.id, date, part);
  } else {
    return showCalendar(ctx, postedMonth(ctx), { status: 400, error: 'Invalid part of the day.' });
  }
  ctx.redirect(backToMonth(ctx));
});

// ---- events: one page adds and edits (views.eventPage) ----

/**
 * The event form, in the shape of an events row so a rejected form re-renders with what was typed.
 * The optional fields arrive as '' when left empty: those become NULL (end_date: the start date).
 */
function readEventForm(ctx) {
  const colorText = ctx.body.get('color') || '';
  // The time inputs are only hidden when "All day" is ticked, so the browser still sends them: drop them.
  const allDay = ctx.body.get('all_day') === '1';
  const event = {
    title: cleanText(ctx.body.get('title'), 100),
    date: ctx.body.get('date') || '',
    end_date: ctx.body.get('end_date') || null,
    start_time: allDay ? null : ctx.body.get('start_time') || null,
    end_time: allDay ? null : ctx.body.get('end_time') || null,
    color: colorText === '' ? null : Number(colorText),
    allDay, // not a column: lets a rejected form show the box as it was posted
  };
  const errors = {};
  if (!event.title) {
    errors.title = 'A title is required.';
  }
  const whenError = eventError({
    date: event.date, endDate: event.end_date, startTime: event.start_time, endTime: event.end_time,
  });
  if (whenError) {
    errors[whenError.field] = whenError.message;
  }
  if (!allDay && !event.start_time) {
    errors.start ??= 'Pick a start time, or tick All day.';
  }
  if (event.color !== null && !isValidColor(event.color)) {
    errors.color = 'Invalid color.';
  }
  event.end_date ||= event.date;
  return { event, errors };
}

/** The event with this id, if the member may change it: their own, or any event if they are an admin. */
const editableEvent = ctx => {
  const event = get('SELECT * FROM events WHERE id = ?', Number(ctx.params.id));
  if (!event) {
    return ctx.fail(404, 'Event not found.');
  }
  if (event.created_by !== ctx.user.id && !ctx.user.is_admin) {
    return ctx.fail(403, 'Only its creator or an admin can change this event.');
  }
  return event;
};

// ?date= prefills the start date, e.g. for a link from a given day.
on('GET', '/events/new', ctx => {
  const date = ctx.url.searchParams.get('date');
  ctx.html(views.eventPage(ctx.user, { event: { date: isValidDate(date) ? date : '' } }));
});

on('POST', '/events', ctx => {
  const { event, errors } = readEventForm(ctx);
  if (hasErrors(errors)) {
    return ctx.html(views.eventPage(ctx.user, { event, errors }), 400);
  }
  run(`INSERT INTO events(title, date, end_date, start_time, end_time, color, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    event.title, event.date, event.end_date, event.start_time, event.end_time, event.color, ctx.user.id, now());
  ctx.redirect('/?m=' + event.date.slice(0, 7));
});

on('GET', '/events/(?<id>\\d+)', ctx => {
  const event = editableEvent(ctx);
  if (event) {
    ctx.html(views.eventPage(ctx.user, { event }));
  }
});

on('POST', '/events/(?<id>\\d+)', ctx => {
  const existing = editableEvent(ctx);
  if (!existing) {
    return;
  }
  const { event, errors } = readEventForm(ctx);
  event.id = existing.id;
  if (hasErrors(errors)) {
    return ctx.html(views.eventPage(ctx.user, { event, errors }), 400);
  }
  run(`UPDATE events SET title = ?, date = ?, end_date = ?, start_time = ?, end_time = ?, color = ? WHERE id = ?`,
    event.title, event.date, event.end_date, event.start_time, event.end_time, event.color, existing.id);
  ctx.redirect('/?m=' + event.date.slice(0, 7));
});

// The WHERE clause is the permission check: your own events, or any event if you are an admin.
on('POST', '/events/(?<id>\\d+)/delete', ctx => {
  run('DELETE FROM events WHERE id = ? AND (created_by = ? OR ? = 1)',
    Number(ctx.params.id), ctx.user.id, ctx.user.is_admin);
  ctx.redirect(backToMonth(ctx));
});

// ---- polls ----

/** Everything pollPage needs: the poll, its dates, all members, all votes, who still owes an answer. */
function loadPoll(pollId) {
  const poll = get('SELECT * FROM polls WHERE id = ?', pollId);
  if (!poll) {
    return null;
  }

  const dates = all('SELECT date FROM poll_dates WHERE poll_id = ? ORDER BY date', pollId).map(row => row.date);
  const members = all('SELECT id, name FROM users ORDER BY name');
  const votes = all('SELECT date, user_id, answer FROM poll_votes WHERE poll_id = ?', pollId);

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
    event: get('SELECT * FROM events WHERE poll_id = ?', pollId), // set once the date is confirmed
  };
}

// Open polls first, newest first. `voters` counts the members who answered every date of the poll.
const POLL_LIST_SQL = `
SELECT p.*,
  (SELECT COUNT(*) FROM users u
     WHERE NOT EXISTS (
       SELECT 1 FROM poll_dates d WHERE d.poll_id = p.id
         AND NOT EXISTS (SELECT 1 FROM poll_votes pv
                           WHERE pv.poll_id = p.id AND pv.date = d.date AND pv.user_id = u.id))) AS voters,
  (SELECT COUNT(*) FROM users) AS members
FROM polls p
ORDER BY p.closed_at IS NOT NULL, p.created_at DESC`;

on('GET', '/polls', ctx => ctx.html(views.pollsPage(ctx.user, all(POLL_LIST_SQL))));
on('GET', '/polls/new', ctx => ctx.html(views.newPollPage(ctx.user)));

on('POST', '/polls/new', ctx => {
  const title = cleanText(ctx.body.get('title'), 100);
  const dates = [...new Set(ctx.body.getAll('dates').filter(Boolean))].sort(); // drop blanks and duplicates
  const errors = {};
  if (!title) {
    errors.title = 'A title is required.';
  }
  if (!dates.length || dates.length > MAX_DATES || !dates.every(isValidDate)) {
    errors.dates = `Propose 1 to ${MAX_DATES} valid dates.`;
  }
  if (hasErrors(errors)) {
    return ctx.html(views.newPollPage(ctx.user, { errors, title }), 400);
  }

  const pollId = tx(() => {
    const id = run('INSERT INTO polls(title, created_by, created_at) VALUES (?,?,?)',
      title, ctx.user.id, now()).lastInsertRowid;
    for (const date of dates) {
      run('INSERT INTO poll_dates(poll_id, date) VALUES (?,?)', id, date);
    }
    return id;
  });
  ctx.redirect('/polls/' + pollId);
});

on('GET', '/polls/(?<id>\\d+)', ctx => {
  const data = loadPoll(Number(ctx.params.id));
  if (!data) {
    return ctx.fail(404, 'Poll not found.');
  }
  ctx.html(views.pollPage(ctx.user, data));
});

/** The poll page again after a rejected form. errors.answers goes under the title, errors.result in the result. */
const rejectPoll = (ctx, data, status, errors) => ctx.html(views.pollPage(ctx.user, { ...data, errors }), status);

// Saving answers replaces this user's previous ones. Dates left on "—" stay unanswered.
on('POST', '/polls/(?<id>\\d+)', ctx => {
  const pollId = Number(ctx.params.id);
  const data = loadPoll(pollId);
  if (!data) {
    return ctx.fail(404, 'Poll not found.');
  }
  if (data.poll.closed_at) {
    return rejectPoll(ctx, data, 409, { answers: 'This poll is closed: your answers were not saved.' });
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
  run(`UPDATE polls SET closed_at = ?
       WHERE id = ? AND closed_at IS NULL AND (created_by = ? OR ? = 1)`,
    now(), pollId, ctx.user.id, ctx.user.is_admin);
  ctx.redirect('/polls/' + pollId);
});

// Turns the winning date into a calendar event and closes the poll.
on('POST', '/polls/(?<id>\\d+)/confirm', ctx => {
  const pollId = Number(ctx.params.id);
  const data = loadPoll(pollId);
  const date = ctx.body.get('date');
  if (!data) {
    return ctx.fail(404, 'Poll not found.');
  }
  if (!data.complete && !data.poll.closed_at) {
    return rejectPoll(ctx, data, 409, { answers: 'Not everyone has answered yet.' });
  }
  // Only a winning date may be confirmed; the form offers exactly these, so this is the server-side twin.
  if (!data.best.includes(date)) {
    return rejectPoll(ctx, data, 400, { result: 'Not one of the best dates.' });
  }

  if (!data.event) {
    tx(() => { // idempotent: events.poll_id is UNIQUE, so a double click adds nothing
      run('INSERT INTO events(title, date, end_date, created_by, poll_id, created_at) VALUES (?,?,?,?,?,?)',
        data.poll.title, date, date, ctx.user.id, pollId, now());
      run('UPDATE polls SET chosen_date = ?, closed_at = COALESCE(closed_at, ?) WHERE id = ?', date, now(), pollId);
    });
  }
  ctx.redirect('/polls/' + pollId);
});

// ---- settings ----

/** The settings page; after a rejected form, `errors` shows under its fields and opens its panel. */
const showSettings = (ctx, { status = 200, errors = {} } = {}) =>
  ctx.html(views.settingsPage(ctx.user, { base: BASE_URL, msg: ctx.url.searchParams.get('msg'), errors }), status);

on('GET', '/settings', ctx => showSettings(ctx));

on('POST', '/settings/rotate-feed', ctx => {
  run('UPDATE users SET feed_token = ? WHERE id = ?', auth.token(), ctx.user.id);
  logUser(ctx, 'feed links rotated');
  ctx.redirect('/settings?msg=rotated');
});

// The whole Customisation panel is one form: every value is checked before any is saved.
on('POST', '/settings/customisation', ctx => {
  const weekStart = Number(ctx.body.get('week_start'));
  const dateFormat = ctx.body.get('date_format');
  const showBirthdays = ctx.body.get('show_birthdays') === '1' ? 1 : 0; // an unchecked checkbox posts nothing: hide
  const errors = {};
  if (!isValidWeekStart(weekStart)) {
    errors.weekStart = 'Invalid first day of the week.';
  }
  if (!isValidDateFormat(dateFormat)) {
    errors.dateFormat = 'Invalid date format.';
  }
  if (hasErrors(errors)) {
    return showSettings(ctx, { status: 400, errors });
  }
  run('UPDATE users SET week_start = ?, date_format = ?, show_birthdays = ? WHERE id = ?',
    weekStart, dateFormat, showBirthdays, ctx.user.id);
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
  const errors = {};
  if (!name) {
    errors.name = 'Name is required.';
  } else if (get('SELECT 1 FROM users WHERE name = ? AND id != ?', name, ctx.user.id)) {
    errors.name = 'That name is already taken.';
  }
  if (birthday && !isValidDate(birthday)) {
    errors.birthday = 'Invalid date.';
  } else if (birthday > today()) {
    errors.birthday = 'Your birthday cannot be in the future.';
  }
  if (!isValidColor(color)) {
    errors.color = 'Invalid color.';
  }
  if (hasErrors(errors)) {
    // An invalid color cannot be drawn, so the slider goes back to the saved one.
    const about = { name, birthday, color: errors.color ? ctx.user.color : color };
    return showProfile(ctx, { status: 400, errors, about });
  }
  run('UPDATE users SET name = ?, birthday = ?, color = ? WHERE id = ?', name, birthday || null, color, ctx.user.id);
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
    errors.current = 'Current password is wrong.';
  }
  if (newPassword.length < MIN_PASSWORD) {
    errors.password = `New password must be at least ${MIN_PASSWORD} characters.`;
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
  const label = cleanText(ctx.body.get('label'), 40) || 'Passkey';
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
  added ? ctx.json({ ok: true }) : ctx.json({ error: 'That passkey could not be verified.' }, 400);
});

// A plain form, so removing a passkey works with JS off.
on('POST', '/profile/passkeys/delete', ctx => {
  // Only logged when a row actually went: a stale form for an already removed passkey is not an event.
  if (auth.deleteCredential(ctx.body.get('id') || '', ctx.user.id).changes) {
    logUser(ctx, 'passkey removed');
  }
  ctx.redirect('/profile?msg=passkey_removed');
});

// ---- administration ----
// Everything admin-only lives under /admin. The guard is here, not in the view, so a future
// admin tool only has to be added to this section to inherit it.

const requireAdmin = ctx => ctx.user.is_admin || ctx.fail(403, 'Admins only.');

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

// The whole connection log as a file. Streamed, since it only ever grows.
on('GET', '/admin/log', ctx => {
  if (!requireAdmin(ctx)) {
    return;
  }
  ctx.res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': 'attachment; filename="meshtime.log"',
    'Cache-Control': 'private, no-store',
  });
  if (ctx.req.method === 'HEAD' || !existsSync(LOG_PATH)) {
    return ctx.res.end(); // nothing logged yet: empty file
  }
  createReadStream(LOG_PATH).pipe(ctx.res);
});

on('POST', '/admin/invite', ctx => {
  if (!requireAdmin(ctx)) {
    return;
  }
  const userId = ctx.body.get('user_id') ? Number(ctx.body.get('user_id')) : null;
  const target = userId && get('SELECT name FROM users WHERE id = ?', userId);
  if (userId && !target) {
    return showAdmin(ctx, { status: 400, errors: { members: 'That member no longer exists.' } });
  }
  auth.createInvite({ createdBy: ctx.user.id, userId }); // userId set => password-reset link
  logUser(ctx, target ? `admin: reset link created for ${JSON.stringify(target.name)}` : 'admin: invite link created');
  ctx.redirect('/admin?msg=invite');
});

// Offboarding. ON DELETE CASCADE takes sessions, passkeys, votes, free days and reset links with the
// row, and the feed token dies with it. Events and polls they created stay, so they are re-owned first.
on('POST', '/admin/members/(?<id>\\d+)/delete', ctx => {
  if (!requireAdmin(ctx)) {
    return;
  }
  const memberId = Number(ctx.params.id);
  if (memberId === ctx.user.id) {
    return showAdmin(ctx, { status: 400, errors: { members: 'You cannot remove yourself.' } });
  }
  const member = get('SELECT name FROM users WHERE id = ?', memberId);
  if (!member) {
    return showAdmin(ctx, { status: 404, errors: { members: 'That member no longer exists.' } });
  }
  tx(() => {
    run('UPDATE events SET created_by = ? WHERE created_by = ?', ctx.user.id, memberId);
    run('UPDATE polls SET created_by = ? WHERE created_by = ?', ctx.user.id, memberId);
    run('DELETE FROM users WHERE id = ?', memberId);
  });
  logUser(ctx, `admin: member removed ${JSON.stringify(member.name)}`);
  ctx.redirect('/admin?msg=removed');
});

// ---- ICS feeds: the only unauthenticated data routes; the token in the URL is the credential ----
const ICS_HEADERS = { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, no-cache' };

on('GET', '/feed/(?<token>[\\w-]+)/events\\.ics', ctx => {
  if (!get('SELECT 1 FROM users WHERE feed_token = ?', ctx.params.token)) {
    return ctx.fail(404, 'Not found.');
  }
  const host = new URL(BASE_URL).host;

  const items = all('SELECT * FROM events').map(event => ({
    uid: 'event-' + event.id,
    date: event.date,
    endDate: event.end_date,
    startTime: event.start_time,
    endTime: event.end_time,
    summary: event.title,
    stamp: event.created_at,
  }));

  ctx.text(buildIcs({ name: 'Meshtime · Events', host, items }), 200, ICS_HEADERS);
}, true);

// One yearly recurring all-day event per member who gave a birthday, starting on the birthday itself.
on('GET', '/feed/(?<token>[\\w-]+)/birthdays\\.ics', ctx => {
  if (!get('SELECT 1 FROM users WHERE feed_token = ?', ctx.params.token)) {
    return ctx.fail(404, 'Not found.');
  }
  const items = all('SELECT id, name, birthday, created_at FROM users WHERE birthday IS NOT NULL').map(member => ({
    uid: 'birthday-' + member.id,
    date: member.birthday,
    rrule: birthdayRrule(member.birthday),
    summary: `🎉 ${member.name}'s birthday`,
    stamp: member.created_at,
  }));
  ctx.text(buildIcs({ name: 'Meshtime · Birthdays', host: new URL(BASE_URL).host, items }), 200, ICS_HEADERS);
}, true);
