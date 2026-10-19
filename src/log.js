import { appendFileSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import { DATA_DIR } from './db.js';
import { TIME_ZONE } from './lib.js';

// ---- connection log: one line per login event, in DATA_DIR/meshtime.log ----

export const LOG_PATH = join(DATA_DIR, 'meshtime.log');

// Log times are in TIME_ZONE (the TZ env var), written with their offset so a line stays unambiguous
// across a DST switch or a TZ change. Node's built-in Intl knows the zone rules, no library needed.
const zoneFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, hourCycle: 'h23', timeZoneName: 'longOffset',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** `date` in TIME_ZONE as ISO 8601 with its offset: "2026-09-29T16:44:24-04:00". */
export function localTimestamp(date = new Date()) {
  const part = Object.fromEntries(zoneFormat.formatToParts(date).map(({ type, value }) => [type, value]));
  const offset = part.timeZoneName.replace('GMT', '') || '+00:00'; // "GMT-04:00"; plain "GMT" at UTC+0
  return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:${part.second}${offset}`;
}

/**
 * One line: time, client address, user, action. `known` says whether that name is a real member,
 * since a failed login logs whatever name was typed.
 * The name is JSON-quoted: it is user input, and a newline in it must not forge a second log line.
 */
export function formatLogLine({ ip, user, known, action }) {
  const cleanIp = String(ip ?? '?').replace(/\s/g, '');
  const who = user == null ? '-' : JSON.stringify(user) + (known ? '' : ' (unknown)'); // null: no name was given
  return `${localTimestamp()} ip=${cleanIp} user=${who} action=${action}\n`;
}

export function logEvent(entry) {
  try {
    appendFileSync(LOG_PATH, formatLogLine(entry));
  } catch (err) {
    console.error('Could not write meshtime.log', err); // a full disk must not break logging in
  }
}

// ---- error log: everything written to console.error / console.warn, in DATA_DIR/errors.log ----

export const ERROR_LOG_PATH = join(DATA_DIR, 'errors.log');

/** One entry: a header line (time, level), then the message as the console shows it, then a blank line. */
function appendError(level, text) {
  try {
    appendFileSync(ERROR_LOG_PATH, `${localTimestamp()} ${level}\n${text}\n\n`);
  } catch {
    // the console already has it; a full disk must not turn one error into a crash
  }
}

for (const level of ['error', 'warn']) {
  const writeToConsole = console[level];
  console[level] = (...args) => {
    writeToConsole(...args);
    appendError(level.toUpperCase(), format(...args));
  };
}

// A crash prints straight to stderr, not through console: catch it here too. The monitor only watches,
// so Node still exits as before. It also sees unhandled promise rejections (Node's default: they crash).
process.on('uncaughtExceptionMonitor', (err, origin) => appendError(`FATAL (${origin})`, format(err)));

const TAIL_BYTES = 256 * 1024; // comfortably more than 200 lines, and bounded however big the file gets

// The user field is '-' or a JSON string (whose own quotes are escaped), so a name containing
// " action=" cannot shift the columns.
const LINE_RE = /^(\S+) ip=(\S+) user=(-|"(?:[^"\\]|\\.)*")( \(unknown\))? action=(.*)$/;

/** One log line as table columns. A line in no known shape keeps its raw text as the action. */
export function parseLogLine(line) {
  const match = LINE_RE.exec(line);
  if (!match) {
    return { time: '', ip: '', user: '', known: true, action: line };
  }
  const [, rawTime, ip, user, unknown, action] = match;
  // Every line carries its offset (old ones are UTC "...Z"): re-show it in TIME_ZONE so the table reads as one zone.
  const date = new Date(rawTime);
  const time = Number.isNaN(date.getTime()) ? rawTime : localTimestamp(date);
  return { time, ip, user: user === '-' ? '' : JSON.parse(user), known: !unknown, action };
}

/** Every line ends with '\n', so the newline count is the line count. Read in chunks, never whole. */
function countLines(fd, size) {
  const chunk = Buffer.alloc(TAIL_BYTES);
  let lines = 0;
  for (let position = 0; position < size; position += chunk.length) {
    const read = readSync(fd, chunk, 0, chunk.length, position);
    for (let i = 0; i < read; i++) {
      if (chunk[i] === 10) {
        lines++;
      }
    }
  }
  return lines;
}

/**
 * The last `count` lines of the log, parsed, each with its line number in the file. [] if there is none yet.
 * ponytail: the line count scans the whole file on every Admin page view (~0.1 s per 100 MB);
 * keep a running count in memory if the log ever gets that big.
 */
export function tailLog(count = 200) {
  let fd;
  try { fd = openSync(LOG_PATH, 'r'); } catch { return []; }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString().split('\n').filter(Boolean).slice(-count);
    const first = countLines(fd, size) - lines.length + 1;
    return lines.map((line, i) => ({ number: first + i, ...parseLogLine(line) }));
  } finally {
    closeSync(fd);
  }
}
