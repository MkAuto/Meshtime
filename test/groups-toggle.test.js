import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The routes against a throwaway DB (each test file runs in its own process, so this one is all ours).
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'meshtime-')), 'app.db');
const { get, run, now } = await import('../src/db.js');
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
    text: (text, status = 200) => Object.assign(out, { status, html: text }),
    redirect: location => Object.assign(out, { status: 303, location }),
    fail: (status, html) => Object.assign(out, { status, html }),
  });
  return out;
}

test('groups off shows everything without touching the private flags; a form without the field changes nothing',
  async () => {
    const addUser = (name, isAdmin) => run(`INSERT INTO users(name, password_hash, feed_token, is_admin, created_at)
                                            VALUES (?, 'x', ?, ?, ?)`, name, 'tok-' + name, isAdmin, now()).lastInsertRowid;
    const ada = addUser('Ada', 1), bob = addUser('Bob', 0);
    const group = run(`INSERT INTO member_groups(name, created_at) VALUES ('Bob only', ?)`, now()).lastInsertRowid;
    run('INSERT INTO group_members(group_id, user_id, joined_at) VALUES (?, ?, ?)', group, bob, now());
    const event = run(`INSERT INTO events(title, date, end_date, created_by, created_at, is_private)
                       VALUES ('Secret plan', '2026-10-14', '2026-10-14', ?, ?, 1)`, bob, now()).lastInsertRowid;
    run('INSERT INTO event_groups(event_id, group_id) VALUES (?, ?)', event, group);

    const adaSees = async () => (await call(ada, 'GET', '/?m=2026-10&g=')).html.includes('Secret plan');
    const groupsOn = () => get('SELECT groups_enabled FROM app_settings').groups_enabled;
    const sharing = () => [get('SELECT is_private FROM events WHERE id = ?', event).is_private,
      get('SELECT COUNT(*) AS n FROM event_groups WHERE event_id = ?', event).n];

    assert.equal(await adaSees(), false);

    await call(ada, 'POST', '/admin/options', 'member_invites=1'); // an admin page from before the option
    assert.equal(groupsOn(), 1);

    await call(ada, 'POST', '/admin/options', 'groups_enabled=0');
    assert.equal(groupsOn(), 0);
    assert.equal(await adaSees(), true);
    // Bob edits it while there is no Who sees it on the form: it stays private to its group
    await call(bob, 'POST', `/events/${event}`, 'title=Secret plan&date=2026-10-15&all_day=1');
    assert.deepEqual(sharing(), [1, 1]);

    await call(ada, 'POST', '/admin/options', 'groups_enabled=0&groups_enabled=1');
    assert.equal(groupsOn(), 1);
    assert.equal(await adaSees(), false);
    assert.deepEqual(sharing(), [1, 1]);
  });
