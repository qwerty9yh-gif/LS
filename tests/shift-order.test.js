import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SHIFT_ORDER, isCompleteShiftOrder, moveShift, normalizeShiftOrder, placeShift } from '../shift-order.js';

test('the standard order is Night, Morning, Straight Day, Afternoon', () => {
  assert.deepEqual(DEFAULT_SHIFT_ORDER, ['night', 'morning', 'evening', 'afternoon']);
});

test('normalization ignores stored custom ordering', () => {
  assert.deepEqual(normalizeShiftOrder(['afternoon', 'morning', 'night', 'evening']), DEFAULT_SHIFT_ORDER);
});

test('shift order cannot be changed by local reordering helpers', () => {
  assert.deepEqual(moveShift(DEFAULT_SHIFT_ORDER, 'night', 1), DEFAULT_SHIFT_ORDER);
  assert.deepEqual(moveShift(DEFAULT_SHIFT_ORDER, 'morning', 1), DEFAULT_SHIFT_ORDER);
  assert.deepEqual(placeShift(DEFAULT_SHIFT_ORDER, 'morning', 'night'), DEFAULT_SHIFT_ORDER);
});

test('API order validation accepts only a complete permutation', () => {
  assert.equal(isCompleteShiftOrder(DEFAULT_SHIFT_ORDER), true);
  assert.equal(isCompleteShiftOrder(['morning', 'morning', 'evening', 'night']), false);
  assert.equal(isCompleteShiftOrder(['morning', 'afternoon', 'evening']), false);
});