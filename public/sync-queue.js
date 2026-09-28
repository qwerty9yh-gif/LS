export const MUTATION_QUEUE_KEY = 'laundry-mutation-queue-v1';

export function readMutationQueue(storage = globalThis.localStorage) {
  try {
    const queue = JSON.parse(storage.getItem(MUTATION_QUEUE_KEY) || '[]');
    return Array.isArray(queue) ? queue : [];
  } catch {
    return [];
  }
}

export function enqueueMutation(mutation, storage = globalThis.localStorage) {
  const queue = readMutationQueue(storage);
  queue.push({
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    createdAt: new Date().toISOString(),
    ...mutation,
  });
  storage.setItem(MUTATION_QUEUE_KEY, JSON.stringify(queue));
}

export function removeQueuedMutation(id, storage = globalThis.localStorage) {
  const queue = readMutationQueue(storage).filter((mutation) => mutation.id !== id);
  storage.setItem(MUTATION_QUEUE_KEY, JSON.stringify(queue));
}