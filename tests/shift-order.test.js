import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SHIFT_ORDER, isCompleteShiftOrder, moveShift, normalizeShiftOrder, placeShift } from '../shift-order.js';

test('the initial order matches the current daily register', () => {
  assert.deepEqual(DEFAULT_SHIFT_ORDER, ['night', 'afternoon', 'evening', 'morning']);
});

test('normalization removes invalid and duplicate keys and keeps all shifts', () => {
  assert.deepEqual(normalizeShiftOrder(['morning', 'morning', 'unknown']), [
    'morning', 'night', 'afternoon', 'evening'
  ]);
});

test('moveShift supports bounded up and down moves', () => {
  assert.deepEqual(moveShift(DEFAULT_SHIFT_ORDER, 'night', 1), ['afternoon', 'night', 'evening', 'morning']);
  assert.deepEqual(moveShift(DEFAULT_SHIFT_ORDER, 'morning', 1), DEFAULT_SHIFT_ORDER);
});

test('placeShift moves before or after any target', () => {
  assert.deepEqual(placeShift(DEFAULT_SHIFT_ORDER, 'night', 'afternoon', true), [
    'afternoon', 'night', 'evening', 'morning'
  ]);
  assert.deepEqual(placeShift(DEFAULT_SHIFT_ORDER, 'morning', 'night'), [
    'morning', 'night', 'afternoon', 'evening'
  ]);
});

test('API order validation accepts only a complete permutation', () => {
  assert.equal(isCompleteShiftOrder(DEFAULT_SHIFT_ORDER), true);
  assert.equal(isCompleteShiftOrder(['morning', 'morning', 'evening', 'night']), false);
  assert.equal(isCompleteShiftOrder(['morning', 'afternoon', 'evening']), false);
});