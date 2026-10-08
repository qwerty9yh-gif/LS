import test from 'node:test';
import assert from 'node:assert/strict';
import { SHIFT_KEYS, normalizeShift, isValidFormDate, formExists, isShiftLocked } from '../server/forms.js';

test('shift storage keys are stable for PostgreSQL compatibility', () => {
  assert.deepEqual(SHIFT_KEYS, ['morning', 'afternoon', 'evening', 'night']);
});

test('straight day shift aliases normalize to the evening storage key', () => {
  for (const alias of ['straight', 'Straight', 'straight_day', 'straight-day', 'Straight Day Shift', 'straightdayshift']) {
    assert.equal(normalizeShift(alias), 'evening');
  }
});

test('known shift keys pass through unchanged', () => {
  assert.equal(normalizeShift('morning'), 'morning');
  assert.equal(normalizeShift('Afternoon'), 'afternoon');
  assert.equal(normalizeShift(' EVENING '), 'evening');
  assert.equal(normalizeShift('night'), 'night');
});

test('daily form dates must be valid calendar dates', () => {
  assert.equal(isValidFormDate('2026-09-19'), true);
  assert.equal(isValidFormDate('2026-13-01'), false);
  assert.equal(isValidFormDate('19-09-2026'), false);
  assert.equal(isValidFormDate(''), false);
  assert.equal(isValidFormDate(null), false);
});

test('duplicate detection sees both daily forms and existing records', () => {
  assert.equal(formExists([{ date: '2026-09-19' }], [], '2026-09-19'), true);
  assert.equal(formExists([], [{ date: '2026-09-20' }], '2026-09-20'), true);
  assert.equal(formExists([], [], '2026-09-21'), false);
  assert.equal(formExists([], [], 'not-a-date'), false);
});

test('only the explicitly closed date and shift are locked', () => {
  const locks = [{ date: '2026-09-18', shift: 'morning' }];
  assert.equal(isShiftLocked(locks, '2026-09-18', 'morning'), true);
  assert.equal(isShiftLocked(locks, '2026-09-18', 'afternoon'), false);
  assert.equal(isShiftLocked(locks, '2026-09-19', 'morning'), false);
  assert.equal(isShiftLocked([], '2026-09-18', 'morning'), false);
  assert.equal(isShiftLocked([{ date: new Date('2026-09-18T00:00:00.000Z'), shift: 'morning' }], '2026-09-18', 'morning'), true);
});
