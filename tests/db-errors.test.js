import test from 'node:test';
import assert from 'node:assert/strict';
import { isDbConnectionError, withDbRetry } from '../server/db-errors.js';

test('detects the Supavisor tenant/user not found error', () => {
  assert.equal(isDbConnectionError(new Error('(ENOTFOUND) tenant/user postgres.abc not found')), true);
  assert.equal(isDbConnectionError(new Error('column "color" does not exist')), false);
});

test('withDbRetry retries connection errors then succeeds', async () => {
  let calls = 0;
  const result = await withDbRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error('(ENOTFOUND) tenant/user postgres.abc not found');
    return 'ok';
  }, { delayMs: 1 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withDbRetry does not retry non-connection errors', async () => {
  let calls = 0;
  await assert.rejects(withDbRetry(async () => { calls += 1; throw new Error('syntax error'); }, { delayMs: 1 }));
  assert.equal(calls, 1);
});
