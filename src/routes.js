import { all, get, run, now, tx } from './db.js';
import * as auth from './auth.js';
import * as v from './views.js';
import { isValidDate, isValidMonth, bestDates, buildIcs, today, randomColor, COLORS, MAX_DATES, BASE_URL } from './lib.js';

export const routes = [];
const on = (method, path, handler, pub = false) => routes.push({ method, path: new RegExp(`^${path}$`), handler, public: pub });
const clean = (s, max) => (s ?? '').toString().trim().slice(0, max);
const backMonth = ctx => '/?m=' + (isValidMonth(ctx.body.get('m')) ? ctx.body.get('m') : today().slice(0, 7));
const login = (ctx, userId) => { ctx.setCookie('sid', auth.createSession(userId), auth.SESSION_SECONDS); ctx.redirect('/'); };

// ---- auth ----
on('GET', '/login', ctx => ctx.user ? ctx.redirect('/') : ctx.html(v.loginPage()), true);
on('POST', '/login', async ctx => {
  if (!auth.loginAllowed()) return ctx.html(v.loginPage('Too many attempts. Try again in 15 minutes.'), 429);
  const user = get('SELECT * FROM users WHERE name = ?', clean(ctx.body.get('name'), 40));
  const ok = await auth.verifyPassword(ctx.body.get('password') || '', user?.password_hash ?? auth.DUMMY_HASH);
  if (!user || !ok) { auth.loginFailed(); return ctx.html(v.loginPage('Wrong name or password.'), 401); }
  login(ctx, user.id);
}, true);
on('POST', '/logout', ctx => { if (ctx.sid) auth.deleteSession(ctx.sid); ctx.setCookie('sid', '', 0); ctx.redirect('/login'); }, true);

on('GET', '/invite/(?<token>[\\w-]+)', ctx => {
  const inv = auth.getInvite(ctx.params.token);
  if (!inv) return ctx.fail(410, 'This link is invalid, used, or expired.');
  ctx.html(v.invitePage(inv.token, inv.user_name));
}, true);
on('POST', '/invite/(?<token>[\\w-]+)', async ctx => {
  const inv = auth.getInvite(ctx.params.token);
  if (!inv) return ctx.fail(410, 'This link is invalid, used, or expired.');
  const password = ctx.body.get('password') || '';
  const name = clean(ctx.body.get('name'), 40);
  const bad = msg => ctx.html(v.invitePage(inv.token, inv.user_name, msg), 400);
  if (password.length < 8) return bad('Password must be at least 8 characters.');
  if (!inv.user_id && !name) return bad('Name is required.');
  if (!inv.user_id && get('SELECT 1 FROM users WHERE name = ?', name)) return bad('That name is already taken.');
  const hash = await auth.hashPassword(password);
  const userId = tx(() => {
    if (!auth.consumeInvite(inv.token)) throw Object.assign(new Error('invite gone'), { status: 410 });
    if (inv.user_id) {
      run('UPDATE users SET password_hash = ? WHERE id = ?', hash, inv.user_id);
      auth.deleteUserSessions(inv.user_id);
      return inv.user_id;
    }
    return run('INSERT INTO users(name, password_hash, feed_token, is_admin, created_at, color) VALUES (?,?,?,?,?,?)',
      name, hash, auth.token(), inv.is_admin, now(), randomColor()).lastInsertRowid;
  });
  login(ctx, userId);
}, true);

// ---- calendar ----
on('GET', '/', ctx => {
  const m = ctx.url.searchParams.get('m');
  const ym = isValidMonth(m) ? m : today().slice(0, 7);
  const free = new Map();
  for (const r of all('SELECT f.date, u.name, u.color FROM free_days f JOIN users u ON u.id = f.user_id WHERE f.date LIKE ? ORDER BY u.name', ym + '-%')) {
    if (!free.has(r.date)) free.set(r.date, []);
    free.get(r.date).push({ name: r.name, color: r.color });
  }
  const mine = new Set(all('SELECT date FROM free_days WHERE user_id = ? AND date LIKE ?', ctx.user.id, ym + '-%').map(r => r.date));
  const events = all('SELECT e.*, u.name AS creator FROM events e JOIN users u ON u.id = e.created_by WHERE e.date LIKE ? ORDER BY e.date, e.id', ym + '-%');
  ctx.html(v.calendarPage(ctx.user, ym, { free, mine, events, today: today(), members: get('SELECT COUNT(*) AS n FROM users').n }));
});
on('POST', '/free', ctx => {
  const date = ctx.body.get('date');
  if (!isValidDate(date)) return ctx.fail(400, 'Invalid date.');
  if (run('DELETE FROM free_days WHERE user_id = ? AND date = ?', ctx.user.id, date).changes === 0)
    run('INSERT INTO free_days(user_id, date) VALUES (?,?)', ctx.user.id, date);
  ctx.redirect(backMonth(ctx));
});
on('POST', '/events', ctx => {
  const title = clean(ctx.body.get('title'), 100), date = ctx.body.get('date');
  if (!title || !isValidDate(date)) return ctx.fail(400, 'A title and a valid date are required.');
  run('INSERT INTO events(title, date, created_by, created_at) VALUES (?,?,?,?)', title, date, ctx.user.id, now());
  ctx.redirect('/?m=' + date.slice(0, 7));
});
on('POST', '/events/(?<id>\\d+)/delete', ctx => {
  run('DELETE FROM events WHERE id = ? AND (created_by = ? OR ? = 1)', Number(ctx.params.id), ctx.user.id, ctx.user.is_admin);
  ctx.redirect(backMonth(ctx));
});

// ---- polls ----
function loadPoll(id) {
  const poll = get('SELECT * FROM polls WHERE id = ?', id);
  if (!poll) return null;
  const dates = all('SELECT date FROM poll_dates WHERE poll_id = ? ORDER BY date', id).map(r => r.date);
  const members = all('SELECT id, name FROM users ORDER BY name');
  const votes = all('SELECT date, user_id, answer FROM poll_votes WHERE poll_id = ?', id);
  const answered = {};
  for (const x of votes) (answered[x.user_id] ??= new Set()).add(x.date);
  const missing = members.filter(m => (answered[m.id]?.size ?? 0) < dates.length).map(m => m.name);
  return { poll, dates, members, votes, missing, complete: missing.length === 0,
    best: poll.chosen_date ? [poll.chosen_date] : bestDates(dates, votes), event: get('SELECT * FROM events WHERE poll_id = ?', id) };
}
on('GET', '/polls', ctx => ctx.html(v.pollsPage(ctx.user, all(`SELECT p.*,
  (SELECT COUNT(*) FROM users u WHERE NOT EXISTS (SELECT 1 FROM poll_dates d WHERE d.poll_id = p.id
     AND NOT EXISTS (SELECT 1 FROM poll_votes pv WHERE pv.poll_id = p.id AND pv.date = d.date AND pv.user_id = u.id))) AS voters,
  (SELECT COUNT(*) FROM users) AS members
  FROM polls p ORDER BY p.closed_at IS NOT NULL, p.created_at DESC`))));
on('GET', '/polls/new', ctx => ctx.html(v.newPollPage(ctx.user)));
on('POST', '/polls/new', ctx => {
  const title = clean(ctx.body.get('title'), 100);
  const dates = [...new Set(ctx.body.getAll('dates').filter(Boolean))].sort();
  if (!title || !dates.length || dates.length > MAX_DATES || !dates.every(isValidDate))
    return ctx.html(v.newPollPage(ctx.user, `A title and 1 to ${MAX_DATES} valid dates are required.`), 400);
  const id = tx(() => {
    const id = run('INSERT INTO polls(title, created_by, created_at) VALUES (?,?,?)', title, ctx.user.id, now()).lastInsertRowid;
    for (const d of dates) run('INSERT INTO poll_dates(poll_id, date) VALUES (?,?)', id, d);
    return id;
  });
  ctx.redirect('/polls/' + id);
});
on('GET', '/polls/(?<id>\\d+)', ctx => {
  const p = loadPoll(Number(ctx.params.id));
  p ? ctx.html(v.pollPage(ctx.user, p)) : ctx.fail(404, 'Poll not found.');
});
on('POST', '/polls/(?<id>\\d+)', ctx => {
  const id = Number(ctx.params.id), p = loadPoll(id);
  if (!p) return ctx.fail(404, 'Poll not found.');
  if (p.poll.closed_at) return ctx.fail(409, 'This poll is closed.');
  tx(() => {
    for (const d of p.dates) {
      const a = ctx.body.get('v_' + d);
      if (['yes', 'maybe', 'no'].includes(a))
        run('INSERT INTO poll_votes(poll_id, date, user_id, answer) VALUES (?,?,?,?) ON CONFLICT DO UPDATE SET answer = excluded.answer', id, d, ctx.user.id, a);
    }
  });
  ctx.redirect('/polls/' + id);
});
on('POST', '/polls/(?<id>\\d+)/close', ctx => {
  const id = Number(ctx.params.id);
  run('UPDATE polls SET closed_at = ? WHERE id = ? AND closed_at IS NULL AND (created_by = ? OR ? = 1)', now(), id, ctx.user.id, ctx.user.is_admin);
  ctx.redirect('/polls/' + id);
});
on('POST', '/polls/(?<id>\\d+)/confirm', ctx => {
  const id = Number(ctx.params.id), p = loadPoll(id), date = ctx.body.get('date');
  if (!p) return ctx.fail(404, 'Poll not found.');
  if (!p.dates.includes(date)) return ctx.fail(400, 'Not one of the proposed dates.');
  if (!p.complete && !p.poll.closed_at) return ctx.fail(409, 'Not everyone has answered yet.');
  if (!p.event) tx(() => { // idempotent: events.poll_id is UNIQUE
    run('INSERT INTO events(title, date, created_by, poll_id, created_at) VALUES (?,?,?,?,?)', p.poll.title, date, ctx.user.id, id, now());
    run('UPDATE polls SET chosen_date = ?, closed_at = COALESCE(closed_at, ?) WHERE id = ?', date, now(), id);
  });
  ctx.redirect('/polls/' + id);
});

// ---- settings ----
const settingsData = (ctx, extra = {}) => ({
  base: BASE_URL, msg: ctx.url.searchParams.get('msg'),
  invites: ctx.user.is_admin ? auth.openInvites() : [],
  members: ctx.user.is_admin ? all('SELECT id, name, is_admin FROM users ORDER BY name') : [],
  ...extra,
});
on('GET', '/settings', ctx => ctx.html(v.settingsPage(ctx.user, settingsData(ctx))));
on('POST', '/settings/rotate-feed', ctx => {
  run('UPDATE users SET feed_token = ? WHERE id = ?', auth.token(), ctx.user.id);
  ctx.redirect('/settings?msg=rotated');
});
on('POST', '/settings/color', ctx => {
  const c = Number(ctx.body.get('color'));
  if (!Number.isInteger(c) || c < 0 || c >= COLORS) return ctx.fail(400, 'Invalid color.');
  run('UPDATE users SET color = ? WHERE id = ?', c, ctx.user.id);
  ctx.redirect('/settings?msg=color');
});
on('POST', '/settings/password', async ctx => {
  const pw = ctx.body.get('password') || '';
  const bad = error => ctx.html(v.settingsPage(ctx.user, settingsData(ctx, { error })), 400);
  if (!(await auth.verifyPassword(ctx.body.get('current') || '', ctx.user.password_hash))) return bad('Current password is wrong.');
  if (pw.length < 8) return bad('New password must be at least 8 characters.');
  run('UPDATE users SET password_hash = ? WHERE id = ?', await auth.hashPassword(pw), ctx.user.id);
  auth.deleteUserSessions(ctx.user.id);
  ctx.setCookie('sid', auth.createSession(ctx.user.id), auth.SESSION_SECONDS);
  ctx.redirect('/settings?msg=password');
});
on('POST', '/settings/invite', ctx => {
  if (!ctx.user.is_admin) return ctx.fail(403, 'Admins only.');
  const userId = ctx.body.get('user_id') ? Number(ctx.body.get('user_id')) : null;
  if (userId && !get('SELECT 1 FROM users WHERE id = ?', userId)) return ctx.fail(400, 'Unknown user.');
  auth.createInvite({ createdBy: ctx.user.id, userId });
  ctx.redirect('/settings?msg=invite');
});

// ---- ICS feeds: the only unauthenticated data routes; the token is the credential ----
on('GET', '/feed/(?<token>[\\w-]+)/(?<kind>events|free)\\.ics', ctx => {
  if (!get('SELECT 1 FROM users WHERE feed_token = ?', ctx.params.token)) return ctx.fail(404, 'Not found.');
  const host = new URL(BASE_URL).host;
  const events = ctx.params.kind === 'events';
  const items = events
    ? all('SELECT * FROM events').map(e => ({ uid: 'event-' + e.id, date: e.date, summary: e.title, stamp: e.created_at }))
    : all('SELECT f.user_id, f.date, u.name FROM free_days f JOIN users u ON u.id = f.user_id')
      .map(f => ({ uid: `free-${f.user_id}-${f.date}`, date: f.date, summary: `${f.name} is free`, stamp: f.date + 'T00:00:00Z', transparent: true }));
  ctx.text(buildIcs({ name: events ? 'Meshtime · Events' : 'Meshtime · Who is free', host, items }), 200,
    { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, no-cache' });
}, true);
