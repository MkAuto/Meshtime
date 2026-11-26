import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// AI access: tokens made in Settings, and what an assistant does with one through /mcp and /api/... (src/api.js).
// Against a throwaway DB, this file's process alone.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'meshtime-')), 'app.db');
const { get, all, run, now } = await import('../src/db.js');
const auth = await import('../src/auth.js');
const { routes } = await import('../src/routes.js');
const { handleApi } = await import('../src/api.js');
const { cleanParts, today } = await import('../src/lib.js');

const addUser = (name, isAdmin = 0) => run(`INSERT INTO users(name, password_hash, feed_token, created_at, is_admin)
  VALUES (?, 'x', ?, ?, ?)`, name, 'tok-' + name, now(), isAdmin).lastInsertRowid;

const [ana, dee, root] = [addUser('Ana'), addUser('Dee'), addUser('Root', 1)];
const anaToken = auth.createApiToken(ana, 'Claude');
const rootToken = auth.createApiToken(root, 'Admin bot');

/** One request the way server.js hands it over; answers { status, headers, body } with body parsed. */
function api(method, path, { token, body, headers = {} } = {}) {
  const answer = handleApi({
    method, url: new URL(path, 'http://x.test'), ip: '127.0.0.1', body: body === undefined ? '' : JSON.stringify(body),
    headers: { host: 'x.test', 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }),
      ...headers },
  });
  return { ...answer, body: answer.body ? JSON.parse(answer.body) : undefined };
}

let rpcId = 0;
const rpc = (token, method, params) =>
  api('POST', '/mcp', { token, body: { jsonrpc: '2.0', id: ++rpcId, method, params } }).body;
/** A tools/call: the tool's JSON answer, or { refused: its message } when it said no. */
function callTool(token, name, args) {
  const { result } = rpc(token, 'tools/call', { name, arguments: args });
  return result.isError ? { refused: result.content[0].text } : JSON.parse(result.content[0].text);
}

const freeDays = userId => all('SELECT date, part, part2 FROM free_days WHERE user_id = ? ORDER BY date', userId)
  .map(row => [row.date, row.part, row.part2].filter(Boolean).join(' '));
const isManual = (userId, date) => Boolean(get('SELECT 1 FROM manual_days WHERE user_id = ? AND date = ?', userId, date));

/** Runs one route the way server.js would, as member `userId`; returns what it answered. */
async function request(method, path, userId, body = []) {
  const out = {};
  const url = new URL(path, 'http://x.test');
  const route = routes.find(r => r.method === method && r.path.test(url.pathname));
  await route.handler({
    ip: '127.0.0.1', url, params: url.pathname.match(route.path).groups || {}, lang: 'en', cookies: {},
    req: { headers: {} }, setCookie: () => {},
    user: userId ? auth.userFromSession(auth.createSession(userId)) : null, body: new URLSearchParams(body),
    html: (html, status = 200) => Object.assign(out, { status, html }),
    redirect: location => Object.assign(out, { status: 303, location }),
    fail: (status, message) => Object.assign(out, { status, message }),
  });
  return out;
}

test('cleanParts: all alone, up to two slots in day order, [] to clear', () => {
  assert.deepEqual(cleanParts(['eve', 'am', 'eve']), ['am', 'eve']);
  assert.deepEqual(cleanParts(['all']), ['all']);
  assert.deepEqual(cleanParts([]), []);
  assert.equal(cleanParts(['all', 'am']), null);
  assert.equal(cleanParts(['am', 'pm', 'eve']), null);
  assert.equal(cleanParts(['noon']), null);
  assert.equal(cleanParts('all'), null);
});

test('no token, a wrong one or one turned off: 401, and nothing is read', () => {
  for (const token of [undefined, 'mt_nope', anaToken.slice(3)]) {
    const answer = api('GET', '/api/me', { token });
    assert.equal(answer.status, 401);
    assert.match(answer.headers['WWW-Authenticate'], /^Bearer/);
  }
  const spare = auth.createApiToken(dee, 'spare');
  assert.equal(api('GET', '/api/me', { token: spare }).status, 200);
  const { id } = get('SELECT id FROM api_tokens WHERE label = ?', 'spare');
  assert.equal(auth.deleteApiToken(ana, id), false, 'not hers to turn off');
  assert.equal(auth.deleteApiToken(dee, id), true);
  assert.equal(api('GET', '/api/me', { token: spare }).status, 401);
});

test('a page on another site cannot use the API, even with a token', () => {
  const answer = api('GET', '/api/me', { token: anaToken, headers: { origin: 'https://evil.test' } });
  assert.equal(answer.status, 403);
  assert.equal(api('GET', '/api/me', { token: anaToken, headers: { origin: 'http://x.test' } }).status, 200);
});

test('MCP: initialize names the member, lists the tools, notifications get 202', () => {
  const init = rpc(anaToken, 'initialize', { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'test', version: '1' } }).result;
  assert.equal(init.protocolVersion, '2025-06-18', 'the version asked for, when it is known');
  assert.deepEqual(init.capabilities, { tools: {} });
  assert.match(init.instructions, /"Ana"/);
  assert.doesNotMatch(init.instructions, /an admin/);
  assert.equal(rpc(anaToken, 'initialize', { protocolVersion: '1999-01-01' }).result.protocolVersion, '2025-11-25');

  const tools = rpc(anaToken, 'tools/list').result.tools;
  assert.deepEqual(tools.map(tool => tool.name),
    ['list_people', 'who_is_free', 'list_free_days', 'set_free_days', 'clear_free_days']);
  assert.ok(tools.every(tool => tool.inputSchema.type === 'object' && !('run' in tool)));

  const note = api('POST', '/mcp', { token: anaToken, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(note.status, 202);
  assert.equal(rpc(anaToken, 'resources/list').error.code, -32601);
  assert.equal(api('GET', '/mcp', { token: anaToken }).status, 405);
  assert.equal(api('POST', '/mcp', { token: anaToken, body: [] }).body.error.code, -32600);
});

test('set_free_days: the same parts on every day, kept from the calendar sync; list and clear', () => {
  const set = callTool(anaToken, 'set_free_days', { dates: ['2026-12-20', '2026-12-11', '2026-12-11'] });
  assert.deepEqual(set.free_days, [{ date: '2026-12-11', parts: ['all'] }, { date: '2026-12-20', parts: ['all'] }]);
  callTool(anaToken, 'set_free_days', { dates: ['2026-12-20'], parts: ['eve', 'am'] });
  assert.deepEqual(freeDays(ana), ['2026-12-11 all', '2026-12-20 am eve']);
  assert.ok(isManual(ana, '2026-12-11'), 'set by hand: Calendar Integration leaves it alone');

  const listed = callTool(anaToken, 'list_free_days', { from: '2026-12-01', to: '2026-12-31' });
  assert.equal(listed.member, 'Ana');
  assert.equal(listed.today, today());
  assert.deepEqual(listed.free_days, [{ date: '2026-12-11', parts: ['all'] }, { date: '2026-12-20', parts: ['am', 'eve'] }]);

  callTool(anaToken, 'clear_free_days', { dates: ['2026-12-11'] });
  assert.deepEqual(freeDays(ana), ['2026-12-20 am eve']);
  assert.ok(isManual(ana, '2026-12-11'), 'cleared by hand stays cleared too');
});

test('tools refuse what they cannot do, in words an assistant can act on, and change nothing', () => {
  const before = freeDays(ana);
  const refusals = [
    callTool(anaToken, 'set_free_days', { dates: ['2026-12-21'], parts: ['all', 'am'] }),
    callTool(anaToken, 'set_free_days', { dates: ['2026-02-30'] }),
    callTool(anaToken, 'set_free_days', { dates: [['2026-12-21']] }),
    callTool(anaToken, 'set_free_days', { dates: [] }),
    callTool(anaToken, 'set_free_days', {}),
    callTool(anaToken, 'list_free_days', { from: '2026-12-31', to: '2026-12-01' }),
    callTool(anaToken, 'list_free_days', { from: '2026-01-01', to: '2027-06-01' }),
  ];
  assert.ok(refusals.every(answer => answer.refused), JSON.stringify(refusals));
  assert.match(refusals[0].refused, /parts/);
  assert.match(refusals[1].refused, /YYYY-MM-DD/);
  assert.deepEqual(freeDays(ana), before);
  assert.equal(rpc(anaToken, 'tools/call', { name: 'delete_everything', arguments: {} }).error.code, -32602);
});

test('a member only touches their own days; an admin can name anyone', () => {
  assert.match(callTool(anaToken, 'set_free_days', { dates: ['2026-12-24'], member: 'Dee' }).refused, /Only an admin/);
  assert.match(callTool(anaToken, 'list_free_days', { member: 'Nobody' }).refused, /Only an admin/,
    'the same answer whether that name exists or not');
  assert.deepEqual(freeDays(dee), []);
  assert.equal(callTool(anaToken, 'list_free_days', { member: 'ana' }).member, 'Ana', 'her own name, any case');

  const forDee = callTool(rootToken, 'set_free_days', { dates: ['2026-12-24'], member: 'dee' });
  assert.equal(forDee.member, 'Dee');
  assert.deepEqual(freeDays(dee), ['2026-12-24 all']);
  assert.deepEqual(freeDays(root), []);
  assert.match(callTool(rootToken, 'list_free_days', { member: 'Nobody' }).refused, /No member is named "Nobody"/);
  assert.match(rpc(rootToken, 'initialize', {}).result.instructions, /an admin/);
});

test('plain JSON: /api/me, GET and PUT /api/free-days, and its refusals', () => {
  assert.deepEqual(api('GET', '/api/me', { token: anaToken }).body,
    { member: 'Ana', admin: false, today: today(), time_zone: process.env.TZ });

  const put = api('PUT', '/api/free-days', { token: anaToken, body: { dates: ['2026-12-25'], parts: ['pm'] } });
  assert.equal(put.status, 200);
  const listed = api('GET', '/api/free-days?from=2026-12-25&to=2026-12-25', { token: anaToken }).body;
  assert.deepEqual(listed.free_days, [{ date: '2026-12-25', parts: ['pm'] }]);
  api('PUT', '/api/free-days', { token: anaToken, body: { dates: ['2026-12-25'], parts: [] } });
  assert.deepEqual(api('GET', '/api/free-days?from=2026-12-25&to=2026-12-25', { token: anaToken }).body.free_days, []);

  assert.equal(api('PUT', '/api/free-days', { token: anaToken, body: { dates: ['nope'] } }).status, 400);
  assert.equal(api('PUT', '/api/free-days', { token: anaToken, body: { dates: ['2026-12-25'], member: 'Dee' } }).status,
    403);
  assert.equal(api('PUT', '/api/free-days', { token: rootToken, body: { dates: ['2026-12-25'], member: 'Zed' } }).status,
    404);
  assert.equal(api('DELETE', '/api/free-days', { token: anaToken }).status, 405);
  assert.equal(api('GET', '/api/events', { token: anaToken }).status, 404);
  const notJson = handleApi({ method: 'PUT', url: new URL('http://x.test/api/free-days'), ip: '127.0.0.1', body: '{',
    headers: { host: 'x.test', 'content-type': 'application/json', authorization: `Bearer ${anaToken}` } });
  assert.equal(notJson.status, 400);
  const form = handleApi({ method: 'PUT', url: new URL('http://x.test/api/free-days'), ip: '127.0.0.1', body: 'a=1',
    headers: { host: 'x.test', 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${anaToken}` } });
  assert.equal(form.status, 415);
});

test('Settings: a token is shown once, needs a name, and can be turned off by its owner only', async () => {
  const unnamed = await request('POST', '/settings/ai-tokens', dee, [['label', '  ']]);
  assert.equal(unnamed.status, 400);
  assert.match(unnamed.html, /Give the token a name/);

  const made = await request('POST', '/settings/ai-tokens', dee, [['label', 'ChatGPT']]);
  const token = made.html.match(/<code>(mt_[\w-]+)<\/code>/)[1];
  assert.match(made.html, /claude mcp add --transport http meshtime http:\/\/localhost:3000\/mcp --header/);
  assert.equal(api('GET', '/api/me', { token }).body.member, 'Dee');
  assert.equal(get('SELECT 1 FROM api_tokens WHERE token_hash = ?', token), undefined, 'only its hash is kept');

  const later = (await request('GET', '/settings', dee)).html;
  assert.doesNotMatch(later, new RegExp(token), 'never shown again');
  assert.match(later, /<b>ChatGPT<\/b> <span class="hint">last used/);

  const { id } = get('SELECT id FROM api_tokens WHERE user_id = ? AND label = ?', dee, 'ChatGPT');
  await request('POST', `/settings/ai-tokens/${id}/delete`, ana);
  assert.equal(api('GET', '/api/me', { token }).status, 200, 'Ana cannot turn off Dee\'s token');
  assert.equal((await request('POST', `/settings/ai-tokens/${id}/delete`, dee)).location, '/settings?msg=ai_token_removed');
  assert.equal(api('GET', '/api/me', { token }).status, 401);
});

test('a password reset turns off every token, like sessions and passkeys', async () => {
  const token = auth.createApiToken(dee, 'old laptop');
  const link = auth.createInvite({ userId: dee });
  await request('POST', `/invite/${link}`, null, [['password', 'a-long-new-password']]);
  assert.equal(api('GET', '/api/me', { token }).status, 401);
});

// ---- other people's free days: who_is_free and list_people, as the member's calendar shows them ----

/** A group of `userIds` (the first one made it); returns its id. */
function addGroup(name, ...userIds) {
  const groupId = run('INSERT INTO member_groups(name, created_by, created_at) VALUES (?,?,?)', name, userIds[0], now())
    .lastInsertRowid;
  for (const userId of userIds) {
    run('INSERT INTO group_members(group_id, user_id, joined_at) VALUES (?,?,?)', groupId, userId, now());
  }
  return groupId;
}
const setFree = (userId, date, part = 'all', part2 = null) =>
  run('INSERT INTO free_days(user_id, date, part, part2) VALUES (?,?,?,?)', userId, date, part, part2);

// Bea and Cal hike together; Cal also works with Zoe, whom Bea shares no group with.
const [bea, cal, zoe] = ['Bea', 'Cal', 'Zoe'].map(name => addUser(name));
const beaToken = auth.createApiToken(bea, 'Claude');
addGroup('Hikers', bea, cal);
const work = addGroup('Work', cal, zoe);
setFree(bea, '2027-01-02');
setFree(cal, '2027-01-02', 'pm');
setFree(zoe, '2027-01-02');
setFree(bea, '2027-01-03', 'am');
setFree(cal, '2027-01-03', 'pm', 'eve');
setFree(cal, '2027-01-04');
const range = { from: '2027-01-01', to: '2027-01-31' };

test('list_people: everyone Bea sees on her calendar, and her groups with who is in each', () => {
  assert.deepEqual(callTool(beaToken, 'list_people', {}),
    { you: 'Bea', groups: [{ name: 'Hikers', members: ['Bea', 'Cal'] }], people: ['Bea', 'Cal'] });
});

test('who_is_free: who and which parts, and when they are free together, like the green days', () => {
  const answer = callTool(beaToken, 'who_is_free', range);
  assert.deepEqual(answer.people, ['Bea', 'Cal'], 'never Zoe: they share no group');
  assert.deepEqual(answer.days, [
    { date: '2027-01-02', free: [{ name: 'Bea', parts: ['all'] }, { name: 'Cal', parts: ['pm'] }], together: ['pm'] },
    { date: '2027-01-03', free: [{ name: 'Bea', parts: ['am'] }, { name: 'Cal', parts: ['pm', 'eve'] }], together: [] },
    { date: '2027-01-04', free: [{ name: 'Cal', parts: ['all'] }], together: [] },
  ]);
  assert.deepEqual(callTool(beaToken, 'who_is_free', { ...range, people: ['cal'] }).days.map(day => day.together),
    [['pm'], ['pm', 'eve'], ['all']], 'only Cal: together is whenever he is free');
  assert.deepEqual(callTool(beaToken, 'who_is_free', { ...range, group: 'hikers' }).people, ['Bea', 'Cal']);
});

test('who_is_free: someone you cannot see, or a group you are not in, is refused without saying who exists', () => {
  const unseen = callTool(beaToken, 'who_is_free', { people: ['Zoe'] }).refused;
  assert.equal(unseen, callTool(beaToken, 'who_is_free', { people: ['Nobody'] }).refused.replace('Nobody', 'Zoe'));
  assert.match(callTool(beaToken, 'who_is_free', { group: 'Work' }).refused, /no group named "Work"/);
  assert.match(callTool(beaToken, 'who_is_free', { group: 'Hikers', people: ['Cal'] }).refused, /not both/);
  assert.match(callTool(beaToken, 'who_is_free', { people: 'Cal' }).refused, /list of 1 to/);
});

test('who_is_free: another group\'s private event leaves someone free only around it, as on the calendar', () => {
  const event = run(`INSERT INTO events(title, date, end_date, start_time, end_time, created_by, created_at, is_private)
    VALUES ('Shift', '2027-01-04', '2027-01-04', '08:00', '17:00', ?, ?, 1)`, zoe, now()).lastInsertRowid;
  run('INSERT INTO event_groups(event_id, group_id) VALUES (?, ?)', event, work);
  const day = callTool(beaToken, 'who_is_free', range).days.find(row => row.date === '2027-01-04');
  assert.deepEqual(day.free, [{ name: 'Cal', parts: ['eve'] }]);
  assert.deepEqual(freeDays(cal).at(-1), '2027-01-04 all', 'his day itself is unchanged');
  run('DELETE FROM events WHERE id = ?', event);
});

test('groups turned off: everyone sees everyone, and no group can be named', () => {
  run('UPDATE app_settings SET groups_enabled = 0');
  try {
    const answer = callTool(beaToken, 'list_people', {});
    assert.ok(answer.people.includes('Zoe'));
    assert.deepEqual(answer.groups, []);
    assert.match(callTool(beaToken, 'who_is_free', { group: 'Hikers' }).refused, /Groups are turned off/);
  } finally {
    run('UPDATE app_settings SET groups_enabled = 1');
  }
});

test('plain JSON: GET /api/people and /api/who-is-free with repeated people', () => {
  assert.deepEqual(api('GET', '/api/people', { token: beaToken }).body.people, ['Bea', 'Cal']);
  const answer = api('GET', '/api/who-is-free?from=2027-01-02&to=2027-01-02&people=Bea&people=Cal', { token: beaToken });
  assert.deepEqual(answer.body.days, [{ date: '2027-01-02',
    free: [{ name: 'Bea', parts: ['all'] }, { name: 'Cal', parts: ['pm'] }], together: ['pm'] }]);
  assert.equal(api('GET', '/api/who-is-free?people=Zoe', { token: beaToken }).status, 404);
});
