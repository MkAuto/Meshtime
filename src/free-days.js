import { all, run } from './db.js';
import { freeParts } from './lib.js';

// A member's free days as they set them themselves: by clicking the calendar (POST /free) or through an AI
// (src/api.js). Calendar Integration writes free_days on its own (src/sync.js) and leaves these alone.

/**
 * Sets one of `userId`'s days to `parts` (['all'], ['am', 'eve']..., in DAY_PARTS order; [] clears it) and marks
 * it set by hand, so the calendar sync never changes it.
 */
export function setFreeParts(userId, date, parts) {
  if (parts.length === 0) {
    run('DELETE FROM free_days WHERE user_id = ? AND date = ?', userId, date);
  } else {
    run(`INSERT INTO free_days(user_id, date, part, part2) VALUES (?,?,?,?)
         ON CONFLICT DO UPDATE SET part = excluded.part, part2 = excluded.part2`,
    userId, date, parts[0], parts[1] ?? null);
  }
  run('INSERT OR IGNORE INTO manual_days(user_id, date) VALUES (?, ?)', userId, date);
}

/** `userId`'s free days from `from` to `to` (both included): [{ date, parts }], by date. */
export const freeDaysBetween = (userId, from, to) => all(`SELECT date, part, part2 FROM free_days
  WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date`, userId, from, to)
  .map(row => ({ date: row.date, parts: freeParts(row) }));
