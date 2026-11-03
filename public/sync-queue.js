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

export const UNSYNCED_BACKUP_KEY = 'laundry-unsynced-backup-v1';

const hasEntryData = (record) => {
  const quantity = record?.quantity;
  return (quantity !== '' && quantity !== null && quantity !== undefined && Number(quantity) !== 0)
    || Boolean(String(record?.laundryPersonnel || '').trim())
    || Boolean(String(record?.verifiedBy || '').trim())
    || Boolean(String(record?.signature || '').trim());
};

/**
 * Local records that the server does not have, are not already queued for
 * upload, were not deleted by the user, and carry real entered data. A
 * server refresh must never silently discard these.
 */
export function findUnsyncedLocalRecords({ localRecords, serverRecords, queuedRecordIds, queuedDeleteIds, locks = [] }) {
  const serverIds = new Set((serverRecords || []).map((record) => record.id));
  const lockedKeys = new Set((locks || []).map((lock) => `${String(lock.date).slice(0, 10)}|${lock.shift}`));
  return (localRecords || []).filter((record) => record?.id
    && !serverIds.has(record.id)
    && !queuedRecordIds.has(record.id)
    && !queuedDeleteIds.has(record.id)
    && !lockedKeys.has(`${record.date}|${record.shift}`)
    && hasEntryData(record));
}

/** Append-only safety copy, keyed by record id; never cleared automatically. */
export function backupUnsyncedRecords(records, storage = globalThis.localStorage) {
  if (!records.length) return;
  try {
    const existing = JSON.parse(storage.getItem(UNSYNCED_BACKUP_KEY) || '{}');
    const byId = existing && typeof existing === 'object' ? existing : {};
    for (const record of records) byId[record.id] = record;
    storage.setItem(UNSYNCED_BACKUP_KEY, JSON.stringify(byId));
  } catch {
    // A full or unavailable storage must not block syncing.
  }
}
