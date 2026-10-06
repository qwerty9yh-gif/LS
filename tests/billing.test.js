import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthlyRevenue, formatCents, paginateInvoiceLines, parsePriceCents } from '../billing.js';
import { DEFAULT_MATERIAL_COLORS } from '../material-colors.js';

test('prices are parsed and formatted in exact cents', () => {
  assert.equal(parsePriceCents('12'), '1200');
  assert.equal(parsePriceCents('12.3'), '1230');
  assert.equal(parsePriceCents('12.34'), '1234');
  assert.equal(parsePriceCents(''), null);
  assert.equal(parsePriceCents('1.234'), null);
  assert.equal(parsePriceCents('-2'), null);
  assert.equal(formatCents('1234'), '12.34');
});

test('monthly revenue filters by month, groups records once, and uses active colors only', () => {
  const result = buildMonthlyRevenue({
    month: '2026-10',
    materialColors: DEFAULT_MATERIAL_COLORS,
    records: [
      { date: '2026-10-02', material: 'Shirts', color: 'White', quantity: 4 },
      { date: '2026-10-02', material: 'Shirts', color: 'White', quantity: 6 },
      { date: '2026-11-01', material: 'Shirts', color: 'White', quantity: 90 },
      { date: '2026-10-03', material: 'Towels', color: 'Blue', quantity: 10 },
    ],
    unitPrices: [
      { material: 'Shirts', color: 'White', unitPrice: '2.50' },
      { material: 'Towels', color: 'White', unitPrice: '3.00' },
    ],
  });

  const shirts = result.lines.find((line) => line.material === 'Shirts' && line.color === 'White');
  const towels = result.lines.find((line) => line.material === 'Towels' && line.color === 'White');
  assert.deepEqual(shirts, {
    material: 'Shirts', color: 'White', quantity: 10, unitPriceCents: '250', amountCents: '2500',
  });
  assert.equal(towels.quantity, 0);
  assert.equal(result.complete, true);
  assert.equal(result.grandTotalCents, '2500');
});

test('an active combination with quantity and no price is explicitly incomplete', () => {
  const result = buildMonthlyRevenue({
    month: '2026-10',
    materialColors: DEFAULT_MATERIAL_COLORS,
    records: [{ date: '2026-10-02', material: 'Trousers', color: 'Blue', quantity: 3 }],
    unitPrices: [],
  });
  assert.equal(result.complete, false);
  assert.equal(result.lines.find((line) => line.material === 'Trousers' && line.color === 'Blue').amountCents, null);
});

test('invoice line pagination reserves first-page letterhead space and keeps continuation pages bounded', () => {
  const invoice = {
    topSafeMm: 45,
    bottomSafeMm: 30,
    lineItems: Array.from({ length: 40 }, (_, index) => ({ item: `Item ${index}` })),
  };
  const pages = paginateInvoiceLines(invoice);
  assert.deepEqual(pages.map((page) => page.length), [8, 14, 14, 4]);
  assert.equal(pages.flat().length, invoice.lineItems.length);
  assert.deepEqual(paginateInvoiceLines({ ...invoice, lineItems: [] }), [[]]);
});
