import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MATERIAL_COLORS, applyMaterialColorMutation, isRetiredMaterialColor, normalizeMaterialColors } from '../material-colors.js';

test('default color catalog matches the current register categories', () => {
  assert.equal(DEFAULT_MATERIAL_COLORS.length, 13);
  assert.deepEqual(
    DEFAULT_MATERIAL_COLORS.filter((row) => row.material === 'Shirts').map((row) => row.label),
    ['White', 'Blue', 'Brown', 'Grey'],
  );
  assert.equal(DEFAULT_MATERIAL_COLORS.some((row) =>
    ['Towels', 'Table Clothes', 'Bed Sheets'].includes(row.material)
      && ['Blue', 'Cream', 'Green', 'Yellow'].includes(row.label)), false);
  assert.equal(isRetiredMaterialColor('Bed Sheets', ' BLUE '), true);
  assert.equal(isRetiredMaterialColor('Towels', 'yellow'), true);
  assert.equal(isRetiredMaterialColor('Towels', 'White'), false);
  assert.equal(isRetiredMaterialColor('Shirts', 'Blue'), false);
});

test('catalog normalization filters invalid rows and duplicate labels', () => {
  assert.deepEqual(normalizeMaterialColors([
    { material: 'Shirts', label: 'Blue', displayOrder: 2 },
    { material: 'Shirts', label: ' blue ', displayOrder: 1 },
    { material: 'Uniforms', label: 'White', displayOrder: 1 },
    { material: 'Towels', label: '', displayOrder: 1 },
  ]), [{ material: 'Shirts', label: 'Blue', displayOrder: 2 }]);
});

test('queued catalog changes replay over refreshed server state', () => {
  const rows = applyMaterialColorMutation(DEFAULT_MATERIAL_COLORS, {
    type: 'rename-material-color', material: 'Shirts', from: 'White', to: 'Ivory'
  });
  assert.equal(rows.some((row) => row.material === 'Shirts' && row.label === 'Ivory'), true);
  assert.equal(rows.some((row) => row.material === 'Shirts' && row.label === 'White'), false);
  assert.equal(rows.some((row) => row.material === 'Overcoats' && row.label === 'White'), true);
});