import test from 'node:test';
import assert from 'node:assert/strict';
import { backupUnsyncedRecords, findUnsyncedLocalRecords, UNSYNCED_BACKUP_KEY } from '../sync-queue.js';

const rec = (id, extra = {}) => ({ id, date: '2026-10-20', shift: 'morning', material: 'Shirts', color: 'White', quantity: 5, ...extra });
const base = { queuedRecordIds: new Set(), queuedDeleteIds: new Set(), locks: [] };

test('keeps offline-only records that the server lacks', () => {
  const found = findUnsyncedLocalRecords({ ...base, localRecords: [rec('a'), rec('b')], serverRecords: [{ id: 'a' }] });
  assert.deepEqual(found.map((r) => r.id), ['b']);
});

test('ignores records already queued, deleted by the user, blank, or in a locked shift', () => {
  const found = findUnsyncedLocalRecords({
    localRecords: [rec('q'), rec('d'), rec('blank', { quantity: '' }), rec('zero', { quantity: 0 }), rec('l')],
    serverRecords: [],
    queuedRecordIds: new Set(['q']),
    queuedDeleteIds: new Set(['d']),
    locks: [{ date: '2026-10-20T00:00:00.000Z', shift: 'morning' }],
  });
  assert.deepEqual(found, []);
});

test('a blank row with a signature still counts as entered data', () => {
  const found = findUnsyncedLocalRecords({ ...base, localRecords: [rec('s', { quantity: '', signature: 'AB' })], serverRecords: [] });
  assert.equal(found.length, 1);
});

test('backupUnsyncedRecords is append-only and keyed by id', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  backupUnsyncedRecords([rec('a')], storage);
  backupUnsyncedRecords([rec('b'), rec('a', { quantity: 9 })], storage);
  const saved = JSON.parse(store.get(UNSYNCED_BACKUP_KEY));
  assert.deepEqual(Object.keys(saved).sort(), ['a', 'b']);
  assert.equal(saved.a.quantity, 9);
});
