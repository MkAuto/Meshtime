import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The Rules route against a throwaway DB (each test file runs in its own process, so this one is all ours).
// No calendar_links row, so syncUser returns at once: nothing is fetched.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'meshtime-')), 'app.db');
const { get, run, now } = await import('../src/db.js');
const auth = await import('../src/auth.js');
const { routes } = await import('../src/routes.js');

/** POSTs one form to the Rules route as member `userId`, the way server.js would; returns { status, location }. */
async function postRules(userId, body) {
  const out = {};
  const url = new URL('/settings/calendars/rules', 'http://x.test');
  const route = routes.find(r => r.method === 'POST' && r.path.test(url.pathname));
  await route.handler({
    ip: '127.0.0.1', url, params: {}, user: auth.userFromSession(auth.createSession(userId)),
    body: new URLSearchParams(body),
    html: (html, status = 200) => Object.assign(out, { status, html }),
    redirect: location => Object.assign(out, { status: 303, location }),
    fail: (status, html) => Object.assign(out, { status, html }),
  });
  return out;
}

test('Rules: saved tidied up, forged slots dropped, an unknown threshold refused without saving anything', async () => {
  const ada = run(`INSERT INTO users(name, password_hash, feed_token, created_at) VALUES ('Ada', 'x', 'tok', ?)`,
    now()).lastInsertRowid;
  const rules = () => get('SELECT busy_minutes, busy_slots, ignore_words FROM users WHERE id = ?', ada);
  assert.deepEqual({ ...rules() }, { busy_minutes: 120, busy_slots: '', ignore_words: '' }, 'defaults');

  const saved = await postRules(ada, [['busy_minutes', '60'], ['ignore_words', ' Gym,, lunch ,'],
    ['busy', '1pm'], ['busy', '1am'], ['busy', '1am'], ['busy', '7am'], ['busy', '1night']]);
  assert.equal(saved.location, '/settings?msg=calendar_rules');
  assert.deepEqual({ ...rules() }, { busy_minutes: 60, busy_slots: '1am 1pm', ignore_words: 'Gym, lunch' });

  // the form (and its error) only shows once a calendar is connected; a refused form returns before any sync
  run(`INSERT INTO calendar_links(user_id, url, created_at) VALUES (?, 'https://x.test/a.ics', ?)`, ada, now());
  const refused = await postRules(ada, [['busy_minutes', '90'], ['ignore_words', 'x']]);
  assert.equal(refused.status, 400);
  assert.match(refused.html, /Invalid busy threshold\./);
  assert.equal(rules().ignore_words, 'Gym, lunch', 'nothing saved');
});
