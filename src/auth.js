import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { get, run, all, now } from './db.js';

const scryptAsync = promisify(scrypt);
const DAY_MS = 86400000;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

const isoIn = ms => new Date(Date.now() + ms).toISOString();
const sha256 = value => createHash('sha256').update(value).digest('hex');

/** A 256-bit random id, URL-safe. Used for session ids, invite links and feed links. */
export const token = () => randomBytes(32).toString('base64url');

// ---- passwords: stored as "saltHex:hashHex" ----

export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(password, salt, KEY_BYTES);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

export async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const candidate = await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEY_BYTES);
  return timingSafeEqual(Buffer.from(hashHex, 'hex'), candidate);
}

// Checked against when the name is unknown, so a wrong name costs the same time as a wrong password.
export const DUMMY_HASH = await hashPassword('dummy');

// ---- sessions: the cookie holds a random id, the DB stores only its sha256 ----

export const SESSION_SECONDS = 30 * 86400;

export function createSession(userId) {
  const sessionId = token();
  run('DELETE FROM sessions WHERE expires_at < ?', now()); // cheap cleanup, no cron needed
  run('INSERT INTO sessions(id_hash, user_id, expires_at) VALUES (?,?,?)',
    sha256(sessionId), userId, isoIn(SESSION_SECONDS * 1000));
  return sessionId;
}

/** The logged-in user row for a session cookie, or undefined if it is missing, unknown or expired. */
export const userFromSession = sessionId => sessionId
  ? get(`SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.id_hash = ? AND s.expires_at > ?`, sha256(sessionId), now())
  : undefined;

export const deleteSession = sessionId => run('DELETE FROM sessions WHERE id_hash = ?', sha256(sessionId));
export const deleteUserSessions = userId => run('DELETE FROM sessions WHERE user_id = ?', userId);

// ---- invites: a link that creates an account, or resets one user's password when userId is given ----

export function createInvite({ createdBy = null, isAdmin = 0, userId = null } = {}) {
  const inviteToken = token();
  run('INSERT INTO invites(token, created_by, is_admin, user_id, expires_at) VALUES (?,?,?,?,?)',
    inviteToken, createdBy, isAdmin, userId, isoIn(7 * DAY_MS));
  return inviteToken;
}

/** The invite row plus the target user's name, only while it is unused and unexpired. */
export const getInvite = inviteToken => get(`
  SELECT i.*, u.name AS user_name FROM invites i
  LEFT JOIN users u ON u.id = i.user_id
  WHERE i.token = ? AND i.used_at IS NULL AND i.expires_at > ?`, inviteToken, now());

/** Marks an invite used. Returns false if it was already used, so two racing requests cannot both win. */
export const consumeInvite = inviteToken =>
  run('UPDATE invites SET used_at = ? WHERE token = ? AND used_at IS NULL AND expires_at > ?',
    now(), inviteToken, now()).changes === 1;

export const openInvites = () => all(`
  SELECT i.token, i.is_admin, u.name AS user_name FROM invites i
  LEFT JOIN users u ON u.id = i.user_id
  WHERE i.used_at IS NULL AND i.expires_at > ?
  ORDER BY i.expires_at`, now());

// ---- login rate limit ----
// ponytail: global in-memory limiter (20 failures / 15 min); per-IP if abuse appears
const WINDOW_MS = 15 * 60000;
const MAX_FAILURES = 20;
let failedAt = [];

export function loginAllowed() {
  failedAt = failedAt.filter(at => at > Date.now() - WINDOW_MS); // drop failures older than the window
  return failedAt.length < MAX_FAILURES;
}

export const loginFailed = () => failedAt.push(Date.now());
