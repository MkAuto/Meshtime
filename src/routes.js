import { all, get, run, now, tx } from './db.js';
import * as auth from './auth.js';
import * as views from './views.js';
import { isValidDate, isValidMonth, bestDates, buildIcs, today, randomColor, ANSWERS, COLORS, MAX_DATES, MIN_PASSWORD, BASE_URL, RP_ID } from './lib.js';

export const routes = [];

// Registers a route. `path` is regex source anchored to the whole pathname, so named groups
// like (?<id>\d+) arrive as ctx.params.id. Public routes skip the login check in server.js.
const on = (method, path, handler, isPublic = false) =>
  routes.push({ method, path: new RegExp(`^${path}$`), handler, public: isPublic });

/** Form values are untrusted: trim and cap the length before anything else touches them. */
const cleanText = (value, maxLength) => (value ?? '').toString().trim().slice(0, maxLength);

/** Calendar forms post the month they were rendered for, so a redirect lands back on it. */
const backToMonth = ctx => {
  const month = ctx.body.get('m');
  return '/?m=' + (isValidMonth(month) ? month : today().slice(0, 7));
};

const startSession = (ctx, userId) => {
  ctx.setCookie('sid', auth.createSession(userId), auth.SESSION_SECONDS);
  ctx.redirect('/');
};

// ---- auth ----
on('GET', '/login', ctx => ctx.user ? ctx.redirect('/') : ctx.html(views.loginPage()), true);

on('POST', '/login', async ctx => {
  if (!auth.loginAllowed()) return ctx.html(views.loginPage('Too many attempts. Try again in 15 minutes.'), 429);
  const user = get('SELECT * FROM users WHERE name = ?', cleanText(ctx.body.get('name'), 40));
  // Hash even for an unknown name, so the response time does not reveal which names exist.
  const passwordOk = await auth.verifyPassword(ctx.body.get('password') || '', user?.password_hash ?? auth.DUMMY_HASH);
  if (!user || !passwordOk) {
    auth.loginFailed();
    return ctx.html(views.loginPage('Wrong name or password.'), 401);
  }
  startSession(ctx, user.id);
}, true);

on('POST', '/logout', ctx => {
  if (ctx.sid) auth.deleteSession(ctx.sid);
  ctx.setCookie('sid', '', 0);
  ctx.redirect('/login');
}, true);

// ---- passkeys ----
// Two requests each way: fetch a challenge, then post what the authenticator signed over it.
// public/app.js posts these form-encoded like every other form, so server.js needs no special case.

const TOO_MANY = 'Too many attempts. Try again in 15 minutes.';

on('POST', '/login/passkey/options', ctx => auth.loginAllowed()
  ? ctx.json({ challenge: auth.createChallenge(), rpId: RP_ID })
  : ctx.json({ error: TOO_MANY }, 429), true);

on('POST', '/login/passkey', ctx => {
  if (!auth.loginAllowed()) return ctx.json({ error: TOO_MANY }, 429);
  const challenge = ctx.body.get('challenge') || '';

  // Spend the challenge first: a replayed body dies here even if its signature is still perfectly good.
  const user = auth.consumeChallenge(challenge) && auth.credentialUser({
    id: ctx.body.get('id') || '',
    clientDataJSON: ctx.body.get('clientDataJSON') || '',
    authenticatorData: ctx.body.get('authenticatorData') || '',
    signature: ctx.body.get('signature') || '',
    challenge,
  });

  if (!user) {
    auth.loginFailed(); // passkey attempts share the password login's rate limit
    return ctx.json({ error: 'That passkey is not recognised.' }, 401);
  }
  ctx.setCookie('sid', auth.createSession(user.id), auth.SESSION_SECONDS);
  ctx.json({ ok: true }); // the client navigates; a 303 here would make fetch load the page for nothing
}, true);

const INVITE_GONE = 'This link is invalid, used, or expired.';

on('GET', '/invite/(?<token>[\\w-]+)', ctx => {
  const invite = auth.getInvite(ctx.params.token);
  if (!invite) return ctx.fail(410, INVITE_GONE);
  ctx.html(views.invitePage(invite.token, invite.user_name));
}, true);

// One form, two jobs: with invite.user_id it resets that user's password, otherwise it creates an account.
on('POST', '/invite/(?<token>[\\w-]+)', async ctx => {
  const invite = auth.getInvite(ctx.params.token);
  if (!invite) return ctx.fail(410, INVITE_GONE);

  const password = ctx.body.get('password') || '';
  const name = cleanText(ctx.body.get('name'), 40);
  const isReset = Boolean(invite.user_id);
  const reject = msg => ctx.html(views.invitePage(invite.token, invite.user_name, msg), 400);

  if (password.length < MIN_PASSWORD) return reject(`Password must be at least ${MIN_PASSWORD} characters.`);
  if (!isReset && !name) return reject('Name is required.');
  if (!isReset && get('SELECT 1 FROM users WHERE name = ?', name)) return reject('That name is already taken.');

  const passwordHash = await auth.hashPassword(password);
  const userId = tx(() => {
    // Consumed inside the transaction: two submissions of the same link cannot both succeed.
    if (!auth.consumeInvite(invite.token)) throw Object.assign(new Error('invite gone'), { status: 410 });
    if (isReset) {
      run('UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, invite.user_id);
      auth.deleteUserSessions(invite.user_id); // whoever knew the old password is logged out
      return invite.user_id;
    }
    return run(`INSERT INTO users(name, password_hash, feed_token, is_admin, created_at, color)
                VALUES (?,?,?,?,?,?)`,
      name, passwordHash, auth.token(), invite.is_admin, now(), randomColor()).lastInsertRowid;
  });
  startSession(ctx, userId);
}, true);

// ---- calendar ----
on('GET', '/', ctx => {
  const requestedMonth = ctx.url.searchParams.get('m');
  const yearMonth = isValidMonth(requestedMonth) ? requestedMonth : today().slice(0, 7);
  const inMonth = yearMonth + '-%'; // dates are 'YYYY-MM-DD' strings, so LIKE is enough

  // date -> everyone who marked themselves free that day, for the initials in each cell
  const free = new Map();
  for (const row of all(`SELECT f.date, u.name, u.color FROM free_days f
                         JOIN users u ON u.id = f.user_id
                         WHERE f.date LIKE ? ORDER BY u.name`, inMonth)) {
    if (!free.has(row.date)) free.set(row.date, []);
    free.get(row.date).push({ name: row.name, color: row.color });
  }

  const mine = new Set(all('SELECT date FROM free_days WHERE user_id = ? AND date LIKE ?', ctx.user.id, inMonth)
    .map(row => row.date));
  const events = all(`SELECT e.*, u.name AS creator FROM events e
                      JOIN users u ON u.id = e.created_by
                      WHERE e.date LIKE ? ORDER BY e.date, e.id`, inMonth);
  const members = get('SELECT COUNT(*) AS n FROM users').n; // a day is "everyone free" at this count

  ctx.html(views.calendarPage(ctx.user, yearMonth, { free, mine, events, today: today(), members }));
});

// Clicking a day toggles it: try the delete first, insert only if there was nothing to delete.
on('POST', '/free', ctx => {
  const date = ctx.body.get('date');
  if (!isValidDate(date)) return ctx.fail(400, 'Invalid date.');
  const removed = run('DELETE FROM free_days WHERE user_id = ? AND date = ?', ctx.user.id, date).changes;
  if (removed === 0) run('INSERT INTO free_days(user_id, date) VALUES (?,?)', ctx.user.id, date);
  ctx.redirect(backToMonth(ctx));
});

on('POST', '/events', ctx => {
  const title = cleanText(ctx.body.get('title'), 100);
  const date = ctx.body.get('date');
  if (!title || !isValidDate(date)) return ctx.fail(400, 'A title and a valid date are required.');
  run('INSERT INTO events(title, date, created_by, created_at) VALUES (?,?,?,?)', title, date, ctx.user.id, now());
  ctx.redirect('/?m=' + date.slice(0, 7));
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
  if (!poll) return null;

  const dates = all('SELECT date FROM poll_dates WHERE poll_id = ? ORDER BY date', pollId).map(row => row.date);
  const members = all('SELECT id, name FROM users ORDER BY name');
  const votes = all('SELECT date, user_id, answer FROM poll_votes WHERE poll_id = ?', pollId);

  // A member has finished only once they answered every proposed date.
  const datesAnsweredBy = {}; // user_id -> Set of dates
  for (const vote of votes) (datesAnsweredBy[vote.user_id] ??= new Set()).add(vote.date);
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
  if (!title || !dates.length || dates.length > MAX_DATES || !dates.every(isValidDate))
    return ctx.html(views.newPollPage(ctx.user, `A title and 1 to ${MAX_DATES} valid dates are required.`), 400);

  const pollId = tx(() => {
    const id = run('INSERT INTO polls(title, created_by, created_at) VALUES (?,?,?)',
      title, ctx.user.id, now()).lastInsertRowid;
    for (const date of dates) run('INSERT INTO poll_dates(poll_id, date) VALUES (?,?)', id, date);
    return id;
  });
  ctx.redirect('/polls/' + pollId);
});

on('GET', '/polls/(?<id>\\d+)', ctx => {
  const data = loadPoll(Number(ctx.params.id));
  if (!data) return ctx.fail(404, 'Poll not found.');
  ctx.html(views.pollPage(ctx.user, data));
});

// Saving answers replaces this user's previous ones. Dates left on "—" stay unanswered.
on('POST', '/polls/(?<id>\\d+)', ctx => {
  const pollId = Number(ctx.params.id);
  const data = loadPoll(pollId);
  if (!data) return ctx.fail(404, 'Poll not found.');
  if (data.poll.closed_at) return ctx.fail(409, 'This poll is closed.');

  tx(() => {
    for (const date of data.dates) {
      const answer = ctx.body.get('v_' + date);
      if (!ANSWERS.includes(answer)) continue;
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
  if (!data) return ctx.fail(404, 'Poll not found.');
  if (!data.dates.includes(date)) return ctx.fail(400, 'Not one of the proposed dates.');
  if (!data.complete && !data.poll.closed_at) return ctx.fail(409, 'Not everyone has answered yet.');

  if (!data.event) tx(() => { // idempotent: events.poll_id is UNIQUE, so a double click adds nothing
    run('INSERT INTO events(title, date, created_by, poll_id, created_at) VALUES (?,?,?,?,?)',
      data.poll.title, date, ctx.user.id, pollId, now());
    run('UPDATE polls SET chosen_date = ?, closed_at = COALESCE(closed_at, ?) WHERE id = ?', date, now(), pollId);
  });
  ctx.redirect('/polls/' + pollId);
});

// ---- settings ----

const settingsData = (ctx, extra = {}) => ({
  base: BASE_URL,
  msg: ctx.url.searchParams.get('msg'),
  passkeys: auth.userCredentials(ctx.user.id),
  ...extra,
});

on('GET', '/settings', ctx => ctx.html(views.settingsPage(ctx.user, settingsData(ctx))));

on('POST', '/settings/rotate-feed', ctx => {
  run('UPDATE users SET feed_token = ? WHERE id = ?', auth.token(), ctx.user.id);
  ctx.redirect('/settings?msg=rotated');
});

on('POST', '/settings/color', ctx => {
  const color = Number(ctx.body.get('color'));
  if (!Number.isInteger(color) || color < 0 || color >= COLORS) return ctx.fail(400, 'Invalid color.');
  run('UPDATE users SET color = ? WHERE id = ?', color, ctx.user.id);
  ctx.redirect('/settings?msg=color');
});

on('POST', '/settings/password', async ctx => {
  const newPassword = ctx.body.get('password') || '';
  const reject = error => ctx.html(views.settingsPage(ctx.user, settingsData(ctx, { error })), 400);
  if (!(await auth.verifyPassword(ctx.body.get('current') || '', ctx.user.password_hash)))
    return reject('Current password is wrong.');
  if (newPassword.length < MIN_PASSWORD) return reject(`New password must be at least ${MIN_PASSWORD} characters.`);

  run('UPDATE users SET password_hash = ? WHERE id = ?', await auth.hashPassword(newPassword), ctx.user.id);
  // Log every device out, then hand this browser a fresh session so the user stays put.
  auth.deleteUserSessions(ctx.user.id);
  ctx.setCookie('sid', auth.createSession(ctx.user.id), auth.SESSION_SECONDS);
  ctx.redirect('/settings?msg=password');
});

// The user handle for the discoverable credential is the numeric user id: opaque, stable, no PII.
// excludeCredentials stops one authenticator from registering itself against the same account twice.
on('POST', '/settings/passkeys/options', ctx => ctx.json({
  challenge: auth.createChallenge(),
  rpId: RP_ID,
  userId: String(ctx.user.id),
  name: ctx.user.name,
  exclude: auth.userCredentials(ctx.user.id).map(credential => credential.id),
}));

on('POST', '/settings/passkeys', ctx => {
  const challenge = ctx.body.get('challenge') || '';
  const added = auth.consumeChallenge(challenge) && auth.addCredential({
    userId: ctx.user.id,
    id: ctx.body.get('id') || '',
    publicKey: ctx.body.get('publicKey') || '',
    alg: Number(ctx.body.get('alg')),
    label: cleanText(ctx.body.get('label'), 40) || 'Passkey',
    clientDataJSON: ctx.body.get('clientDataJSON') || '',
    authenticatorData: ctx.body.get('authenticatorData') || '',
    challenge,
  });
  added ? ctx.json({ ok: true }) : ctx.json({ error: 'That passkey could not be verified.' }, 400);
});

// A plain form, so removing a passkey works with JS off.
on('POST', '/settings/passkeys/delete', ctx => {
  auth.deleteCredential(ctx.body.get('id') || '', ctx.user.id);
  ctx.redirect('/settings?msg=passkey_removed');
});

// ---- administration ----
// Everything admin-only lives under /admin. The guard is here, not in the view, so a future
// admin tool only has to be added to this section to inherit it.

const requireAdmin = ctx => ctx.user.is_admin || ctx.fail(403, 'Admins only.');

on('GET', '/admin', ctx => requireAdmin(ctx) && ctx.html(views.adminPage(ctx.user, {
  base: BASE_URL,
  msg: ctx.url.searchParams.get('msg'),
  invites: auth.openInvites(),
  members: all('SELECT id, name, is_admin FROM users ORDER BY name'),
})));

on('POST', '/admin/invite', ctx => {
  if (!requireAdmin(ctx)) return;
  const userId = ctx.body.get('user_id') ? Number(ctx.body.get('user_id')) : null;
  if (userId && !get('SELECT 1 FROM users WHERE id = ?', userId)) return ctx.fail(400, 'Unknown user.');
  auth.createInvite({ createdBy: ctx.user.id, userId }); // userId set => password-reset link
  ctx.redirect('/admin?msg=invite');
});

// ---- ICS feeds: the only unauthenticated data routes; the token in the URL is the credential ----
on('GET', '/feed/(?<token>[\\w-]+)/(?<kind>events|free)\\.ics', ctx => {
  if (!get('SELECT 1 FROM users WHERE feed_token = ?', ctx.params.token)) return ctx.fail(404, 'Not found.');
  const host = new URL(BASE_URL).host;
  const wantsEvents = ctx.params.kind === 'events';

  const items = wantsEvents
    ? all('SELECT * FROM events').map(event => ({
      uid: 'event-' + event.id,
      date: event.date,
      summary: event.title,
      stamp: event.created_at,
    }))
    : all('SELECT f.user_id, f.date, u.name FROM free_days f JOIN users u ON u.id = f.user_id').map(freeDay => ({
      uid: `free-${freeDay.user_id}-${freeDay.date}`,
      date: freeDay.date,
      summary: `${freeDay.name} is free`,
      stamp: freeDay.date + 'T00:00:00Z',
      transparent: true, // "who is free" should not block time in the subscriber's calendar
    }));

  ctx.text(buildIcs({ name: wantsEvents ? 'Meshtime · Events' : 'Meshtime · Who is free', host, items }), 200,
    { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, no-cache' });
}, true);
