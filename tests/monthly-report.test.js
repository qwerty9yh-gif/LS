import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthlyDailyReport } from '../monthly-report.js';
import { jsPDF } from 'jspdf';
import {
  createDailyMonthlyReportPdf,
  createDailyRegisterPdf,
  createInvoicePdf,
  createMonthlyRevenuePdf,
  createPdfFilename,
  savePdfFile,
} from '../pdf-reports.js';

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

test('an empty month reports every missing date and creates a valid branded PDF', () => {
  const report = buildMonthlyDailyReport({ month: '2026-02', records: [] });
  const doc = createDailyMonthlyReportPdf({
    jsPDF, report, companyName: 'MK Business Company Ltd.',
  });
  const bytes = Buffer.from(doc.output('arraybuffer'));
  const pdf = bytes.toString('latin1');

  assert.equal(report.days.length, 0);
  assert.equal(report.missingDates.length, 28);
  assert.equal(report.monthLabel, 'February 2026');
  assert.match(pdf, /%PDF-/);
  assert.match(pdf, /No records were found for this month/);
  assert.match(pdf, /Monthly Dates Without Records/);
  assert.match(pdf, /No records entered/);
  assert.equal(doc.getNumberOfPages(), 2);
});

test('daily report PDFs include branded data and repeat date/table headings on overflow pages', () => {
  const longPersonnel = `Laundry Personnel ${'name '.repeat(100)}`;
  const report = buildMonthlyDailyReport({
    month: '2026-07',
    records: Array.from({ length: 90 }, (_, index) => ({
      date: `2026-07-${index < 80 ? '01' : '04'}`,
      shift: 'evening',
      material: 'Table Clothes',
      color: 'Blue and White',
      quantity: 4,
      laundryPersonnel: longPersonnel,
      signature: 'A. Person',
      verifiedBy: 'Supervisor',
      status: 'received',
    })),
  });
  const doc = createDailyMonthlyReportPdf({
    jsPDF,
    report,
    companyName: 'MK Business Company Ltd.',
  });
  const pdf = Buffer.from(doc.output('arraybuffer')).toString('latin1');

  assert.ok(doc.getNumberOfPages() > 3);
  assert.match(pdf, /MK Business Company Ltd/);
  assert.match(pdf, /July 2026 Day-by-Day Laundry Summary/);
  assert.match(pdf, /July 1, 2026 - Daily Laundry Records/);
  assert.match(pdf, /July 4, 2026 - Daily Laundry Records/);
  assert.match(pdf, /Name \/ Signature/);
  assert.match(pdf, /Monthly Dates Without Records/);
  assert.equal(createPdfFilename(null, '2026-09'), 'Laundry_Revenue_Report_September_2026.pdf');
  assert.equal(createPdfFilename(report), 'Laundry_Daily_Monthly_Report_July_2026.pdf');
});

test('monthly revenue PDFs contain the provided summary data and totals', () => {
  const doc = createMonthlyRevenuePdf({
    jsPDF,
    month: '2026-09',
    revenue: {
      month: '2026-09',
      lines: [{
        material: 'Trousers', color: 'White', quantity: 17,
        unitPriceCents: '250', amountCents: '4250',
      }],
      grandTotalCents: '4250',
      complete: true,
    },
    companyName: 'MK Laundry',
  });
  const pdf = Buffer.from(doc.output('arraybuffer')).toString('latin1');

  assert.match(pdf, /Monthly Laundry Revenue Report/);
  assert.match(pdf, /September 2026/);
  assert.match(pdf, /Trousers/);
  assert.match(pdf, /17/);
  assert.match(pdf, /42\.50/);
  assert.match(pdf, /%PDF-/);
});

test('long PDF table cells continue across pages without losing their trailing content', () => {
  const longMaterial = `${'Long Material '.repeat(800)}ZEBRA_END`;
  const revenueDoc = createMonthlyRevenuePdf({
    jsPDF,
    month: '2026-09',
    revenue: {
      month: '2026-09',
      lines: [{
        material: longMaterial, color: 'White', quantity: 17,
        unitPriceCents: '250', amountCents: '4250',
      }],
      grandTotalCents: '4250',
      complete: true,
    },
  });
  const invoiceDoc = createInvoicePdf({
    jsPDF,
    invoice: {
      invoiceNumber: 'INV-202609-000123',
      month: '2026-09',
      lineItems: [{
        item: longMaterial, color: 'White', quantity: 8,
        unitPriceCents: '250', amountCents: '2000',
      }],
      grandTotalCents: '2000',
    },
  });

  for (const doc of [revenueDoc, invoiceDoc]) {
    const pdf = Buffer.from(doc.output('arraybuffer')).toString('latin1');
    assert.ok(doc.getNumberOfPages() > 1);
    assert.match(pdf, /ZEBRA_END/);
    assert.match(pdf, /Continued/);
  }
});

test('daily register print documents contain actual records, and empty dates state that no records exist', () => {
  const record = {
    date: '2026-09-05',
    shift: 'morning',
    material: 'Trousers',
    color: 'White',
    quantity: 8,
    laundryPersonnel: 'Laundry Staff',
    signature: 'A Person',
    verifiedBy: 'Supervisor',
    status: 'received',
  };
  const populated = createDailyRegisterPdf({
    jsPDF,
    date: record.date,
    records: [record],
  });
  const empty = createDailyRegisterPdf({
    jsPDF,
    date: record.date,
    records: [],
  });
  const populatedText = Buffer.from(populated.output('arraybuffer')).toString('latin1');
  const emptyText = Buffer.from(empty.output('arraybuffer')).toString('latin1');

  assert.match(populatedText, /Trousers/);
  assert.match(populatedText, /Laundry Staff/);
  assert.match(populatedText, /Verified By/);
  assert.match(emptyText, /No records are available for September 5, 2026/);
});

test('invoice PDF preserves invoice number, recipient, line items, and saved total', () => {
  const doc = createInvoicePdf({
    jsPDF,
    invoice: {
      invoiceNumber: 'INV-202609-000123',
      month: '2026-09',
      generatedAt: '2026-10-01T12:00:00.000Z',
      billTo: { recipientName: 'Laundry Customer', companyName: 'Customer Ltd.' },
      lineItems: [{
        item: 'Trousers', color: 'White', quantity: 8,
        unitPriceCents: '250', amountCents: '2000',
      }],
      grandTotalCents: '2000',
    },
  });
  const pdf = Buffer.from(doc.output('arraybuffer')).toString('latin1');

  assert.match(pdf, /INV-202609-000123/);
  assert.match(pdf, /Laundry Customer/);
  assert.match(pdf, /Trousers/);
  assert.match(pdf, /20\.00/);
});

test('PDF file saving shares on supported devices and falls back to an in-app download', async () => {
  const doc = createMonthlyRevenuePdf({
    jsPDF,
    month: '2026-09',
    revenue: { lines: [], grandTotalCents: '0', complete: true },
  });
  let sharedFile;
  const result = await savePdfFile(doc, 'report.pdf', {
    navigatorObject: {
      canShare: ({ files }) => files.length === 1 && files[0].type === 'application/pdf',
      share: async ({ files }) => { [sharedFile] = files; },
    },
  });
  assert.equal(result, 'shared');
  assert.equal(sharedFile.name, 'report.pdf');

  let downloaded;
  let revoked;
  const fakeDocument = {
    body: { appendChild: (link) => { downloaded = link; } },
    createElement: () => ({
      click() {},
      remove() {},
      style: {},
    }),
  };
  await savePdfFile(doc, 'report.pdf', {
    navigatorObject: {},
    documentObject: fakeDocument,
    urlObject: {
      createObjectURL: (blob) => {
        assert.equal(blob.type, 'application/pdf');
        return 'blob:laundry-report';
      },
      revokeObjectURL: (url) => { revoked = url; },
    },
    schedule: (callback) => callback(),
  });
  assert.equal(downloaded.href, 'blob:laundry-report');
  assert.equal(downloaded.download, 'report.pdf');
  assert.equal(revoked, 'blob:laundry-report');
});

test('invalid month values are rejected', () => {
  assert.throws(() => buildMonthlyDailyReport({ month: '2026-13', records: [] }), /valid month/);
  assert.throws(() => buildMonthlyDailyReport({ month: '2026-02', records: {} }), /records must be a list/);
});
