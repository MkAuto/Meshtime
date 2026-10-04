import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profilePage } from '../src/views.js';

test('profilePage: a rejected form keeps what was typed and opens the panel holding the error', () => {
  const user = { id: 1, name: 'Ada', color: 2, birthday: null, date_format: undefined };
  const page = profilePage(user, {
    passkeys: [],
    errors: { birthday: 'Invalid date.', password: 'Too short.' },
    about: { name: 'Ada L', birthday: '2999-01-01', color: 5 },
  });
  assert.match(page, /value="Ada L"/);
  assert.match(page, /aria-label="Birthday">\s*<p class="err">Invalid date\.<\/p>/);
  assert.match(page, /value="5" aria-label="Color"/);
  assert.match(page, /<details class="panel panel-security" open data-remember="profile-security">/);
  assert.match(page, /autocomplete="new-password">\s*<\/label>\s*<p class="err">Too short\.<\/p>/);
});

test('profilePage: the privacy radio matches the account, private by default', () => {
  const user = { id: 1, name: 'Ada', color: 2, birthday: null };
  assert.match(profilePage({ ...user, is_private: 1 }, { passkeys: [] }), /value="private" checked>/);
  assert.match(profilePage({ ...user, is_private: 0 }, { passkeys: [] }), /value="public" checked>/);
});
