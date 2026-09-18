import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../server/auth.js';

test('scrypt hash verifies the correct password', () => {
  const stored = hashPassword('123456789');
  assert.match(stored, /^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(verifyPassword('123456789', stored), true);
});

test('wrong password is rejected', () => {
  const stored = hashPassword('123456789');
  assert.equal(verifyPassword('wrong-password', stored), false);
  assert.equal(verifyPassword('', stored), false);
});

test('stored hash never contains the plain-text password', () => {
  const stored = hashPassword('super-secret-password');
  assert.ok(!stored.includes('super-secret-password'));
});

test('malformed stored hash is rejected safely', () => {
  assert.equal(verifyPassword('123456789', 'garbage'), false);
  assert.equal(verifyPassword('123456789', 'plaintext:abc'), false);
});
