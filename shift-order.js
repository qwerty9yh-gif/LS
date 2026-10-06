export const SHIFT_KEYS = Object.freeze(['morning', 'afternoon', 'evening', 'night']);
export const DEFAULT_SHIFT_ORDER = Object.freeze(['night', 'morning', 'evening', 'afternoon']);

export function normalizeShiftOrder(order) {
  return [...DEFAULT_SHIFT_ORDER];
}

export function isCompleteShiftOrder(order) {
  return Array.isArray(order)
    && order.length === SHIFT_KEYS.length
    && new Set(order).size === SHIFT_KEYS.length
    && order.every((key) => SHIFT_KEYS.includes(key));
}

export function moveShift() {
  return [...DEFAULT_SHIFT_ORDER];
}

export function placeShift() {
  return [...DEFAULT_SHIFT_ORDER];
}