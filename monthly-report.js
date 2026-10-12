import { DEFAULT_SHIFT_ORDER } from './shift-order.js';
import { isRetiredMaterialColor } from './material-colors.js';

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const MONTH_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12) return false;
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatDate(value) {
  return DATE_FORMATTER.format(new Date(`${value}T12:00:00Z`));
}

function shouldIncludeReportRecord(record) {
  if (!record || typeof record !== 'object') return false;
  const material = String(record.material ?? '').trim();
  const color = String(record.color ?? '').trim();
  const quantity = Number(record.quantity ?? 0);

  if (isRetiredMaterialColor(material, color)) return false;
  if (color === '' && quantity === 0) return false;
  return true;
}

export function getMonthlyCalendarDates(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) {
    throw new Error('A valid month is required.');
  }
  const [year, monthNumber] = month.split('-').map(Number);
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Array.from({ length: dayCount }, (_, index) =>
    `${month}-${String(index + 1).padStart(2, '0')}`);
}

export function buildMonthlyDailyReport({ month, records, shiftOrder = DEFAULT_SHIFT_ORDER }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) {
    throw new Error('A valid month is required.');
  }
  if (!Array.isArray(records)) throw new Error('Monthly report records must be a list.');

  const [year, monthNumber] = month.split('-').map(Number);
  const dates = getMonthlyCalendarDates(month);
  const dayCount = dates.length;
  const grouped = new Map();
  const normalizedShiftOrder = Array.isArray(shiftOrder) && shiftOrder.length === 4 ? shiftOrder : DEFAULT_SHIFT_ORDER;
  const shiftPositions = new Map(normalizedShiftOrder.map((shift, index) => [shift, index]));

  records.forEach((record, index) => {
    const date = String(record?.date ?? '').slice(0, 10);
    if (!isCalendarDate(date) || date.slice(0, 7) !== month || !shouldIncludeReportRecord(record)) return;
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date).push({ record, index });
  });

  const days = Array.from(grouped, ([date, entries]) => ({
    date,
    dateLabel: formatDate(date),
    records: entries
      .sort((left, right) => {
        const leftPosition = shiftPositions.get(left.record.shift) ?? Number.MAX_SAFE_INTEGER;
        const rightPosition = shiftPositions.get(right.record.shift) ?? Number.MAX_SAFE_INTEGER;
        return leftPosition - rightPosition || left.index - right.index;
      })
      .map(({ record }) => record),
  })).sort((left, right) => left.date.localeCompare(right.date));

  const recordedDates = new Set(days.map((day) => day.date));
  const missingDates = dates
    .filter((date) => !recordedDates.has(date))
    .map((date) => ({ date, dateLabel: formatDate(date) }));

  const monthLabel = MONTH_FORMATTER.format(new Date(Date.UTC(year, monthNumber - 1, 1, 12)));
  return { month, monthLabel, dayCount, days, missingDates };
}
