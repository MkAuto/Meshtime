import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { get, run, all, now } from './db.js';

const scryptP = promisify(scrypt);
const DAY = 86400000;
const plus = ms => new Date(Date.now() + ms).toISOString();
const sha = s => createHash('sha256').update(s).digest('hex');
export const token = () => randomBytes(32).toString('base64url');

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + (await scryptP(pw, salt, 64)).toString('hex');
}
export async function verifyPassword(pw, stored) {
  const [s, h] = stored.split(':');
  return timingSafeEqual(Buffer.from(h, 'hex'), await scryptP(pw, Buffer.from(s, 'hex'), 64));
}
export const DUMMY_HASH = await hashPassword('dummy'); // keeps login timing flat for unknown names

// ---- sessions: cookie holds a random id, DB stores its sha256 ----
export const SESSION_SECONDS = 30 * 86400;
export function createSession(userId) {
  const id = token();
  run('DELETE FROM sessions WHERE expires_at < ?', now());
  run('INSERT INTO sessions(id_hash, user_id, expires_at) VALUES (?,?,?)', sha(id), userId, plus(SESSION_SECONDS * 1000));
  return id;
}
export const userFromSession = sid => sid
  ? get('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?', sha(sid), now())
  : undefined;
export const deleteSession = sid => run('DELETE FROM sessions WHERE id_hash = ?', sha(sid));
export const deleteUserSessions = userId => run('DELETE FROM sessions WHERE user_id = ?', userId);

// ---- invites (user_id set => password-reset link for that user) ----
export function createInvite({ createdBy = null, isAdmin = 0, userId = null } = {}) {
  const t = token();
  run('INSERT INTO invites(token, created_by, is_admin, user_id, expires_at) VALUES (?,?,?,?,?)', t, createdBy, isAdmin, userId, plus(7 * DAY));
  return t;
}
export const getInvite = t => get(
  'SELECT i.*, u.name AS user_name FROM invites i LEFT JOIN users u ON u.id = i.user_id WHERE i.token = ? AND i.used_at IS NULL AND i.expires_at > ?', t, now());
export const consumeInvite = t =>
  run('UPDATE invites SET used_at = ? WHERE token = ? AND used_at IS NULL AND expires_at > ?', now(), t, now()).changes === 1;
export const openInvites = () => all(
  'SELECT i.token, i.is_admin, u.name AS user_name FROM invites i LEFT JOIN users u ON u.id = i.user_id WHERE i.used_at IS NULL AND i.expires_at > ? ORDER BY i.expires_at', now());

// ponytail: global in-memory login limiter (20 failures / 15 min); per-IP if abuse appears
let fails = [];
export const loginAllowed = () => (fails = fails.filter(t => t > Date.now() - 15 * 60000)).length < 20;
export const loginFailed = () => fails.push(Date.now());
