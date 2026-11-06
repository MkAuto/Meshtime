import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The calendar's Custom view against a throwaway DB (each test file runs in its own process, so this one is all ours).
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'meshtime-')), 'app.db');
const { all, get, run, now } = await import('../src/db.js');
const auth = await import('../src/auth.js');
const { routes } = await import('../src/routes.js');

/** Runs one route as member `userId`, the way server.js would; returns { status, html, location }. */
async function call(userId, method, path, body) {
  const out = {};
  const url = new URL(path, 'http://x.test');
  const route = routes.find(r => r.method === method && r.path.test(url.pathname));
  await route.handler({
    ip: '127.0.0.1', url, params: url.pathname.match(route.path).groups || {},
    user: auth.userFromSession(auth.createSession(userId)),
    body: body === undefined ? undefined : new URLSearchParams(body),
    html: (html, status = 200) => Object.assign(out, { status, html }),
    redirect: location => Object.assign(out, { status: 303, location }),
    fail: (status, html) => Object.assign(out, { status, html }),
  });
  return out;
}

const addUser = (name, isPrivate) => run(`INSERT INTO users(name, password_hash, feed_token, is_private, created_at)
                                          VALUES (?, 'x', ?, ?, ?)`, name, 'tok-' + name, isPrivate, now()).lastInsertRowid;
const free = (userId, date) => run(`INSERT INTO free_days(user_id, date) VALUES (?, ?)`, userId, date);

test('Custom view: shows me and the people I ticked, keeps them for next time, and can be the default', async () => {
  const ada = addUser('Ada', 1), bob = addUser('Bob', 0), cy = addUser('Cy', 1), di = addUser('Di', 1);
  const group = run(`INSERT INTO member_groups(name, created_at) VALUES ('Climbers', ?)`, now()).lastInsertRowid;
  for (const member of [ada, di]) {
    run('INSERT INTO group_members(group_id, user_id, joined_at) VALUES (?, ?, ?)', group, member, now());
  }
  for (const member of [ada, bob, cy, di]) {
    free(member, '2026-10-14');
  }
  free(ada, '2026-10-15');
  free(bob, '2026-10-15');
  run(`INSERT INTO events(title, date, end_date, created_by, created_at) VALUES ('Di party', '2026-10-20', '2026-10-20', ?, ?)`,
    di, now());

  // Cy is private and shares no group with Ada: not hers to pick, and a forged id for them or for herself is dropped
  const saved = await call(ada, 'POST', '/calendar/custom', `m=2026-10&u=${bob}&u=${cy}&u=${ada}`);
  assert.equal(saved.location, '/?m=2026-10&g=custom');
  assert.deepEqual(all('SELECT member_id FROM custom_view_members WHERE user_id = ?', ada).map(row => row.member_id),
    [bob]);

  const page = (await call(ada, 'GET', '/?m=2026-10&g=custom')).html;
  const shown = name => new RegExp(`title="${name}, all day"`).test(page);
  assert.deepEqual(['Ada', 'Bob', 'Cy', 'Di'].map(shown), [true, true, false, false], 'me, and Bob I ticked');
  assert.match(page, new RegExp(`name="u" value="${bob}" checked>`));
  assert.match(page, new RegExp(`name="u" value="${di}">`), 'Di shares a group with me: mine to tick');
  assert.doesNotMatch(page, new RegExp(`name="u" value="(${cy}|${ada})"`));
  assert.match(page, /<div class="day all[^"]*">\s*<form[^>]*>\s*<input [^>]*value="2026-10-15"/,
    'everyone shown free that day: Ada and Bob');
  assert.doesNotMatch(page, /Di party/, "the events of people not in it are not either");

  // Unticking everyone leaves only me
  await call(ada, 'POST', '/calendar/custom', 'm=2026-10');
  assert.equal(get('SELECT COUNT(*) AS n FROM custom_view_members WHERE user_id = ?', ada).n, 0);

  await call(ada, 'POST', '/calendar/custom', `m=2026-10&u=${di}`);
  const made = await call(ada, 'POST', '/calendar/default', 'm=2026-10&g=custom');
  assert.equal(made.location, '/?m=2026-10&g=custom');
  const opened = (await call(ada, 'GET', '/?m=2026-10')).html;
  assert.match(opened, /<option value="custom" selected>/, 'a page with no g opens on it');
  assert.match(opened, /Di party/);

  await call(ada, 'POST', '/calendar/default', `m=2026-10&g=${group}`);
  assert.deepEqual({ ...get('SELECT default_group_id, default_custom FROM users WHERE id = ?', ada) },
    { default_group_id: Number(group), default_custom: 0 });
});
