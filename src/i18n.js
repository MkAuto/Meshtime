import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LANGUAGES, DEFAULT_LANGUAGE } from './lib.js';

// Every text the app shows, one JSON file per language in src/locales/ (LANGUAGES in lib.js), keys nested by page.
// English is the reference: a key another language lacks falls back to it, and test/i18n.test.js keeps every
// file complete. Templates read a whole dictionary ({{t.settings.title}}, src/views.js); code calls t().
const LOCALE_DIR = join(import.meta.dirname, 'locales');
const readLocale = code => JSON.parse(readFileSync(join(LOCALE_DIR, `${code}.json`), 'utf8'));

/** `over` laid on `base` key by key, nested objects too. Only base's keys are kept. */
const merge = (base, over = {}) => Object.fromEntries(Object.entries(base).map(([key, value]) =>
  [key, typeof value === 'object' ? merge(value, over[key]) : over[key] ?? value]));

const english = readLocale(DEFAULT_LANGUAGE);
export const LOCALES = Object.fromEntries(LANGUAGES.map(({ code }) =>
  [code, code === DEFAULT_LANGUAGE ? english : merge(english, readLocale(code))]));

/** Every text of `lang`, English for an unknown one: what templates get as `t`. */
export const dictionary = lang => LOCALES[lang] ?? LOCALES[DEFAULT_LANGUAGE];

/** The text at `key` ('settings.title') in `lang`, or undefined when there is none. */
const lookup = (lang, key) => {
  const text = key.split('.').reduce(
    (node, part) => (typeof node === 'object' && Object.hasOwn(node, part) ? node[part] : undefined), dictionary(lang));
  return typeof text === 'string' ? text : undefined;
};

/** Is `key` a text? For keys that come from outside, like ?msg= (notices). */
export const hasText = key => lookup(DEFAULT_LANGUAGE, key) !== undefined;

/**
 * The text at `key` in `lang`, its {{name}} placeholders filled from `values`. Plain text, unescaped: the template
 * that shows it escapes it. A key with no text comes back as it is, so a message that is not a key still shows.
 */
export function t(lang, key, values = {}) {
  const text = lookup(lang, key);
  return text === undefined ? key : text.replace(/\{\{(\w+)\}\}/g,
    (placeholder, name) => (Object.hasOwn(values, name) ? String(values[name] ?? '') : placeholder));
}

/**
 * A calendar_links.last_error as the member reads it. src/sync.js stores its own errors as a key, plus the HTTP
 * status for sync.httpStatus ('sync.httpStatus 404'); anything else (node-ical's own errors, rows saved before
 * languages existed) is shown as it is.
 */
export function syncErrorText(lang, error) {
  const [key, status] = error.split(' ');
  return hasText(key) ? t(lang, key, { status }) : error;
}
