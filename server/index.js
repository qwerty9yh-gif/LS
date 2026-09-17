import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { google } from 'googleapis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const dataDir = path.join(rootDir, 'data');
const dbPath = path.join(dataDir, 'records.json');

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

async function ensureDb() {
  if (!existsSync(dataDir)) await mkdir(dataDir, { recursive: true });
  if (!existsSync(dbPath)) {
    await writeFile(dbPath, JSON.stringify({ records: [], locks: [], syncEvents: [] }, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await readFile(dbPath, 'utf8'));
}

async function writeDb(db) {
  await ensureDb();
  await writeFile(dbPath, JSON.stringify(db, null, 2));
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
    updatedAt: new Date().toISOString()
  };
}

function lockKey(date, shift) {
  return `${date}:${shift}`;
}

function isGoogleConfigured() {
  return Boolean(
    process.env.GOOGLE_SHEETS_SPREADSHEET_ID &&
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    process.env.GOOGLE_PRIVATE_KEY
  );
}

async function getSheetsClient() {
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: privateKey,
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

app.get('/api/records', async (_req, res) => {
  const db = await readDb();
  res.json(db);
});

app.put('/api/records', async (req, res) => {
  try {
    const incoming = Array.isArray(req.body.records) ? req.body.records : [];
    const cleaned = incoming.map(cleanRecord);
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

    try {
      const result = await syncRecordsToGoogle(cleaned);
      const syncedAt = new Date().toISOString();
      const syncedIds = new Set(cleaned.map((record) => record.id));
      db.records = db.records.map((record) => syncedIds.has(record.id)
        ? { ...record, syncStatus: 'synced', syncError: '', syncedAt }
        : record);
      db.syncEvents.push({ at: syncedAt, status: 'synced', detail: result });
      await writeDb(db);
      res.json({ ok: true, records: db.records, sync: { status: 'synced', ...result } });
    } catch (error) {
      const failedIds = new Set(cleaned.map((record) => record.id));
      db.records = db.records.map((record) => failedIds.has(record.id)
        ? { ...record, syncStatus: 'pending', syncError: error.message }
        : record);
      db.syncEvents.push({ at: new Date().toISOString(), status: 'pending', error: error.message });
      await writeDb(db);
      res.status(202).json({ ok: true, records: db.records, sync: { status: 'pending', error: error.message } });
    }
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.delete('/api/records/:id', async (req, res) => {
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
    const syncedAt = new Date().toISOString();
    db.records = db.records.map((record) => record.syncStatus !== 'synced'
      ? { ...record, syncStatus: 'synced', syncError: '', syncedAt }
      : record);
    db.syncEvents.push({ at: syncedAt, status: 'synced', detail: result });
    await writeDb(db);
    res.json({ ok: true, sync: { status: 'synced', ...result }, records: db.records });
  } catch (error) {
    db.syncEvents.push({ at: new Date().toISOString(), status: 'pending', error: error.message });
    await writeDb(db);
    res.status(202).json({ ok: true, sync: { status: 'pending', error: error.message }, records: db.records });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`Laundry Tracking PWA running at http://localhost:${port}`);
});

export { cleanRecord, syncRecordsToGoogle };
