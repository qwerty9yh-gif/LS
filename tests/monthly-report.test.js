import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthlyDailyReport, renderMonthlyDailyReportHtml } from '../monthly-report.js';

test('monthly report groups in calendar order, respects shift order, and identifies missing dates', () => {
  const report = buildMonthlyDailyReport({
    month: '2026-07',
    shiftOrder: ['night', 'morning', 'afternoon', 'evening'],
    records: [
      { date: '2026-07-05', shift: 'morning', material: 'Trousers' },
      { date: '2026-07-01', shift: 'morning', material: 'Shirts' },
      { date: '2026-07-01', shift: 'night', material: 'Towels' },
      { date: '2026-08-01', shift: 'morning', material: 'Outside month' },
    ],
  });

  assert.equal(report.dayCount, 31);
  assert.deepEqual(report.days.map(({ date }) => date), ['2026-07-01', '2026-07-05']);
  assert.deepEqual(report.days[0].records.map(({ material }) => material), ['Towels', 'Shirts']);
  assert.equal(report.missingDates.length, 29);
  assert.deepEqual(report.missingDates.slice(0, 2).map(({ date }) => date), ['2026-07-02', '2026-07-03']);
});

test('month day counts handle leap February and 30-day months', () => {
  assert.equal(buildMonthlyDailyReport({ month: '2024-02', records: [] }).dayCount, 29);
  assert.equal(buildMonthlyDailyReport({ month: '2026-02', records: [] }).dayCount, 28);
  assert.equal(buildMonthlyDailyReport({ month: '2026-04', records: [] }).dayCount, 30);
  assert.equal(buildMonthlyDailyReport({ month: '2026-01', records: [] }).dayCount, 31);
});

test('an empty month returns all dates as missing and the renderer explains no records', () => {
  const report = buildMonthlyDailyReport({ month: '2026-02', records: [] });
  const html = renderMonthlyDailyReportHtml({ report, logoUrl: '/brand-logo.png' });

  assert.equal(report.days.length, 0);
  assert.equal(report.missingDates.length, 28);
  assert.match(html, /No records were found for February 2026/);
  assert.match(html, /February 28, 2026 — No records entered\./);
});

test('HTML repeats the date and column headings in table headers and escapes long cell text', () => {
  const longPersonnel = `Laundry <Personnel> ${'name '.repeat(100)}`;
  const report = buildMonthlyDailyReport({
    month: '2026-07',
    records: Array.from({ length: 31 }, (_, index) => ({
      date: `2026-07-${String(index + 1).padStart(2, '0')}`,
      shift: 'evening',
      material: index === 0 ? 'Table Clothes' : 'Trousers',
      color: index === 0 ? 'Blue & White' : 'White',
      quantity: 4,
      laundryPersonnel: index === 0 ? longPersonnel : 'Laundry staff',
      signature: 'A. Person',
      verifiedBy: 'Supervisor',
      status: 'received',
    })),
  });
  const html = renderMonthlyDailyReportHtml({
    report,
    companyName: 'MK Business Company Ltd.',
    logoUrl: '/brand-logo.png',
  });

  assert.match(html, /<thead>/);
  assert.match(html, /July 1, 2026 — Daily Laundry Records/);
  assert.match(html, /display: table-header-group/);
  assert.match(html, /break-before: page/);
  assert.match(html, /Laundry &lt;Personnel&gt;/);
  assert.match(html, /Blue &amp; White/);
  assert.match(html, /brand-logo\.png/);
  assert.match(html, /All dates in this month have recorded entries/);
});

test('invalid month values are rejected', () => {
  assert.throws(() => buildMonthlyDailyReport({ month: '2026-13', records: [] }), /valid month/);
  assert.throws(() => buildMonthlyDailyReport({ month: '2026-02', records: {} }), /records must be a list/);
});
