import { createHash } from 'node:crypto';
import { get, run, now } from './db.js';
import { isValidDate, wallClock, BANNER_TONES, MAX_BANNER } from './lib.js';

// The message banner: one message an admin writes in Administration → Banner, drawn at the top of the pages
// that ask for it. To show it on another page, its route passes `banner: bannerOn('<place>')` to the view
// (views.js page() hands it to the layout, which draws templates/banner.html). Members' pages always get it;
// PUBLIC_PLACES are seen by anyone with the link, so each one waits for its own admin option.

/** Places outside the login wall, each with the banner column that lets the banner show there. */
const PUBLIC_PLACES = { login: 'show_on_login' };

/**
 * The banner row, set or not (Administration shows it either way), with its `version`: a name for this save of it,
 * cookie-safe (hex), and new with every save or message.
 */
export function getBanner() {
  const banner = get('SELECT * FROM banner');
  const version = createHash('sha256').update(`${banner.updated_at}\n${banner.message}`).digest('hex').slice(0, 12);
  return { ...banner, version };
}

/** Now as a datetime-local value ("YYYY-MM-DDTHH:MM") in TIME_ZONE, the form starts_at / ends_at are stored in. */
export const localNow = () => wallClock(new Date()).replace(' ', 'T');

/** 'off' (no message), 'scheduled' (starts later), 'ended', or 'live'. */
export function bannerState(banner, at = localNow()) {
  if (!banner?.message) {
    return 'off';
  }
  if (banner.starts_at && banner.starts_at > at) {
    return 'scheduled';
  }
  return banner.ends_at && banner.ends_at <= at ? 'ended' : 'live';
}

/**
 * The banner to draw on `place` ('calendar', 'login', …) right now, or null. `cookies` are the request's.
 * Closing it (app.js, the ×) only hides it for the day, so a member who forgot what it said sees it again: the
 * banner cookie holds its `closeKey`, this save's version and today's date in TIME_ZONE. Tomorrow, or after any
 * save, the key no longer matches and the banner is back.
 */
export function bannerOn(place, cookies = {}, at = localNow()) {
  const banner = getBanner();
  if (bannerState(banner, at) !== 'live') {
    return null;
  }
  const option = PUBLIC_PLACES[place];
  if (option && !banner[option]) {
    return null;
  }
  const closeKey = `${banner.version}.${at.slice(0, 10)}`;
  return banner.dismissible && cookies.banner === closeKey ? null : { ...banner, closeKey };
}

const isValidLocalTime = text => /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(text) && isValidDate(text.slice(0, 10));

/**
 * The Banner form (URLSearchParams) as a banner row, and { field: locale key } for what is wrong with it.
 * `at` is now, for an end already past.
 */
export function readBannerForm(body, at = localNow()) {
  const time = name => (body.get(name) ?? '').trim().slice(0, 16) || null;
  const banner = {
    // CRLF from the textarea kept as plain line breaks; style.css keeps them on screen
    message: (body.get('message') ?? '').replace(/\r\n?/g, '\n').trim().slice(0, MAX_BANNER),
    tone: BANNER_TONES.includes(body.get('tone')) ? body.get('tone') : 'info',
    show_on_login: body.get('show_on_login') === '1' ? 1 : 0,
    dismissible: body.get('dismissible') === '1' ? 1 : 0,
    starts_at: time('starts_at'),
    ends_at: time('ends_at'),
  };
  const errors = {};
  if (banner.starts_at && !isValidLocalTime(banner.starts_at)) {
    errors.starts_at = 'errors.badDateTime';
  }
  if (banner.ends_at && !isValidLocalTime(banner.ends_at)) {
    errors.ends_at = 'errors.badDateTime';
  } else if (banner.ends_at && banner.message && banner.ends_at <= at) {
    errors.ends_at = 'errors.bannerEndPast';
  } else if (banner.ends_at && banner.starts_at && !errors.starts_at && banner.ends_at <= banner.starts_at) {
    errors.ends_at = 'errors.bannerEndBeforeStart';
  }
  return { banner, errors };
}

/** Saves the banner. Its new version brings a closed banner back for everyone (bannerOn). */
export function saveBanner({ message, tone, show_on_login, dismissible, starts_at, ends_at }) {
  run(`UPDATE banner SET message = ?, tone = ?, show_on_login = ?, dismissible = ?, starts_at = ?, ends_at = ?,
       updated_at = ?`, message, tone, show_on_login, dismissible, starts_at, ends_at, now());
}
