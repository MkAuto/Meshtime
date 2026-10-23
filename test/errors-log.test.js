import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DATA_DIR is read once when db.js loads: point it at a temp folder first, so the real data/ is never written.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'meshtime-')), 'app.db');
const { ERROR_LOG_PATH } = await import('../src/log.js');

test('console.error and console.warn also land in errors.log, with the stack and its cause', t => {
  t.mock.method(process.stderr, 'write', () => true); // keep the test output clean
  console.error('Request failed: GET /x', { ip: '::1' }, new Error('outer', { cause: new Error('inner') }));
  console.warn('just a warning');
  t.mock.restoreAll();

  const log = readFileSync(ERROR_LOG_PATH, 'utf8');
  assert.match(log, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d-0[45]:00 ERROR\n/, 'header: time with offset, level');
  assert.match(log, /Request failed: GET \/x \{ ip: '::1' \} Error: outer/);
  assert.match(log, /at .*errors-log\.test\.js/, 'the stack trace is kept');
  assert.match(log, /\[cause\]: Error: inner/, 'so is the cause');
  assert.match(log, /WARN\njust a warning\n\n$/);
});
