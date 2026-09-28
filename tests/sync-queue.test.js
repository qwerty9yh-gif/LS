import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueMutation, readMutationQueue, removeQueuedMutation } from '../sync-queue.js';

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test('offline mutations retain insertion order across queue reads', () => {
  const storage = createStorage();
  enqueueMutation({ type: 'save-records', records: [{ id: 'a' }] }, storage);
  enqueueMutation({ type: 'delete-record', id: 'a' }, storage);

  assert.deepEqual(readMutationQueue(storage).map((item) => item.type), ['save-records', 'delete-record']);
});

test('acknowledging one mutation removes only that queue item', () => {
  const storage = createStorage();
  enqueueMutation({ type: 'create-daily-form', date: '2026-09-28' }, storage);
  enqueueMutation({ type: 'delete-record', id: 'a' }, storage);
  const queue = readMutationQueue(storage);

  removeQueuedMutation(queue[0].id, storage);

  assert.deepEqual(readMutationQueue(storage).map((item) => item.id), [queue[1].id]);
});

test('color catalog edits remain ordered offline mutations', () => {
  const storage = createStorage();
  enqueueMutation({ type: 'rename-material-color', material: 'Shirts', from: 'White', to: 'Ivory' }, storage);
  enqueueMutation({ type: 'delete-material-color', material: 'Shirts', label: 'Ivory' }, storage);

  assert.deepEqual(readMutationQueue(storage).map((item) => item.type), [
    'rename-material-color', 'delete-material-color'
  ]);
});

test('corrupt local queue data is treated as empty', () => {
  const storage = createStorage();
  storage.setItem('laundry-mutation-queue-v1', '{bad json');

  assert.deepEqual(readMutationQueue(storage), []);
});