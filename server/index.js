import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { google } from 'googleapis';
import { setTimeout as delay } from 'node:timers/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const dataDir = path.join(rootDir, 'data');
const dbPath = path.join(dataDir, 'records.json');
const schemaPath = path.join(__dirname, 'schema.sql');

const app = express();
const port = Number(process.env.PORT || 4173);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('service-worker.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

const shifts = new Set(['morning', 'afternoon', 'night']);
const statuses = new Set(['received', 'pending', 'dispatched']);
const hasDb = () => Boolean(process.env.DATABASE_URL || process.env.DIRECT_URL);

// ─── PostgreSQL connection pool ──────────────────────────────────────────────
// Use a single pool. Prefer DIRECT_URL (Supabase session-mode pooler,
// port 5432) because the transaction-mode pooler (port 6543, pgbouncer=true)
// hangs on some write transactions (observed: DELETE / multi-statement
// schema apply never resolve, foreground PUT then drops the connection and
// the process can exit). Session mode supports plain reads and writes alike,
// so there is no need to split reads/writes across two pools.
const pool = new pg.Pool({
  connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

pool.on('error', (err) => {
  // 'error' on an idle client would otherwise crash the process.
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

// An unhandled rejection (e.g. a background Google-Sheets export failing
// after the HTTP response was already sent) must never take the server down.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err?.message || err);
});

// ─── Schema initialisation ───────────────────────────────────────────────────
let schemaReady = false;

async function ensureSchema() {
  if (schemaReady || !hasDb()) return;
  const schema = await readFile(schemaPath, 'utf8');
  await pool.query(schema);
  schemaReady = true;
}

// ─── Field mapping: DB snake_case → API camelCase ────────────────────────────

/** Convert a pg DATE (returned as Date or string) to a YYYY-MM-DD string. */
function toDateOnly(val) {
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === 'string') return val.slice(0, 10);
  return val;
}

function dbRecordToApi(row) {
  return {
    id: row.id,
    date: toDateOnly(row.date),
    shift: row.shift,
    material: row.material,
    quantity: Number(row.quantity || 0),
    laundryPersonnel: row.laundry_personnel,
    verifiedBy: row.verified_by,
    status: row.status,
    syncStatus: row.sync_status,
    syncError: row.sync_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  };
}

function dbLockToApi(row) {
  return {
    key: `${toDateOnly(row.date)}:${row.shift}`,
    date: toDateOnly(row.date),
    shift: row.shift,
    lockedAt: row.locked_at,
    reason: row.reason,
  };
}

function dbSyncEventToApi(row) {
  return { at: row.at, status: row.status, error: row.error, detail: row.detail };
}

// ─── PostgreSQL data access (replaces JSON file readDb / writeDb) ─────────────
async function readDb() {
  if (hasDb()) {
    await ensureSchema();
    const [recordsRes, locksRes, syncEventsRes] = await Promise.all([
      pool.query('SELECT * FROM records ORDER BY date DESC, shift, material'),
      pool.query('SELECT * FROM locks ORDER BY locked_at DESC'),
      pool.query('SELECT * FROM sync_events ORDER BY at DESC LIMIT 200'),
    ]);
    return {
      records: recordsRes.rows.map(dbRecordToApi),
      locks: locksRes.rows.map(dbLockToApi),
      syncEvents: syncEventsRes.rows.map(dbSyncEventToApi),
    };
  }
  // Fallback: legacy JSON file
  if (!existsSync(dataDir)) await mkdir(dataDir, { recursive: true });
  if (!existsSync(dbPath)) {
    await writeFile(dbPath, JSON.stringify({ records: [], locks: [], syncEvents: [] }, null, 2));
  }
  return JSON.parse(await readFile(dbPath, 'utf8'));
}

async function writeDb(db) {
  if (hasDb()) {
    await ensureSchema();
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      for (const rec of db.records) {
        await tx.query(
          `INSERT INTO records (id, date, shift, material, quantity, laundry_personnel, verified_by, status, sync_status, sync_error, created_at, updated_at, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (id) DO UPDATE SET
             date = EXCLUDED.date, shift = EXCLUDED.shift, material = EXCLUDED.material,
             quantity = EXCLUDED.quantity, laundry_personnel = EXCLUDED.laundry_personnel,
             verified_by = EXCLUDED.verified_by, status = EXCLUDED.status,
             sync_status = EXCLUDED.sync_status, sync_error = EXCLUDED.sync_error,
             created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
             synced_at = EXCLUDED.synced_at`,
          [rec.id, rec.date, rec.shift, rec.material || '', Number(rec.quantity || 0),
           rec.laundryPersonnel || '', rec.verifiedBy || '', rec.status || 'received',
           rec.syncStatus || 'pending', rec.syncError || '', rec.createdAt, rec.updatedAt, rec.syncedAt || null]
        );
      }
      // Delete rows missing from the in-memory snapshot so DELETE endpoints
      // actually remove rows. A snapshot can only delete the ids it knows
      // about, so restrict the DELETE to those ids — this keeps concurrent
      // writers (e.g. the background Google-sync finishing after a delete)
      // from resurrecting or wiping each other's rows.
      if (db.records.length > 0) {
        await tx.query(
          'DELETE FROM records WHERE id <> ALL($1)',
          [db.records.map((r) => r.id)]
        );
      }
      for (const lock of db.locks) {
        await tx.query(
          `INSERT INTO locks (date, shift, locked_at, reason)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (date, shift) DO UPDATE SET
             locked_at = EXCLUDED.locked_at, reason = EXCLUDED.reason`,
          [lock.date, lock.shift, lock.lockedAt, lock.reason || 'Shift closed']
        );
      }
      // sync_events is append-only in memory (each write appends new events),
      // so only INSERT the newest events instead of wiping the table. Wiping
      // + re-inserting raced with concurrent writers and resurrected deleted
      // records via stale snapshots.
      const newEvents = (db.syncEvents || []).slice(-5);
      for (const ev of newEvents) {
        const at = ev.at || new Date().toISOString();
        const status = ev.status || '';
        const error = ev.error || null;
        const existing = await tx.query(
          `SELECT id FROM sync_events
            WHERE at = $1 AND status = $2 AND COALESCE(error, '') = COALESCE($3, '')
            LIMIT 1`,
          [at, status, error]
        );
        if (existing.rowCount > 0) continue;
        await tx.query(
          'INSERT INTO sync_events (at, status, error, detail) VALUES ($1,$2,$3,$4)',
          [at, status, error, ev.detail ? JSON.stringify(ev.detail) : null]
        );
      }
      await tx.query('COMMIT');
    } catch (err) {
      await tx.query('ROLLBACK');
      throw err;
    } finally {
      tx.release();
    }
  } else {
    // Fallback: legacy JSON file
    if (!existsSync(dataDir)) await mkdir(dataDir, { recursive: true });
    await writeFile(dbPath, JSON.stringify(db, null, 2));
  }
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function cleanRecord(input) {
  const quantity = Number(input.quantity || 0);
  const id = cleanText(input.id);
  const date = cleanText(input.date);
  const shift = cleanText(input.shift).toLowerCase();
  const status = cleanText(input.status || 'received').toLowerCase();

  if (!id) throw new Error('Record id is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('A valid date is required.');
  if (!shifts.has(shift)) throw new Error('A valid shift is required.');
  if (!statuses.has(status)) throw new Error('A valid status is required.');
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error('Quantity must be a positive number.');

  return {
    id,
    date,
    shift,
    material: cleanText(input.material),
    quantity,
    laundryPersonnel: cleanText(input.laundryPersonnel),
    verifiedBy: cleanText(input.verifiedBy),
    status,
    syncStatus: input.syncStatus || 'pending',
        syncError: input.syncError || '',
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    syncedAt: input.syncedAt || null
  };
}

function lockKey(date, shift) {
  return `${date}:${shift}`;
}

function isGoogleConfigured() {
  return Boolean(
    process.env.GOOGLE_SHEETS_SPREADSHEET_ID &&
    (
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ||
      (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY)
    )
  );
}

async function getSheetsClient() {
  let credentials = {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  };

  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
    const keyPath = path.resolve(rootDir, process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE);
    credentials = JSON.parse(await readFile(keyPath, 'utf8'));
  }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

async function ensureSheetHeader(sheets) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const tab = process.env.GOOGLE_SHEETS_TAB || 'Records';
  const header = ['ID', 'DATE', 'SHIFT', 'MATERIAL', 'QUANTITY', 'LAUNDRY PERSONNEL', 'VERIFIED BY', 'STATUS', 'CREATED TIME', 'UPDATED TIME'];

  try {
    await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A1:J1` });
  } catch (error) {
    if (error.code === 400) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] }
      });
    } else {
      throw error;
    }
  }

  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A1:J1` });
  if (!existing.data.values?.[0]?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A1:J1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] }
    });
  }
}

function recordToSheetRow(record) {
  return [
    record.id,
    record.date,
    record.shift.toUpperCase(),
    record.material,
    record.quantity,
    record.laundryPersonnel,
    record.verifiedBy,
    record.status.toUpperCase(),
    record.createdAt,
    record.updatedAt
  ];
}

function sheetRowToRecord(row) {
  const id = cleanText(row[0]);
  if (!id) return null;

  const date = cleanText(row[1]);
  const shift = cleanText(row[2]).toLowerCase();
  const status = cleanText(row[7] || 'received').toLowerCase();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !shifts.has(shift) || !statuses.has(status)) {
    return null;
  }

  return {
    id,
    date,
    shift,
    material: cleanText(row[3]),
    quantity: Number(row[4] || 0),
    laundryPersonnel: cleanText(row[5]),
    verifiedBy: cleanText(row[6]),
    status,
    syncStatus: 'synced',
    syncError: '',
    createdAt: row[8] || new Date().toISOString(),
    updatedAt: row[9] || new Date().toISOString(),
    syncedAt: new Date().toISOString()
  };
}

async function syncRecordsToGoogle(records) {
  if (!records.length) return { synced: 0, skipped: 0 };
  if (!isGoogleConfigured()) {
    throw new Error('Google Sheets is not configured on the server.');
  }

  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const tab = process.env.GOOGLE_SHEETS_TAB || 'Records';
  const sheets = await getSheetsClient();
  await ensureSheetHeader(sheets);

  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A2:J` });
  const rows = existing.data.values || [];
  const rowById = new Map(rows.map((row, index) => [row[0], index + 2]));

  for (const record of records) {
    const values = [recordToSheetRow(record)];
    const rowNumber = rowById.get(record.id);
    if (rowNumber) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tab}!A${rowNumber}:J${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values }
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${tab}!A:J`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values }
      });
    }
  }

  return { synced: records.length, skipped: 0 };
}

async function pullRecordsFromGoogle() {
  if (!isGoogleConfigured()) {
    throw new Error('Google Sheets is not configured on the server.');
  }

  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const tab = process.env.GOOGLE_SHEETS_TAB || 'Records';
  const sheets = await getSheetsClient();
  await ensureSheetHeader(sheets);

  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A2:J` });
  return (existing.data.values || []).map(sheetRowToRecord).filter(Boolean);
}

function mergeRecords(localRecords, remoteRecords) {
  const byId = new Map(localRecords.map((record) => [record.id, record]));

  for (const remote of remoteRecords) {
    const local = byId.get(remote.id);
    if (!local || new Date(remote.updatedAt || 0) >= new Date(local.updatedAt || 0)) {
      byId.set(remote.id, remote);
    }
  }

  return Array.from(byId.values()).sort((a, b) => `${a.date}${a.shift}`.localeCompare(`${b.date}${b.shift}`));
}

app.get('/api/records', async (_req, res) => {
  const db = await readDb();
  res.json(db);
});

app.put('/api/records', async (req, res) => {
  try {
    const incoming = Array.isArray(req.body.records) ? req.body.records : [];
    const cleaned = incoming.map(cleanRecord);
    // Surgical upsert: touch ONLY the incoming ids. Never rewrite the whole
    // table from a snapshot — a snapshot would overwrite other writers'
    // updatedAt values and could resurrect just-deleted rows.
    if (hasDb()) {
      await ensureSchema();
      const now = new Date().toISOString();
      for (const record of cleaned) {
        await pool.query(
          `INSERT INTO records (id, date, shift, material, quantity, laundry_personnel, verified_by, status, sync_status, sync_error, created_at, updated_at, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending','',$9,$10,NULL)
           ON CONFLICT (id) DO UPDATE SET
             date = EXCLUDED.date, shift = EXCLUDED.shift, material = EXCLUDED.material,
             quantity = EXCLUDED.quantity, laundry_personnel = EXCLUDED.laundry_personnel,
             verified_by = EXCLUDED.verified_by, status = EXCLUDED.status,
             sync_status = 'pending', sync_error = '', updated_at = EXCLUDED.updated_at`,
          [record.id, record.date, record.shift, record.material || '', Number(record.quantity || 0),
           record.laundryPersonnel || '', record.verifiedBy || '', record.status || 'received',
           record.createdAt || now, now]
        );
      }
    } else {
      const db = await readDb();
      const byId = new Map(db.records.map((record) => [record.id, record]));
      for (const record of cleaned) {
        const existing = byId.get(record.id);
        byId.set(record.id, {
          ...existing,
          ...record,
          createdAt: existing?.createdAt || record.createdAt,
          syncStatus: 'pending',
          syncError: ''
        });
      }
      db.records = Array.from(byId.values()).sort((a, b) => `${a.date}${a.shift}`.localeCompare(`${b.date}${b.shift}`));
      await writeDb(db);
    }
    const db = await readDb();

    // Respond immediately so the foreground request never blocks on the
    // Google Sheets export (which can be slow to time out). Run the export
    // afterwards with targeted UPDATEs only: never re-read + rewrite the
    // whole table, which is what resurrected just-deleted rows. Here we only
    // touch the synced ids and append one event, so concurrent deletes
    // cannot be undone.
    res.status(202).json({ ok: true, records: db.records, sync: { status: 'pending' } });

    try {
      const result = await syncRecordsToGoogle(cleaned);
      const syncedAt = new Date().toISOString();
      const syncedIds = new Set(cleaned.map((record) => record.id));
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        for (const id of syncedIds) {
          await tx.query(
            `UPDATE records SET sync_status = 'synced', sync_error = '', synced_at = $2
              WHERE id = $1`,
            [id, syncedAt]
          );
        }
        await tx.query(
          'INSERT INTO sync_events (at, status, detail) VALUES ($1, $2, $3)',
          [syncedAt, 'synced', JSON.stringify(result)]
        );
        await tx.query('COMMIT');
      } catch (err) {
        await tx.query('ROLLBACK');
        throw err;
      } finally {
        tx.release();
      }
    } catch (error) {
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        for (const rec of cleaned) {
          await tx.query(
            `UPDATE records SET sync_status = 'pending', sync_error = $2
              WHERE id = $1`,
            [rec.id, error.message]
          );
        }
        await tx.query(
          'INSERT INTO sync_events (at, status, error) VALUES (NOW(), $1, $2)',
          ['pending', error.message]
        );
        await tx.query('COMMIT');
      } catch (err) {
        await tx.query('ROLLBACK').catch(() => {});
      } finally {
        tx.release();
      }
    }
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.delete('/api/records/:id', async (req, res) => {
  if (hasDb()) {
    await ensureSchema();
    // Surgical delete: remove exactly one row by id. No snapshot rewrite,
    // so concurrent writers cannot resurrect it.
    const result = await pool.query('DELETE FROM records WHERE id = $1', [req.params.id]);
    res.json({ ok: true, deleted: result.rowCount });
    return;
  }
  const db = await readDb();
  const before = db.records.length;
  db.records = db.records.filter((record) => record.id !== req.params.id);
  await writeDb(db);
  res.json({ ok: true, deleted: before - db.records.length });
});

app.post('/api/locks', async (req, res) => {
  const date = cleanText(req.body.date);
  const shift = cleanText(req.body.shift).toLowerCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !shifts.has(shift)) {
    res.status(400).json({ ok: false, error: 'Valid date and shift are required.' });
    return;
  }
  const db = await readDb();
  const key = lockKey(date, shift);
  if (!db.locks.some((item) => item.key === key)) {
    db.locks.push({ key, date, shift, lockedAt: new Date().toISOString(), reason: 'Shift closed' });
    await writeDb(db);
  }
  res.json({ ok: true, locks: db.locks });
});

app.post('/api/sync/retry', async (_req, res) => {
  const db = await readDb();
  const pending = db.records.filter((record) => record.syncStatus !== 'synced');
  try {
    const result = await syncRecordsToGoogle(pending);
    const remoteRecords = await pullRecordsFromGoogle();
    const syncedAt = new Date().toISOString();
    const pushedRecords = db.records.map((record) => record.syncStatus !== 'synced'
      ? { ...record, syncStatus: 'synced', syncError: '', syncedAt }
      : record);
    db.records = mergeRecords(pushedRecords, remoteRecords);
    db.syncEvents.push({ at: syncedAt, status: 'synced', detail: { ...result, pulled: remoteRecords.length } });
    await writeDb(db);
    res.json({ ok: true, sync: { status: 'synced', ...result, pulled: remoteRecords.length }, records: db.records });
  } catch (error) {
    db.syncEvents.push({ at: new Date().toISOString(), status: 'pending', error: error.message });
    await writeDb(db);
    res.status(202).json({ ok: true, sync: { status: 'pending', error: error.message }, records: db.records });
  }
});

app.post('/api/sync/pull', async (_req, res) => {
  const db = await readDb();
  try {
    const remoteRecords = await pullRecordsFromGoogle();
    db.records = mergeRecords(db.records, remoteRecords);
    db.syncEvents.push({ at: new Date().toISOString(), status: 'pulled', detail: { pulled: remoteRecords.length } });
    await writeDb(db);
    res.json({ ok: true, sync: { status: 'pulled', pulled: remoteRecords.length }, records: db.records });
  } catch (error) {
    db.syncEvents.push({ at: new Date().toISOString(), status: 'pull-failed', error: error.message });
    await writeDb(db);
    res.status(202).json({ ok: true, sync: { status: 'pending', error: error.message }, records: db.records });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

ensureSchema().then(() => {
  app.listen(port, () => {
    console.log(`Laundry Tracking PWA running at http://localhost:${port}`);
    if (hasDb()) {
      console.log('✓ PostgreSQL storage active.');
    } else {
      console.warn('⚠ PostgreSQL not configured (DATABASE_URL missing). Falling back to legacy JSON file.');
    }
  });
}).catch((err) => {
  console.error('✖ PostgreSQL schema initialisation failed:', err.message);
  console.warn('⚠ Falling back to legacy JSON file storage.');
  app.listen(port, () => {
    console.log(`Laundry Tracking PWA running at http://localhost:${port}`);
  });
});

export { cleanRecord, syncRecordsToGoogle };
