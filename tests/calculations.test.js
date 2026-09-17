import test from 'node:test';
import assert from 'node:assert/strict';

function summarize(records) {
  const grouped = new Map();
  for (const record of records) {
    const row = grouped.get(record.material) || { received: 0, pending: 0, dispatched: 0, available: 0, total: 0 };
    row[record.status] += record.quantity;
    row.total += record.quantity;
    row.available = row.received - row.dispatched;
    grouped.set(record.material, row);
  }
  return grouped;
}

test('tracking totals come from real row status quantities', () => {
  const rows = summarize([
    { material: 'Shirts', quantity: 20, status: 'received' },
    { material: 'Shirts', quantity: 5, status: 'dispatched' },
    { material: 'Towels', quantity: 8, status: 'pending' }
  ]);

  assert.equal(rows.get('Shirts').received, 20);
  assert.equal(rows.get('Shirts').dispatched, 5);
  assert.equal(rows.get('Shirts').available, 15);
  assert.equal(rows.get('Towels').pending, 8);
});
