import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Languages: every locale file complete, every key the code uses there, a French page, and the language menu's
// route against a throwaway DB (each test file runs in its own process, so this one is all ours).
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'meshtime-')), 'app.db');
const { get, run, now } = await import('../src/db.js');
const auth = await import('../src/auth.js');
const { routes } = await import('../src/routes.js');
const { pollPage } = await import('../src/views.js');
const { t, syncErrorText } = await import('../src/i18n.js');
const { LANGUAGES, DAY_PARTS, SLOTS, ANSWERS, BUSY_CHOICES, pickLanguage } = await import('../src/lib.js');

const SRC = join(import.meta.dirname, '..', 'src');
const readLocale = code => JSON.parse(readFileSync(join(SRC, 'locales', `${code}.json`), 'utf8'));

/** { 'settings.title': 'Settings', ... }: every text of a locale file by its key. */
const flatten = (node, prefix = '') => Object.entries(node).flatMap(([key, value]) =>
  typeof value === 'object' ? Object.entries(flatten(value, `${prefix}${key}.`)) : [[prefix + key, value]])
  .reduce((texts, [key, value]) => ({ ...texts, [key]: value }), {});

const english = flatten(readLocale('en'));
const placeholders = text => (text.match(/\{\{\w+\}\}/g) ?? []).sort();

test('every language has exactly the English keys, with the same {{placeholders}}', () => {
  for (const { code } of LANGUAGES) {
    const texts = flatten(readLocale(code));
    assert.deepEqual(Object.keys(texts).sort(), Object.keys(english).sort(), `${code}.json: missing or extra keys`);
    for (const [key, text] of Object.entries(texts)) {
      assert.deepEqual(placeholders(text), placeholders(english[key]), `${code}.json ${key}`);
    }
  }
});

test('every key the templates and the code use is in en.json', () => {
  const topLevel = new Set(Object.keys(readLocale('en')));
  const used = [];
  for (const file of readdirSync(join(SRC, 'templates'))) {
    const template = readFileSync(join(SRC, 'templates', file), 'utf8');
    used.push(...[...template.matchAll(/\{\{\{?t\.([\w.]+)\}?\}\}/g)].map(match => [file, match[1]]));
  }
  for (const file of readdirSync(SRC).filter(name => name.endsWith('.js'))) {
    const code = readFileSync(join(SRC, file), 'utf8');
    // every quoted 'section.key' whose section is one of en.json's: t() calls, ctx.fail, eventError, sync errors
    // (sync.httpStatus is built with its status: the syncErrorText test covers it). File names look the same
    // ('errors.log'): left out.
    used.push(...[...code.matchAll(/'([a-zA-Z]+(?:\.\w+)+)'/g)]
      .filter(match => topLevel.has(match[1].split('.')[0]) && !/\.(log|js|json|html|css|ics|db)$/.test(match[1]))
      .map(match => [file, match[1]]));
  }
  // the keys built from a value: one per value
  used.push(
    ...DAY_PARTS.map(part => ['views.js', `dayParts.label.${part}`]),
    ...['all', 'am', 'pm', 'eve', 'none', 'auto'].map(part => ['views.js', `dayParts.choice.${part}`]),
    ...SLOTS.map(slot => ['views.js', `dayParts.short.${slot}`]),
    ...ANSWERS.map(answer => ['views.js', `poll.answers.${answer}`]),
    ...BUSY_CHOICES.map(minutes => ['views.js', `settings.busyChoices.${minutes}`]),
    ...['event', 'poll'].map(kind => ['routes.js', `errors.privateNeedsGroup.${kind}`]),
  );
  assert.ok(used.length > 300, 'the scan finds the keys');
  for (const [file, key] of used) {
    assert.ok(Object.hasOwn(english, key), `${file}: ${key} is not in en.json`);
  }
});

test('t: placeholders filled, an unknown key comes back as it is, an unknown language is English', () => {
  assert.equal(t('fr', 'groups.confirmLeave', { name: 'Grimpeurs' }), 'Quitter Grimpeurs?');
  assert.equal(t('en', 'layout.logout', { name: undefined }), 'Log out ()', 'a missing value is empty, not "undefined"');
  assert.equal(t('fr', 'Something went wrong.'), 'Something went wrong.');
  assert.equal(t('xx', 'layout.settings'), 'Settings');
  assert.equal(t('fr', 'notices'), 'notices', 'a section is not a text');
  assert.equal(syncErrorText('fr', 'sync.httpStatus 404'), 'Le calendrier a répondu 404. Vérifiez que le lien est bien l\'adresse iCal secrète.');
  assert.equal(syncErrorText('fr', 'Could not reach that link.'), 'Could not reach that link.', 'saved before languages');
});

test('pickLanguage: my pick, then the cookie, then the browser, then English', () => {
  assert.equal(pickLanguage('fr', 'en', 'en-US'), 'fr');
  assert.equal(pickLanguage(null, 'fr', 'en-US'), 'fr');
  assert.equal(pickLanguage('xx', 'xx', 'de-DE,fr-CA;q=0.9,en;q=0.8'), 'fr', 'the first browser language we speak');
  assert.equal(pickLanguage(null, undefined, 'de-DE'), 'en');
  assert.equal(pickLanguage(null, undefined, undefined), 'en');
});

test('a page in French: lang attribute, texts, Quebec month names, the menu ticks Français', () => {
  const page = pollPage({ id: 3, name: 'Keven', lang: 'fr', path: '/polls/1' }, {
    poll: { id: 1, title: 'Souper' }, dates: ['2026-07-14'], members: [{ id: 3, name: 'Keven' }],
    votes: [], missing: [], complete: false, best: [], event: null,
  });
  assert.match(page, /<html lang="fr">/);
  assert.match(page, /<th class="">14 juill\. 2026<\/th>/);
  assert.match(page, /<button>Enregistrer mes réponses<\/button>/);
  assert.match(page, /<option value="maybe">peut-être<\/option>/);
  assert.match(page, /Se déconnecter \(Keven\)/);
  assert.match(page, /<input type="hidden" name="back" value="\/polls\/1">/);
  assert.match(page, /lang="fr" class="link" aria-current="true">Français<\/button>/);
  assert.doesNotMatch(page, /lang="en" class="link" aria-current/);
});

const addUser = (name, language = null) => run(`INSERT INTO users(name, password_hash, feed_token, created_at, language)
  VALUES (?, 'x', ?, ?, ?)`, name, 'tok-' + name, now(), language).lastInsertRowid;

/** Runs one route the way server.js would, as member `userId` (null: logged out); returns what it answered. */
async function request(method, path, { userId = null, body = {} } = {}) {
  const out = { cookies: {} };
  const url = new URL(path, 'http://x.test');
  const route = routes.find(r => r.method === method && r.path.test(url.pathname));
  await route.handler({
    ip: '127.0.0.1', url, params: url.pathname.match(route.path).groups || {}, lang: 'en',
    user: userId && auth.userFromSession(auth.createSession(userId)),
    body: new URLSearchParams(body),
    setCookie: (name, value) => { out.cookies[name] = value; },
    redirect: location => Object.assign(out, { status: 303, location }),
    fail: (status, message) => Object.assign(out, { status, message }),
    text: (text, status = 200) => Object.assign(out, { status, text }),
  });
  return out;
}

test('POST /language: saved on the account and in a cookie, back to the same page on this site', async () => {
  const ada = addUser('Ada');
  const picked = await request('POST', '/language', { userId: ada, body: { lang: 'fr', back: '/settings?msg=about' } });
  assert.deepEqual([picked.location, picked.cookies.lang], ['/settings?msg=about', 'fr']);
  assert.equal(get('SELECT language FROM users WHERE id = ?', ada).language, 'fr');

  const back = async to => (await request('POST', '/language', { body: { lang: 'en', back: to } })).location;
  assert.equal(await back('/login'), '/login', 'logged out: only the cookie');
  assert.equal(await back('/profile/about'), '/profile', 'a form\'s answer: the page above it');
  assert.equal(await back('/settings/calendars/rules'), '/settings');
  assert.equal(await back('/polls/7/visibility'), '/polls/7');
  for (const elsewhere of ['//evil.test/x', 'https://evil.test/', '/\\evil.test', 'javascript:alert(1)', undefined]) {
    assert.equal(await back(elsewhere), '/', `${elsewhere} stays on this site`);
  }
  assert.equal(get('SELECT language FROM users WHERE id = ?', ada).language, 'fr', 'logged-out picks change no account');

  const unknown = await request('POST', '/language', { userId: ada, body: { lang: 'xx', back: '/' } });
  assert.deepEqual([unknown.status, unknown.message, unknown.cookies.lang], [400, 'errors.invalidLanguage', undefined]);
});

test('the birthdays feed speaks its owner\'s language, English while they never picked one', async () => {
  run("UPDATE users SET birthday = '1990-05-17' WHERE name = 'Ada'"); // Ada picked French above
  addUser('Bob');
  assert.match((await request('GET', '/feed/tok-Ada/birthdays.ics')).text, /X-WR-CALNAME:Meshtime · Anniversaires/);
  assert.match((await request('GET', '/feed/tok-Ada/birthdays.ics')).text, /SUMMARY:🎉 Anniversaire : Ada/);
  assert.match((await request('GET', '/feed/tok-Bob/birthdays.ics')).text, /X-WR-CALNAME:Meshtime · Birthdays/);
});
