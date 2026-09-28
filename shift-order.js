export const SHIFT_KEYS = Object.freeze(['morning', 'afternoon', 'evening', 'night']);
export const DEFAULT_SHIFT_ORDER = Object.freeze(['night', 'afternoon', 'evening', 'morning']);

export function normalizeShiftOrder(order) {
  const seen = new Set();
  const normalized = [];
  for (const key of Array.isArray(order) ? order : []) {
    if (SHIFT_KEYS.includes(key) && !seen.has(key)) {
      seen.add(key);
      normalized.push(key);
    }
  }
  return normalized.concat(DEFAULT_SHIFT_ORDER.filter((key) => !seen.has(key)));
}

export function isCompleteShiftOrder(order) {
  return Array.isArray(order)
    && order.length === SHIFT_KEYS.length
    && new Set(order).size === SHIFT_KEYS.length
    && order.every((key) => SHIFT_KEYS.includes(key));
}

export function moveShift(order, key, offset) {
  const next = normalizeShiftOrder(order);
  const from = next.indexOf(key);
  const to = Math.max(0, Math.min(next.length - 1, from + offset));
  if (from < 0 || from === to) return next;
  next.splice(from, 1);
  next.splice(to, 0, key);
  return next;
}

export function placeShift(order, movingKey, targetKey, after = false) {
  const next = normalizeShiftOrder(order);
  const from = next.indexOf(movingKey);
  const target = next.indexOf(targetKey);
  if (from < 0 || target < 0 || from === target) return next;
  next.splice(from, 1);
  const adjustedTarget = next.indexOf(targetKey);
  next.splice(adjustedTarget + (after ? 1 : 0), 0, movingKey);
  return next;
}