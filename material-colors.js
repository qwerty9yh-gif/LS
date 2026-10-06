export const MATERIAL_LABELS = Object.freeze([
  'Shirts',
  'Trousers',
  'Overcoats',
  'Towels',
  'Table Clothes',
  'Bed Sheets',
]);

export const RETIRED_MATERIAL_COLORS = Object.freeze([
  { material: 'Bed Sheets', label: 'Blue' },
  { material: 'Bed Sheets', label: 'Cream' },
  { material: 'Bed Sheets', label: 'Green' },
  { material: 'Table Clothes', label: 'Blue' },
  { material: 'Table Clothes', label: 'Cream' },
  { material: 'Towels', label: 'Blue' },
  { material: 'Towels', label: 'Green' },
  { material: 'Towels', label: 'Yellow' },
]);

const retiredMaterialColorKeys = new Set(RETIRED_MATERIAL_COLORS.map(({ material, label }) =>
  `${material}\u0000${label.toLocaleLowerCase()}`));

export function isRetiredMaterialColor(material, label) {
  return retiredMaterialColorKeys.has(`${String(material || '').trim()}\u0000${String(label || '').trim().toLocaleLowerCase()}`);
}

export const DEFAULT_MATERIAL_COLORS = Object.freeze([
  { material: 'Shirts', label: 'White', displayOrder: 1 },
  { material: 'Shirts', label: 'Blue', displayOrder: 2 },
  { material: 'Shirts', label: 'Brown', displayOrder: 3 },
  { material: 'Shirts', label: 'Grey', displayOrder: 4 },
  { material: 'Trousers', label: 'Grey', displayOrder: 1 },
  { material: 'Trousers', label: 'Blue', displayOrder: 2 },
  { material: 'Trousers', label: 'Brown', displayOrder: 3 },
  { material: 'Overcoats', label: 'White', displayOrder: 1 },
  { material: 'Overcoats', label: 'Blue Black', displayOrder: 2 },
  { material: 'Overcoats', label: 'Cereals High Hygiene', displayOrder: 3 },
  { material: 'Towels', label: 'White', displayOrder: 1 },
  { material: 'Table Clothes', label: 'White', displayOrder: 1 },
  { material: 'Bed Sheets', label: 'White', displayOrder: 1 },
]);

export function normalizeMaterialColors(rows) {
  if (!Array.isArray(rows)) return DEFAULT_MATERIAL_COLORS.map((row) => ({ ...row }));
  const materialOrder = new Map(MATERIAL_LABELS.map((label, index) => [label, index]));
  const seen = new Set();
  const normalized = [];
  for (const row of rows) {
    const material = String(row?.material || '');
    const label = String(row?.label || '').trim();
    const key = `${material}\u0000${label.toLocaleLowerCase()}`;
    if (!materialOrder.has(material) || !label || label.length > 50 || seen.has(key)
      || isRetiredMaterialColor(material, label)) continue;
    seen.add(key);
    const displayOrder = Number(row.displayOrder ?? row.display_order);
    normalized.push({
      material,
      label,
      displayOrder: Number.isInteger(displayOrder) && displayOrder > 0 ? displayOrder : 999,
    });
  }
  return normalized.sort((left, right) => materialOrder.get(left.material) - materialOrder.get(right.material)
    || left.displayOrder - right.displayOrder
    || left.label.localeCompare(right.label));
}

export function applyMaterialColorMutation(rows, mutation) {
  const current = normalizeMaterialColors(rows);
  if (mutation?.type === 'create-material-color') {
    const exists = current.some((row) => row.material === mutation.material
      && row.label.toLocaleLowerCase() === String(mutation.label || '').toLocaleLowerCase());
    if (exists) return current;
    const displayOrder = Math.max(0, ...current
      .filter((row) => row.material === mutation.material)
      .map((row) => row.displayOrder)) + 1;
    return normalizeMaterialColors([...current, { material: mutation.material, label: mutation.label, displayOrder }]);
  }
  if (mutation?.type === 'rename-material-color') {
    return normalizeMaterialColors(current.map((row) =>
      row.material === mutation.material && row.label === mutation.from ? { ...row, label: mutation.to } : row));
  }
  if (mutation?.type === 'delete-material-color') {
    return current.filter((row) => row.material !== mutation.material || row.label !== mutation.label);
  }
  return current;
}