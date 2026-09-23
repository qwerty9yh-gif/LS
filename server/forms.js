// Shared daily-form + shift helpers (imported by server/index.js and tests).
// The third shift's STORAGE key stays 'evening' so existing PostgreSQL rows,
// locks and cached clients keep working — only the user-facing label changed
// to "Shift 3 (Straight Day Shift)".

export const SHIFT_KEYS = ['morning', 'afternoon', 'evening', 'night'];

export function normalizeShift(value) {
  const cleaned = String(value ?? '').trim().toLowerCase();
  const compact = cleaned.replace(/[\s_\-]+/g, '');
  if (compact === 'straight' || compact === 'straightday' || compact === 'straightdayshift') {
    return 'evening';
  }
  return cleaned;
}

export function isValidFormDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return false;
  return !Number.isNaN(new Date(`${value}T12:00:00`).getTime());
}

export function formExists(dailyForms, records, date) {
  if (!isValidFormDate(date)) return false;
  if (Array.isArray(dailyForms) && dailyForms.some((form) => form && form.date === date)) return true;
  return Array.isArray(records) && records.some((record) => record && record.date === date);
}
