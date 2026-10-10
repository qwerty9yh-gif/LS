const DEFAULT_SHIFT_ORDER = ['morning', 'afternoon', 'evening', 'night'];
const SHIFT_LABELS = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Straight Day',
  night: 'Night',
};
const STATUS_LABELS = {
  received: 'Received',
  pending: 'Pending Dispatch',
  dispatched: 'Dispatched',
};
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
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

function formatDate(value) {
  return DATE_FORMATTER.format(new Date(`${value}T12:00:00Z`));
}

function dateInMonth(value, month) {
  const date = String(value ?? '').slice(0, 10);
  return isCalendarDate(date) && date.slice(0, 7) === month ? date : null;
}

function shiftLabel(shift) {
  return SHIFT_LABELS[shift] || String(shift || '—').replace(/[-_]/g, ' ');
}

export function buildMonthlyDailyReport({ month, records, shiftOrder = DEFAULT_SHIFT_ORDER }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) {
    throw new Error('A valid month is required.');
  }
  if (!Array.isArray(records)) throw new Error('Monthly report records must be a list.');

  const [year, monthNumber] = month.split('-').map(Number);
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const grouped = new Map();
  const shiftPositions = new Map(shiftOrder.map((shift, index) => [shift, index]));

  records.forEach((record, index) => {
    const date = dateInMonth(record?.date, month);
    if (!date) return;
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
  const missingDates = Array.from({ length: dayCount }, (_, index) => {
    const day = String(index + 1).padStart(2, '0');
    return `${month}-${day}`;
  }).filter((date) => !recordedDates.has(date))
    .map((date) => ({ date, dateLabel: formatDate(date) }));

  const monthLabel = MONTH_FORMATTER.format(new Date(Date.UTC(year, monthNumber - 1, 1, 12)));
  return { month, monthLabel, dayCount, days, missingDates };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[char]));
}

function displayValue(value) {
  return value === null || value === undefined || String(value).trim() === ''
    ? '—'
    : String(value);
}

function renderRecordRow(record) {
  const personnel = displayValue(record.laundryPersonnel);
  const signature = displayValue(record.signature);
  return `
    <tr>
      <td>${escapeHtml(`${record.date?.slice(0, 10) || '—'} · ${shiftLabel(record.shift)}`)}</td>
      <td>${escapeHtml(displayValue(record.material))}</td>
      <td>${escapeHtml(displayValue(record.color))}</td>
      <td class="quantity">${escapeHtml(displayValue(record.quantity))}</td>
      <td>Name: ${escapeHtml(personnel)}<br>Signature: ${escapeHtml(signature)}</td>
      <td>${escapeHtml(displayValue(record.verifiedBy))}</td>
      <td>${escapeHtml(STATUS_LABELS[record.status] || displayValue(record.status))}</td>
    </tr>`;
}

export function renderMonthlyDailyReportHtml({
  report,
  companyName = 'MK Business Company Ltd.',
  companyInfo = {},
  logoUrl,
}) {
  const name = displayValue(companyName) === '—' ? 'MK Business Company Ltd.' : companyName;
  const companyDetails = [
    companyInfo.poBox && `P.O. Box ${companyInfo.poBox}`,
    companyInfo.address,
    companyInfo.phone,
    companyInfo.email,
  ].filter(Boolean);
  const identity = logoUrl
    ? `<img class="brand-logo" src="${escapeHtml(logoUrl)}" alt="${escapeHtml(name)}">`
    : '';
  const dailySections = report.days.map((day, index) => `
    <section class="daily-section${index ? ' next-day' : ''}" aria-label="${escapeHtml(day.dateLabel)} records">
      <table class="daily-table">
        <thead>
          <tr class="day-heading"><th colspan="7">${escapeHtml(day.dateLabel)} — Daily Laundry Records</th></tr>
          <tr>
            <th>Date / Shift</th>
            <th>Material</th>
            <th>Color</th>
            <th>Quantity</th>
            <th>Name &amp; Signature — Laundry Personnel</th>
            <th>Verified By</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${day.records.map(renderRecordRow).join('')}</tbody>
      </table>
    </section>`).join('');
  const emptyMonthMessage = report.days.length
    ? ''
    : `<p class="empty-month">No records were found for ${escapeHtml(report.monthLabel)}.</p>`;
  const missingDates = report.missingDates.length
    ? `<ul>${report.missingDates.map(({ dateLabel }) =>
      `<li>${escapeHtml(dateLabel)} — No records entered.</li>`).join('')}</ul>`
    : '<p>All dates in this month have recorded entries.</p>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(report.monthLabel)} Day-by-Day Laundry Summary</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; color: #17304d; font: 10pt "Avenir Next", "Segoe UI", Arial, sans-serif; }
    .report-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 20px; background: #edf3ff; }
    .report-toolbar button { border: 1px solid #083681; border-radius: 6px; padding: 10px 14px; background: #0c45b8; color: white; font: inherit; font-weight: 700; cursor: pointer; }
    .report-content { padding: 12mm; }
    .report-brand { display: flex; align-items: center; gap: 14px; padding-bottom: 8mm; border-bottom: 3px solid #f1dd26; }
    .brand-logo { width: 42mm; max-height: 22mm; object-fit: contain; }
    .brand-copy h1 { margin: 0 0 3mm; color: #0c45b8; font-size: 19pt; }
    .brand-copy h2 { margin: 0; color: #17304d; font-size: 15pt; }
    .company-details { margin-top: 2mm; color: #65738a; font-size: 8pt; }
    .daily-section { margin-top: 7mm; }
    .daily-section.next-day { break-before: page; page-break-before: always; margin-top: 0; }
    .daily-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 8pt; }
    .daily-table thead { display: table-header-group; }
    .daily-table tr { break-inside: avoid; page-break-inside: avoid; }
    .daily-table th, .daily-table td { border: 1px solid #8d9caf; padding: 5px 4px; vertical-align: top; text-align: left; overflow-wrap: anywhere; }
    .daily-table th { background: #edf3ff; color: #17304d; font-size: 7.5pt; }
    .daily-table .day-heading th { padding: 8px 6px; background: #0c45b8; color: #fff; font-size: 11pt; }
    .daily-table th:nth-child(1) { width: 16%; }
    .daily-table th:nth-child(2) { width: 12%; }
    .daily-table th:nth-child(3) { width: 11%; }
    .daily-table th:nth-child(4) { width: 9%; }
    .daily-table th:nth-child(5) { width: 24%; }
    .daily-table th:nth-child(6) { width: 15%; }
    .daily-table th:nth-child(7) { width: 13%; }
    .quantity { text-align: right !important; font-variant-numeric: tabular-nums; }
    .empty-month { margin-top: 12mm; padding: 10mm; border: 1px solid #d9e1ed; background: #f8fbff; font-size: 13pt; }
    .missing-page { break-before: page; page-break-before: always; }
    .missing-page h2 { margin: 0 0 8mm; padding-bottom: 4mm; border-bottom: 3px solid #f1dd26; color: #0c45b8; font-size: 17pt; }
    .missing-page li { margin: 0 0 4mm; }
    @page { size: A4 portrait; margin: 12mm; }
    @media print {
      .report-toolbar { display: none; }
      .report-content { padding: 0; }
      .report-brand { break-after: avoid; page-break-after: avoid; }
      .daily-section { break-inside: auto; page-break-inside: auto; }
      .daily-section:first-of-type { margin-top: 7mm; }
      .daily-table { font-size: 8pt; }
      .daily-table th, .daily-table td { padding: 4px 3px; }
      .daily-table thead { display: table-header-group; }
      .missing-page { break-before: page; page-break-before: always; }
    }
  </style>
</head>
<body>
  <div class="report-toolbar">
    <span>Print-ready A4 report · ${escapeHtml(report.monthLabel)}</span>
    <button type="button" onclick="window.print()">Print / Save as PDF</button>
  </div>
  <main class="report-content">
    <header class="report-brand">
      ${identity}
      <div class="brand-copy">
        <h1>${escapeHtml(name)}</h1>
        <h2>${escapeHtml(report.monthLabel)} Day-by-Day Laundry Summary</h2>
        ${companyDetails.length ? `<p class="company-details">${companyDetails.map(escapeHtml).join(' · ')}</p>` : ''}
      </div>
    </header>
    ${emptyMonthMessage}
    ${dailySections}
    <section class="missing-page" aria-labelledby="missing-records-title">
      <h2 id="missing-records-title">Monthly Dates Without Records</h2>
      ${missingDates}
    </section>
  </main>
</body>
</html>`;
}
