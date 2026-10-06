import { isRetiredMaterialColor, normalizeMaterialColors } from './material-colors.js';

export function parsePriceCents(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))).toString();
}

export function formatCents(value) {
  const cents = BigInt(value || 0);
  const whole = cents / 100n;
  const fraction = String(cents % 100n).padStart(2, '0');
  return `${whole}.${fraction}`;
}

export function buildMonthlyRevenue({ records, materialColors, unitPrices, month }) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw new Error('A valid month is required.');

  const totals = new Map();
  for (const record of records) {
    const recordDate = String(record.date || '').slice(0, 10);
    if (recordDate.slice(0, 7) !== month || isRetiredMaterialColor(record.material, record.color)) continue;
    const quantity = Number(record.quantity || 0);
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('Record quantities must be non-negative integers.');
    const key = `${record.material}\u0000${record.color}`;
    totals.set(key, (totals.get(key) || 0) + quantity);
  }

  const prices = new Map(unitPrices.map((price) => [
    `${price.material}\u0000${price.color}`,
    parsePriceCents(price.unitPrice ?? price.price),
  ]));
  let grandTotalCents = 0n;
  let missingPrices = false;
  const lines = normalizeMaterialColors(materialColors).map(({ material, label: color }) => {
    const key = `${material}\u0000${color}`;
    const quantity = totals.get(key) || 0;
    const unitPriceCents = prices.get(key) ?? null;
    const amountCents = unitPriceCents === null ? (quantity === 0 ? '0' : null)
      : (BigInt(quantity) * BigInt(unitPriceCents)).toString();
    if (amountCents === null) missingPrices = true;
    else grandTotalCents += BigInt(amountCents);
    return {
      material,
      color,
      quantity,
      unitPriceCents,
      amountCents,
    };
  });

  return {
    month,
    lines,
    grandTotalCents: grandTotalCents.toString(),
    complete: !missingPrices,
  };
}

export function paginateInvoiceLines(invoice) {
  const lines = Array.isArray(invoice.lineItems) ? invoice.lineItems : [];
  const topSafeMm = Number(invoice.topSafeMm) || 0;
  const bottomSafeMm = Number(invoice.bottomSafeMm) || 0;
  const firstPageCapacity = Math.max(1, Math.floor((297 - topSafeMm - bottomSafeMm - 125) / 12));
  const remainder = lines.slice(firstPageCapacity);
  const pages = [lines.slice(0, firstPageCapacity)];
  while (remainder.length) pages.push(remainder.splice(0, 14));
  return pages;
}
