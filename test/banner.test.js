import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The message banner: its rules (src/banner.js) and its routes against a throwaway DB (each test file runs in its
// own process, so this one is all ours).
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'meshtime-')), 'app.db');
const { run, now } = await import('../src/db.js');
const auth = await import('../src/auth.js');
const { routes } = await import('../src/routes.js');
const { bannerOn, bannerState, getBanner, readBannerForm, saveBanner, localNow } = await import('../src/banner.js');

/** Runs one route as member `userId` (null: logged out), the way server.js would; returns { status, html, location }. */
async function call(userId, method, path, body, cookies = {}) {
  const out = {};
  const url = new URL(path, 'http://x.test');
  const route = routes.find(r => r.method === method && r.path.test(url.pathname));
  await route.handler({
    ip: '127.0.0.1', url, params: url.pathname.match(route.path).groups || {}, lang: 'en', cookies,
    user: userId ? auth.userFromSession(auth.createSession(userId)) : null,
    body: body === undefined ? undefined : new URLSearchParams(body),
    html: (html, status = 200) => Object.assign(out, { status, html }),
    redirect: location => Object.assign(out, { status: 303, location }),
    fail: (status, html) => { Object.assign(out, { status, html }); }, // like server.js: falsy, so guards stop
  });
  return out;
}

const addUser = (name, isAdmin) => run(`INSERT INTO users(name, password_hash, feed_token, is_admin, created_at)
                                        VALUES (?, 'x', ?, ?, ?)`, name, 'tok-' + name, isAdmin, now()).lastInsertRowid;
const ada = addUser('Ada', 1), bob = addUser('Bob', 0);
const form = fields => new URLSearchParams(fields);
const blank = { message: '', tone: 'info', show_on_login: 0, dismissible: 0, starts_at: null, ends_at: null };

test('the form: tone falls back to info, line breaks kept, times checked', () => {
  const at = '2026-11-22T12:00';
  const { banner, errors } = readBannerForm(form({ message: '  Hi\r\nall  ', tone: 'neon', show_on_login: '1' }), at);
  assert.deepEqual(errors, {});
  assert.equal(banner.message, 'Hi\nall');
  assert.equal(banner.tone, 'info');
  assert.equal(banner.show_on_login, 1);
  assert.equal(banner.dismissible, 0);
  assert.equal(banner.ends_at, null);

  assert.deepEqual(readBannerForm(form({ message: 'x', ends_at: '2026-13-01T10:00' }), at).errors,
    { ends_at: 'errors.badDateTime' });
  assert.deepEqual(readBannerForm(form({ message: 'x', ends_at: '2026-11-22T11:59' }), at).errors,
    { ends_at: 'errors.bannerEndPast' });
  assert.deepEqual(readBannerForm(form({ message: 'x', starts_at: '2026-12-02T10:00', ends_at: '2026-12-01T10:00' }), at)
    .errors, { ends_at: 'errors.bannerEndBeforeStart' });
  // clearing the message with an old end left in the form still turns it off
  assert.deepEqual(readBannerForm(form({ message: '', ends_at: '2026-11-01T10:00' }), at).errors, {});
});

test('state follows the message, the start and the end', () => {
  assert.equal(bannerState(blank, '2026-11-22T12:00'), 'off');
  const banner = { ...blank, message: 'x', starts_at: '2026-11-23T08:00', ends_at: '2026-11-24T08:00' };
  assert.equal(bannerState(banner, '2026-11-22T12:00'), 'scheduled');
  assert.equal(bannerState(banner, '2026-11-23T08:00'), 'live');
  assert.equal(bannerState(banner, '2026-11-24T08:00'), 'ended');
  assert.equal(bannerState({ ...blank, message: 'x' }, '2099-01-01T00:00'), 'live');
});

test('only on the login page when asked; a closed one is back the next day, or once saved again', () => {
  saveBanner({ ...blank, message: 'Welcome!', dismissible: 1 });
  assert.equal(bannerOn('calendar').message, 'Welcome!');
  assert.equal(bannerOn('login'), null);
  saveBanner({ ...blank, message: 'Welcome!', dismissible: 1, show_on_login: 1 });
  assert.equal(bannerOn('login').message, 'Welcome!');

  const morning = '2026-11-22T09:00';
  const closed = { banner: bannerOn('calendar', {}, morning).closeKey };
  assert.equal(bannerOn('calendar', closed, morning), null);
  assert.equal(bannerOn('calendar', closed, '2026-11-22T23:59'), null);
  assert.equal(bannerOn('calendar', closed, '2026-11-23T00:00').message, 'Welcome!'); // the next day
  saveBanner({ ...getBanner(), message: 'Welcome back!' });
  assert.equal(bannerOn('calendar', closed, morning).message, 'Welcome back!');
  // not dismissible: the cookie is ignored
  saveBanner({ ...blank, message: 'Read me' });
  assert.equal(bannerOn('calendar', { banner: bannerOn('calendar', {}, morning).closeKey }, morning).message,
    'Read me');

  saveBanner({ ...blank, message: 'Later', starts_at: '2099-01-01T00:00' });
  assert.equal(bannerOn('calendar'), null);
  saveBanner(blank);
});

test('an admin saves it from Administration; members and visitors see it where it is shown', async () => {
  assert.equal((await call(bob, 'POST', '/admin/banner', 'message=Hacked')).status, 403);
  assert.equal(getBanner().message, '');

  const saved = await call(ada, 'POST', '/admin/banner', 'message=<b>Welcome</b>&tone=good&dismissible=1');
  assert.equal(saved.location, '/admin?msg=banner');
  const calendar = (await call(bob, 'GET', '/?m=2026-11')).html;
  assert.match(calendar, /class="banner banner-good"/);
  assert.match(calendar, /&lt;b&gt;Welcome&lt;\/b&gt;/); // plain text, never HTML
  assert.match(calendar, /data-banner="/);
  assert.doesNotMatch((await call(null, 'GET', '/login')).html, /class="banner /);

  await call(ada, 'POST', '/admin/banner', 'message=Hello visitors&show_on_login=1');
  assert.match((await call(null, 'GET', '/login')).html, /Hello visitors/);
  assert.doesNotMatch((await call(bob, 'GET', '/?m=2026-11')).html, /data-banner=/); // not dismissible

  const admin = (await call(ada, 'GET', '/admin')).html;
  assert.match(admin, /Showing now, until you clear it\./);
  assert.match(admin, /<textarea name="message"[^>]*>Hello visitors<\/textarea>/);
  assert.match(admin, /name="show_on_login" value="1" checked/);
});

test('a rejected save keeps what was typed and changes nothing', async () => {
  await call(ada, 'POST', '/admin/banner', 'message=Kept');
  const rejected = await call(ada, 'POST', '/admin/banner', 'message=Typed&ends_at=2000-01-01T00:00');
  assert.equal(rejected.status, 400);
  assert.match(rejected.html, /This end has already passed/);
  assert.match(rejected.html, />Typed<\/textarea>/);
  assert.equal(getBanner().message, 'Kept');
  assert.ok(localNow() > '2000-01-01T00:00');
});
