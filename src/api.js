import packageJson from '../package.json' with { type: 'json' };
import { get, all, tx } from './db.js';
import { userFromApiToken } from './auth.js';
import { setFreeParts, freeDaysBetween } from './free-days.js';
import { VISIBLE_TO_ME, audienceFor, calendarDays } from './audience.js';
import { logEvent } from './log.js';
import {
  isValidDate, today, addDays, daysBetween, cleanParts, freeTogether, DAY_PARTS, SLOTS, TIME_ZONE,
} from './lib.js';

// AI access: what an assistant can do for a member, with a token they made in Settings → AI access. Two ways in,
// the same three things behind both:
//   /mcp           an MCP server (Streamable HTTP, JSON answers, no session), for assistants that speak MCP
//   /api/...       plain JSON, for anything else: GET /api/me, GET /api/free-days, PUT /api/free-days,
//                  GET /api/people, GET /api/who-is-free
// A token acts as the member who made it. Their own free days it reads and changes; an admin's can name another
// member (`member`) for those, nobody else's can. Other people's it only reads, exactly as the member's calendar
// shows them (src/audience.js): only people sharing a group with them, and only free around events they cannot see.
// No cookie is read here, so a page elsewhere cannot borrow a logged-in browser: the token is the only credential.

/** A refusal the caller should read: `message` goes back as is (English, for an assistant, not a page). */
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_DAYS = 366; // dates in one call, and the longest range read at once
const DEFAULT_RANGE = 60; // days read when no end is given
const MAX_PEOPLE = 50; // names in one who_is_free

export const isApiPath = pathname => pathname === '/mcp' || pathname.startsWith('/api/');

/** Whose free days: the caller's, or the member an admin named. */
function memberFor(caller, name) {
  if (name === undefined || name === null || name === '') {
    return caller;
  }
  if (typeof name !== 'string') {
    throw new ApiError(400, '`member` must be a member\'s name.');
  }
  if (name.toLowerCase() === caller.name.toLowerCase()) {
    return caller;
  }
  if (!caller.is_admin) {
    throw new ApiError(403, 'Only an admin can name another member here: leave `member` out for your own days. '
      + 'To see when other people are free, use who_is_free.');
  }
  const member = get('SELECT id, name FROM users WHERE name = ?', name);
  if (!member) {
    throw new ApiError(404, `No member is named ${JSON.stringify(name)}.`);
  }
  return member;
}

const isDate = value => typeof value === 'string' && isValidDate(value);

function readDates(dates) {
  if (!Array.isArray(dates) || dates.length === 0 || dates.length > MAX_DAYS || !dates.every(isDate)) {
    throw new ApiError(400, `\`dates\` must be a list of 1 to ${MAX_DAYS} dates written YYYY-MM-DD.`);
  }
  return [...new Set(dates)].sort();
}

/** `from` and `to` as asked, or their defaults: today, and DEFAULT_RANGE days after `from`. */
function readRange(from, to) {
  const start = from ?? today();
  const end = to ?? addDays(start, DEFAULT_RANGE);
  if (!isDate(start) || !isDate(end)) {
    throw new ApiError(400, '`from` and `to` must be dates written YYYY-MM-DD.');
  }
  const length = daysBetween(start, end);
  if (length < 0 || length >= MAX_DAYS) {
    throw new ApiError(400, `\`to\` must be on or after \`from\`, at most ${MAX_DAYS - 1} days later.`);
  }
  return [start, end];
}

const groupsOn = () => Boolean(get('SELECT groups_enabled FROM app_settings').groups_enabled);

/** The groups `userId` is in, with their members' names. */
const groupsOf = userId => all(`SELECT g.id, g.name FROM member_groups g JOIN group_members m ON m.group_id = g.id
  WHERE m.user_id = ? ORDER BY g.name COLLATE NOCASE, g.id`, userId)
  .map(group => ({ ...group, members: all(`SELECT u.name FROM users u JOIN group_members m ON m.user_id = u.id
    WHERE m.group_id = ? ORDER BY u.name COLLATE NOCASE`, group.id).map(row => row.name) }));

const NOT_SEEN = name => `You do not see anyone named ${JSON.stringify(name)} on your calendar. `
  + 'list_people gives the names you can use.';

/** What who_is_free looks at: one of the caller's groups (by name), some people (by name), or everyone they see. */
function viewFor(caller, group, people) {
  if (group !== undefined && people !== undefined) {
    throw new ApiError(400, 'Give `group` or `people`, not both.');
  }
  if (group !== undefined) {
    if (!groupsOn()) {
      throw new ApiError(400, 'Groups are turned off in this Meshtime: leave `group` out to see everyone.');
    }
    const matches = typeof group === 'string'
      ? groupsOf(caller.id).filter(mine => mine.name.toLowerCase() === group.trim().toLowerCase()) : [];
    if (matches.length !== 1) {
      throw new ApiError(400, matches.length ? `You are in ${matches.length} groups named ${JSON.stringify(group)}.`
        : `You are in no group named ${JSON.stringify(group)}. list_people gives your groups.`);
    }
    return matches[0];
  }
  if (people !== undefined) {
    if (!Array.isArray(people) || people.length === 0 || people.length > MAX_PEOPLE
      || !people.every(name => typeof name === 'string')) {
      throw new ApiError(400, `\`people\` must be a list of 1 to ${MAX_PEOPLE} names.`);
    }
    return { people: people.map(name => {
      // One answer for a name nobody has and a name they cannot see: it says nothing about who has an account.
      const person = get(`SELECT u.id FROM users u WHERE u.name = ? AND ${VISIBLE_TO_ME}`, name.trim(),
        caller.id, caller.id);
      if (!person) {
        throw new ApiError(404, NOT_SEEN(name));
      }
      return person.id;
    }) };
  }
  return null;
}

// ---- what an assistant can do ----

function listFreeDays(caller, { from, to, member }) {
  const who = memberFor(caller, member);
  const [start, end] = readRange(from, to);
  return { member: who.name, today: today(), from: start, to: end, free_days: freeDaysBetween(who.id, start, end) };
}

/** Everyone the caller sees on their calendar, and their groups with who is in each. */
function listPeople(caller) {
  const people = all(`SELECT u.name FROM users u WHERE ${VISIBLE_TO_ME} ORDER BY u.name COLLATE NOCASE`,
    caller.id, caller.id).map(row => row.name);
  const groups = groupsOn() ? groupsOf(caller.id).map(({ name, members }) => ({ name, members })) : [];
  return { you: caller.name, groups, people };
}

/**
 * Who is free, day by day, as the caller's calendar shows it: one of their groups, some people, or everyone they
 * see (themselves included). `together`: the parts of the day all of them are free at once, as the calendar's
 * green days.
 */
function whoIsFree(caller, { from, to, group, people }) {
  const [start, end] = readRange(from, to);
  const audience = audienceFor(caller.id, viewFor(caller, group, people));
  const names = all(`SELECT u.name FROM users u WHERE ${audience.sql} ORDER BY u.name COLLATE NOCASE`,
    ...audience.params).map(row => row.name);
  const byDate = new Map();
  for (const row of calendarDays(caller.id, audience, start, end).freeDays) {
    byDate.set(row.date, [...byDate.get(row.date) ?? [], { name: row.name, parts: row.parts }]);
  }
  const days = [...byDate].map(([date, free]) => ({ date, free, together: freeTogether(free, names.length) }));
  return { you: caller.name, today: today(), from: start, to: end, people: names, days };
}

function setFreeDays(caller, { dates, parts = ['all'], member }, ip) {
  const who = memberFor(caller, member);
  const days = readDates(dates);
  const clean = cleanParts(parts);
  if (!clean) {
    throw new ApiError(400, `\`parts\` must be ["all"], or one or two of ${SLOTS.map(slot => `"${slot}"`).join(', ')}; `
      + '[] clears the days.');
  }
  tx(() => days.forEach(date => setFreeParts(who.id, date, clean)));
  const what = clean.length ? `set (${clean.join('+')})` : 'cleared';
  const forWhom = who.id === caller.id ? '' : ` for ${JSON.stringify(who.name)}`;
  logEvent({ ip, user: caller.name, known: true,
    action: `${days.length} free day(s) ${what}${forWhom} by AI access: ${days.join(' ')}` });
  return { member: who.name, today: today(), free_days: days.map(date => ({ date, parts: clean })) };
}

const clearFreeDays = (caller, { dates, member }, ip) => setFreeDays(caller, { dates, parts: [], member }, ip);

// ---- MCP ----

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']; // newest first

const PARTS_TEXT = 'A day is free "all" day, or only some of its parts: "am" (morning, 6:00-12:00), "pm" (afternoon, '
  + '12:00-18:00), "eve" (evening, 18:00-midnight), at most two of them.';

const memberProperty = {
  type: 'string',
  description: 'Admins only: the name of the member whose free days these are. Leave it out for your own.',
};
const datesProperty = {
  type: 'array',
  items: { type: 'string', format: 'date' },
  minItems: 1,
  maxItems: MAX_DAYS,
  description: 'The days, written YYYY-MM-DD.',
};

const rangeProperties = {
  from: { type: 'string', format: 'date', description: 'First day, YYYY-MM-DD. Default: today.' },
  to: { type: 'string', format: 'date',
    description: `Last day, YYYY-MM-DD, at most ${MAX_DAYS - 1} days after from. Default: ${DEFAULT_RANGE} days after from.` },
};

const TOOLS = [
  {
    name: 'list_people',
    title: 'List people',
    description: 'The people you see on your Meshtime calendar (you included), and the groups you are in with who is '
      + 'in each. Use these names in who_is_free.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run: listPeople,
  },
  {
    name: 'who_is_free',
    title: 'Who is free',
    description: `Who is free on which days, as your calendar shows it: everyone you see (you included), one of your `
      + `groups, or the people you name. ${PARTS_TEXT} Each day lists who is free and which parts, and \`together\`: `
      + 'the parts of the day when all of them are free at once ([] when they never overlap). Only days on which '
      + 'someone is free are listed.',
    inputSchema: {
      type: 'object',
      properties: {
        ...rangeProperties,
        group: { type: 'string', description: 'One of your groups, by name: only its members.' },
        people: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_PEOPLE,
          description: 'Only these people, by name (list_people). Include yourself to count yourself in `together`.' },
      },
    },
    annotations: { readOnlyHint: true },
    run: whoIsFree,
  },
  {
    name: 'list_free_days',
    title: 'List free days',
    description: `Your own free days as you set them, between two dates, to check or change them. ${PARTS_TEXT} `
      + 'A day not listed is one you said nothing about. For other people, use who_is_free.',
    inputSchema: {
      type: 'object',
      properties: { ...rangeProperties, member: memberProperty },
    },
    annotations: { readOnlyHint: true },
    run: listFreeDays,
  },
  {
    name: 'set_free_days',
    title: 'Set free days',
    description: `Marks days as free, replacing what each of those days said before. ${PARTS_TEXT} Every day given `
      + 'gets the same parts. Days set here are kept even if the member connects a calendar to Meshtime.',
    inputSchema: {
      type: 'object',
      properties: {
        dates: datesProperty,
        parts: {
          type: 'array',
          items: { type: 'string', enum: DAY_PARTS },
          maxItems: 2,
          description: 'Which parts of each day are free: ["all"] (the default), or one or two of "am", "pm", "eve".',
        },
        member: memberProperty,
      },
      required: ['dates'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    run: setFreeDays,
  },
  {
    name: 'clear_free_days',
    title: 'Clear free days',
    description: 'Removes days from a member\'s free days: they no longer say they are free then.',
    inputSchema: {
      type: 'object',
      properties: { dates: datesProperty, member: memberProperty },
      required: ['dates'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    run: clearFreeDays,
  },
];

const instructions = caller => `Meshtime is a shared calendar where a group of friends mark the days they are free. `
  + `You act as the member ${JSON.stringify(caller.name)}: you set their free days, and see the free days of the `
  + `people they share a group with (who_is_free, to find when people can meet)${caller.is_admin
    ? '. They are an admin: name another member in `member` to set that member\'s free days for them'
    : ''}. Dates are days in the ${TIME_ZONE} time zone, written YYYY-MM-DD; today is ${today()}. ${PARTS_TEXT}`;

const rpcAnswer = (id, answer) => json(200, { jsonrpc: '2.0', id, ...answer });
const rpcError = (id, code, message) => rpcAnswer(id, { error: { code, message } });

function mcp(caller, method, message, ip) {
  if (method !== 'POST') {
    return { status: 405, headers: { Allow: 'POST' }, body: '' }; // no server-sent stream to open: every answer is JSON
  }
  if (Array.isArray(message)) {
    return rpcError(null, -32600, 'Send one message per request.');
  }
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return 'result' in (message ?? {}) || 'error' in (message ?? {}) ? accepted()
      : rpcError(message?.id ?? null, -32600, 'Not a JSON-RPC 2.0 request.');
  }
  if (!('id' in message)) {
    return accepted(); // a notification (notifications/initialized...): nothing to answer
  }
  const { id, params = {} } = message;
  switch (message.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return rpcAnswer(id, { result: {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'meshtime', title: 'Meshtime', version: packageJson.version },
        instructions: instructions(caller),
      } });
    }
    case 'ping':
      return rpcAnswer(id, { result: {} });
    case 'tools/list':
      return rpcAnswer(id, { result: { tools: TOOLS.map(({ run, ...tool }) => tool) } });
    case 'tools/call': {
      const tool = TOOLS.find(candidate => candidate.name === params.name);
      if (!tool) {
        return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      }
      const args = params.arguments ?? {};
      try {
        if (typeof args !== 'object' || Array.isArray(args)) {
          throw new ApiError(400, 'The arguments must be an object.');
        }
        const result = tool.run(caller, args, ip);
        return rpcAnswer(id, { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      } catch (err) {
        if (!(err instanceof ApiError)) {
          throw err;
        }
        // a refusal the assistant can read and correct, not a protocol error
        return rpcAnswer(id, { result: { content: [{ type: 'text', text: err.message }], isError: true } });
      }
    }
    default:
      return rpcError(id, -32601, `Unknown method: ${message.method}`);
  }
}

// ---- plain JSON ----

function rest(caller, method, url, input, ip) {
  const route = `${method} ${url.pathname}`;
  if (route === 'GET /api/me') {
    return json(200, { member: caller.name, admin: Boolean(caller.is_admin), today: today(), time_zone: TIME_ZONE });
  }
  if (route === 'GET /api/free-days') {
    const query = name => url.searchParams.get(name) ?? undefined;
    return json(200, listFreeDays(caller, { from: query('from'), to: query('to'), member: query('member') }));
  }
  if (route === 'GET /api/people') {
    return json(200, listPeople(caller));
  }
  if (route === 'GET /api/who-is-free') {
    const query = name => url.searchParams.get(name) ?? undefined;
    const people = url.searchParams.getAll('people');
    return json(200, whoIsFree(caller, { from: query('from'), to: query('to'), group: query('group'),
      people: people.length ? people : undefined }));
  }
  if (route === 'PUT /api/free-days') {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new ApiError(400, 'Send a JSON object: { "dates": [...], "parts": [...] }.');
    }
    return json(200, setFreeDays(caller, input, ip));
  }
  if (['/api/me', '/api/free-days', '/api/people', '/api/who-is-free'].includes(url.pathname)) {
    return json(405, { error: `${method} is not used on ${url.pathname}.` });
  }
  throw new ApiError(404, 'No such API route. There are GET /api/me, GET and PUT /api/free-days, GET /api/people '
    + 'and GET /api/who-is-free.');
}

// ---- the way in ----

const json = (status, value, headers = {}) =>
  ({ status, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
const accepted = () => ({ status: 202, headers: {}, body: '' });

const bearer = header => /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];

/** A browser page from another site (Origin not ours) is refused, as the MCP spec asks against DNS rebinding. */
function fromOtherSite(headers) {
  if (!headers.origin) {
    return false;
  }
  try {
    return new URL(headers.origin).host !== headers.host;
  } catch {
    return true;
  }
}

/**
 * Answers one request to /mcp or /api/... (isApiPath). `body` is the raw request body ('' for none).
 * Returns { status, headers, body } for server.js to send.
 */
export function handleApi({ method, url, headers, body, ip }) {
  if (fromOtherSite(headers)) {
    return json(403, { error: 'Requests from other sites are refused.' });
  }
  const caller = userFromApiToken(bearer(headers.authorization));
  if (!caller) {
    return json(401, { error: 'Send a Meshtime token as "Authorization: Bearer mt_…" (Settings → AI access).' },
      { 'WWW-Authenticate': 'Bearer realm="meshtime"' });
  }
  let input;
  if (body) {
    if (!(headers['content-type'] ?? '').startsWith('application/json')) {
      return json(415, { error: 'Send JSON (Content-Type: application/json).' });
    }
    try {
      input = JSON.parse(body);
    } catch {
      return url.pathname === '/mcp' ? rpcError(null, -32700, 'The body is not valid JSON.')
        : json(400, { error: 'The body is not valid JSON.' });
    }
  }
  try {
    return url.pathname === '/mcp' ? mcp(caller, method, input, ip) : rest(caller, method, url, input, ip);
  } catch (err) {
    if (err instanceof ApiError) {
      return json(err.status, { error: err.message });
    }
    throw err;
  }
}
