import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { google } from 'googleapis';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyPassword } from './auth.js';
import { normalizeShift, formExists as formDateExists, isValidFormDate } from './forms.js';
import { DEFAULT_SHIFT_ORDER, SHIFT_KEYS as ORDERABLE_SHIFT_KEYS, isCompleteShiftOrder, normalizeShiftOrder } from '../shift-order.js';

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

// ─── CORS ────────────────────────────────────────────────────────────────────
// The PWA frontend is served from GitHub Pages (a different origin than this
// backend), so cross-origin API calls must be allowed. Origins are whitelisted
// via ALLOWED_ORIGINS (comma-separated); '*' allows any origin. Same-origin
// requests (frontend served by this backend) have no Origin header and are
// unaffected.
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ||
    'https://qwerty9yh-gif.github.io,http://localhost:4173,http://127.0.0.1:4173')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.has('*') || allowedOrigins.has(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    // Preflight — must be answered without hitting the route handlers.
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.static(publicDir, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('service-worker.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

const shifts = new Set(['morning', 'afternoon', 'evening', 'night']);
// Human-friendly labels stay in the frontend; Shift 3 is now presented as
// "Shift 3 (Straight Day Shift)" while 'evening' remains the stored key.
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
// Force Prisma onto the session-mode connection too: the transaction-mode
// pooler (6543, pgbouncer=true) hangs on some transactional writes, and an
// explicit url beats whatever DATABASE_URL the generated client defaults to.
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } },
});

pool.on('error', (err) => {
  // 'error' on an idle client would otherwise crash the process.
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

// An unhandled rejection (e.g. a background Google-Sheets export failing
// after the HTTP response was already sent) must never take the server down.
// Log the full stack + code so the next database mismatch is diagnosable
// instead of a bare repeated message.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err?.message || err);
  if (err?.code) console.error('  code:', err.code);
  if (err?.stack) console.error(err.stack);
});

// Wrap async route handlers so a thrown error (e.g. DB read failing before
// the schema self-heal has completed) becomes a 500 JSON response instead of
// an unhandled rejection that leaves the client hanging and retries forever.
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ─── Schema initialisation ───────────────────────────────────────────────────
// NOTE: schema.sql holds ~20 statements (DO $$ blocks, CREATE TABLE/INDEX,
// ALTER TABLE ... ADD COLUMN). It must NOT be sent as one multi-statement
// pool.query(): on the Supabase transaction-mode pooler (port 6543) such a
// query can fail/hang part-way, leaving an old `records` table without the
// `color`/`row_key`/`signature` columns. Every later read/write then throws
// `column "color" does not exist` on every poll. So: split into single
// statements, run them one-by-one on a dedicated client, then verify the
// required columns exist before marking the schema ready.
let schemaReady = false;
let schemaPromise = null;

/** Split SQL on semicolons, ignoring those inside quotes/comments/$$ blocks. */
function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let dollarTag = null;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (dollarTag) {
      current += ch;
      if (ch === '$' && sql.startsWith(dollarTag, i)) {
        current += dollarTag.slice(1);
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (inSingle) {
      current += ch;
      if (ch === "'" && next === "'") {
        current += next;
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === '-' && next === '-') {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      current += ch + next;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i, i + 32));
      if (tagMatch) {
        dollarTag = tagMatch[0];
        current += dollarTag;
        i += dollarTag.length - 1;
        continue;
      }
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

const REQUIRED_RECORD_COLUMNS = ['id', 'date', 'shift', 'material', 'color', 'row_key', 'quantity'];

async function verifyRecordColumns(client) {
  const res = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'records'`
  );
  const present = new Set(res.rows.map((row) => row.column_name));
  const missing = REQUIRED_RECORD_COLUMNS.filter((col) => !present.has(col));
  if (missing.length === 0) return;
  const heal = {
    color: `ALTER TABLE records ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT ''`,
    row_key: `ALTER TABLE records ADD COLUMN IF NOT EXISTS row_key TEXT NOT NULL DEFAULT ''`,
    signature: `ALTER TABLE records ADD COLUMN IF NOT EXISTS signature TEXT NOT NULL DEFAULT ''`,
  };
  for (const col of missing) {
    if (heal[col]) await client.query(heal[col]);
  }
  const retry = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'records'`
  );
  const presentAfter = new Set(retry.rows.map((row) => row.column_name));
  const stillMissing = REQUIRED_RECORD_COLUMNS.filter((col) => !presentAfter.has(col));
  if (stillMissing.length > 0) {
    throw new Error(
      `PostgreSQL schema mismatch: public.records is missing column(s) ${stillMissing.join(', ')}. ` +
      `Run server/schema.sql against the session-mode (DIRECT_URL) database, then restart.`
    );
  }
}

async function applyStatement(client, stmt, { tolerateMissingColumn = false } = {}) {
  try {
    await client.query(stmt);
  } catch (stmtErr) {
    const code = stmtErr?.code;
    const msg = stmtErr?.message || '';
    if (code === '42P07' || code === '42710' || code === '42701' || /already exists/i.test(msg)) return;
    if (tolerateMissingColumn && code === '42703' && /does not exist/i.test(msg)) {
      // Index on a column this schema version does not add — skip it instead of
      // aborting init (aborting made every later request 500).
      console.warn('Skipping index, column missing:', stmt.replace(/\s+/g, ' ').slice(0, 90));
      return;
    }
    throw new Error(`Schema statement failed [${code || 'no-code'}]: ${msg}\nStatement: ${stmt.slice(0, 160)}`);
  }
}

async function applySchema() {
  const schema = await readFile(schemaPath, 'utf8');
  const statements = splitSqlStatements(schema)
    .map((stmt) => stmt.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/g, '').trim())
    .filter(Boolean);
  // Apply CREATE/ALTER statements first, heal any missing column, and create
  // indexes LAST: an index may reference a column that only a later ALTER adds
  // (older public.records had no color/row_key/signature), and running it early
  // failed with 42703 which aborted schema init for the whole process.
  const isIndex = (stmt) => /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(stmt);
  const structural = statements.filter((stmt) => !isIndex(stmt));
  const indexes = statements.filter(isIndex);
  const client = await pool.connect();
  try {
    for (const stmt of structural) await applyStatement(client, stmt);
    await verifyRecordColumns(client);
    for (const stmt of indexes) await applyStatement(client, stmt, { tolerateMissingColumn: true });
  } finally {
    client.release();
  }
  await prisma.$transaction(DEFAULT_SHIFT_ORDER.map((shift, index) => prisma.shiftOrder.upsert({
    where: { shift },
    create: { shift, displayOrder: index + 1 },
    update: {},
  })));
}

async function ensureSchema() {
  if (schemaReady || !hasDb()) return;
  if (!schemaPromise) {
    schemaPromise = applySchema().then(() => {
      schemaReady = true;
      schemaPromise = null;
    }).catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

// ─── Field mapping: DB snake_case → API camelCase ────────────────────────────

/** Convert a pg DATE (returned as Date or string) to a YYYY-MM-DD string. */
function toDateOnly(val) {
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === 'string') return val.slice(0, 10);
  return val;
}

function prismaRecordToApi(row) {
  if (!row) return row;
  // Accept both Prisma camelCase (live path) and legacy pg snake_case rows
  // (background Google-sync merge can still hand us raw rows), so the sync
  // status flip never crashes on `updatedAt`/`createdAt` naming.
  const date = row.date;
  const shift = row.shift;
  return {
    id: row.id,
    date: toDateOnly(date),
    shift,
    material: row.material,
    color: row.color || '',
    rowKey: row.rowKey ?? row.row_key ?? '',
    quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
    laundryPersonnel: row.laundryPersonnel ?? row.laundry_personnel,
    verifiedBy: row.verifiedBy ?? row.verified_by,
    signature: row.signature || '',
    status: row.status,
    syncStatus: row.syncStatus ?? row.sync_status,
    syncError: row.syncError ?? row.sync_error ?? '',
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
    syncedAt: row.syncedAt ?? row.synced_at ?? null,
  };
}

function prismaLockToApi(row) {
  if (!row) return row;
  return {
    id: row.id,
    key: `${toDateOnly(row.date)}:${row.shift}`,
    date: toDateOnly(row.date),
    shift: row.shift,
    lockedAt: row.lockedAt ?? row.locked_at,
    reason: row.reason,
  };
}

function prismaSyncEventToApi(row) {
  return { at: row.at, status: row.status, error: row.error, detail: row.detail };
}

// Aliases for the single legacy reader still referencing db* names.
const dbRecordToApi = prismaRecordToApi;
const dbLockToApi = prismaLockToApi;
const dbSyncEventToApi = prismaSyncEventToApi;

// ─── PostgreSQL reads (Prisma-first, JSON fallback for local dev) ─────────────
// PRODUCTION SAFETY: this function performs READS ONLY. It never deletes,
// truncates, or overwrites rows. The legacy `writeDb()` full-snapshot rewrite
// was removed for that reason — the JSON fallback branch is local-dev only
// (no DATABASE_URL) and is the only place files are written.
async function readDb() {
  if (hasDb()) {
    await ensureSchema();
    // Prisma reads through the validated client (no SELECT *, no raw SQL).
    const [records, locks, syncEvents, forms, shiftOrderRows] = await Promise.all([
      prisma.record.findMany({ orderBy: [{ date: 'desc' }, { shift: 'asc' }, { material: 'asc' }, { rowKey: 'asc' }, { color: 'asc' }] }),
      prisma.lock.findMany({ orderBy: { lockedAt: 'desc' } }),
      prisma.syncEvent.findMany({ orderBy: { at: 'desc' }, take: 200 }),
      prisma.dailyForm.findMany({ orderBy: { date: 'desc' } }).catch(() => []),
      prisma.shiftOrder.findMany({ orderBy: [{ displayOrder: 'asc' }, { shift: 'asc' }] }),
    ]);
    const db = {
      records: records.map(prismaRecordToApi),
      locks: locks.map(prismaLockToApi),
      syncEvents: syncEvents.map(prismaSyncEventToApi),
      shiftOrder: normalizeShiftOrder(shiftOrderRows.map((row) => row.shift)),
      dailyForms: forms.map((row) => ({
        date: toDateOnly(row.date),
        createdAt: row.createdAt,
      })),
    };
    // Seed dailyForms from record dates so pre-existing days are recognised
    // as existing forms (prevents duplicates, feeds date navigation).
    const seen = new Set(db.dailyForms.map((form) => form.date));
    for (const record of db.records) {
      if (record?.date && !seen.has(record.date)) {
        seen.add(record.date);
        db.dailyForms.push({ date: record.date, createdAt: record.createdAt || null });
      }
    }
    return db;
  }
  // Fallback: legacy JSON file (local dev only — never production)
  return readJsonDb();
}

// Local-dev JSON fallback helpers (used ONLY when DATABASE_URL/DIRECT_URL are
// unset). Production (hasDb()) never touches the filesystem store and never
// calls writeJsonDb(). NOTE: the old writeDb() snapshot-rewrite is GONE — it
// ran `DELETE FROM records WHERE id <> ALL($ids)` from a possibly-stale
// in-memory snapshot, which is a data-loss risk on production. All production
// writes are surgical Prisma upserts/deletes below (touch only incoming ids).
async function readJsonDb() {
  if (!existsSync(dataDir)) await mkdir(dataDir, { recursive: true });
  if (!existsSync(dbPath)) {
    await writeFile(dbPath, JSON.stringify({ records: [], locks: [], syncEvents: [], dailyForms: [], shiftOrder: DEFAULT_SHIFT_ORDER }, null, 2));
  }
  const fallback = JSON.parse(await readFile(dbPath, 'utf8'));
  fallback.dailyForms = Array.isArray(fallback.dailyForms) ? fallback.dailyForms : [];
  fallback.shiftOrder = normalizeShiftOrder(fallback.shiftOrder);
  const seenFallback = new Set(fallback.dailyForms.map((form) => form?.date).filter(Boolean));
  for (const record of fallback.records || []) {
    if (record?.date && !seenFallback.has(record.date)) {
      seenFallback.add(record.date);
      fallback.dailyForms.push({ date: record.date, createdAt: record.createdAt || null });
    }
  }
  return fallback;
}

async function writeJsonDb(db) {
  if (!existsSync(dataDir)) await mkdir(dataDir, { recursive: true });
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function cleanRecord(input) {
  const id = cleanText(input.id);
  const date = cleanText(input.date);
  const shift = normalizeShift(input.shift);
  const status = cleanText(input.status || 'received').toLowerCase();
  const rawQuantity = input.quantity;
  const quantity = rawQuantity === '' || rawQuantity === null || rawQuantity === undefined
    ? null
    : Number(rawQuantity);
  const updatedAt = cleanText(input.updatedAt) || new Date().toISOString();

  if (!id) throw new Error('Record id is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('A valid date is required.');
  if (!shifts.has(shift)) throw new Error('A valid shift is required.');
  if (!statuses.has(status)) throw new Error('A valid status is required.');
  if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0)) throw new Error('Quantity must be a positive number.');
  if (Number.isNaN(new Date(updatedAt).getTime())) throw new Error('A valid updatedAt timestamp is required.');

  return {
    id,
    date,
    shift,
    material: cleanText(input.material),
    color: cleanText(input.color),
    rowKey: cleanText(input.rowKey),
    quantity,
    laundryPersonnel: cleanText(input.laundryPersonnel),
    verifiedBy: cleanText(input.verifiedBy),
    signature: cleanText(input.signature),
    status,
    syncStatus: input.syncStatus || 'pending',
        syncError: input.syncError || '',
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt,
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
  const header = ['ID', 'DATE', 'SHIFT', 'MATERIAL', 'COLOR', 'QUANTITY', 'LAUNDRY PERSONNEL', 'VERIFIED BY', 'SIGNATURE', 'STATUS', 'CREATED TIME', 'UPDATED TIME'];

  try {
    await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A1:L1` });
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

  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A1:L1` });
  if (!existing.data.values?.[0]?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A1:L1`,
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
    record.color || '',
    record.quantity ?? '',
    record.laundryPersonnel,
    record.verifiedBy,
    record.signature || '',
    record.status.toUpperCase(),
    record.createdAt,
    record.updatedAt
  ];
}

function sheetRowToRecord(row) {
  const id = cleanText(row[0]);
  if (!id) return null;

  const date = cleanText(row[1]);
  const shift = normalizeShift(row[2]);
  const status = cleanText(row[9] || row[7] || 'received').toLowerCase();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !shifts.has(shift) || !statuses.has(status)) {
    return null;
  }

  return {
    id,
    date,
    shift,
    material: cleanText(row[3]),
    color: cleanText(row[4]),
    quantity: row[5] === '' || row[5] === undefined ? null : Number(row[5] || 0),
    laundryPersonnel: cleanText(row[6]),
    verifiedBy: cleanText(row[7]),
    signature: cleanText(row[8]),
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

  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A2:L` });
  const rows = existing.data.values || [];
  const rowById = new Map(rows.map((row, index) => [row[0], index + 2]));

  for (const record of records) {
    const values = [recordToSheetRow(record)];
    const rowNumber = rowById.get(record.id);
    if (rowNumber) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tab}!A${rowNumber}:L${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values }
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${tab}!A:L`,
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

  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A2:L` });
  return (existing.data.values || []).map(sheetRowToRecord).filter(Boolean);
}

async function pruneSyncEvents(tx, keep = 200) {
  // Sync events are an append-only audit log (never delete production rows).
  // Only trim the oldest overflow if the table grows unbounded, keeping the
  // newest `keep` rows. Returns number pruned (0 in normal operation).
  const overflow = await tx.syncEvent.findMany({
    orderBy: { at: 'desc' },
    skip: keep,
    select: { id: true },
  });
  if (!overflow.length) return 0;
  const pruned = await tx.syncEvent.deleteMany({ where: { id: { in: overflow.map((row) => row.id) } } });
  return pruned.count;
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

async function mergeGoogleRecordsIntoPostgres(localRecords, remoteRecords, syncedAt, event) {
  const merged = mergeRecords(localRecords, remoteRecords);
  const localById = new Map(localRecords.map((record) => [record.id, record]));
  const mergedById = new Map(merged.map((record) => [record.id, record]));
  const imported = remoteRecords.filter((remote) => {
    const local = localById.get(remote.id);
    return !local || new Date(remote.updatedAt || 0) >= new Date(local.updatedAt || 0);
  });

  await prisma.$transaction(async (tx) => {
    if (syncedAt) {
      await tx.record.updateMany({
        where: { id: { in: localRecords.filter((record) => record.syncStatus !== 'synced').map((record) => record.id) } },
        data: { syncStatus: 'synced', syncError: '', syncedAt: new Date(syncedAt) },
      });
    }
    for (const remote of imported) {
      const record = cleanRecord(mergedById.get(remote.id) || remote);
      const date = new Date(`${record.date}T00:00:00.000Z`);
      const updatedAt = new Date(record.updatedAt || syncedAt || Date.now());
      const fields = {
        date,
        shift: record.shift,
        material: record.material || '',
        color: record.color || '',
        rowKey: record.rowKey || '',
        quantity: record.quantity === '' || record.quantity === null || record.quantity === undefined
          ? null
          : Number(record.quantity),
        laundryPersonnel: record.laundryPersonnel || '',
        verifiedBy: record.verifiedBy || '',
        signature: record.signature || '',
        status: record.status || 'received',
        syncStatus: 'synced',
        syncError: '',
        updatedAt,
        syncedAt: new Date(syncedAt || Date.now()),
      };
      await tx.record.upsert({
        where: { id: record.id },
        create: { id: record.id, ...fields, createdAt: new Date(record.createdAt || updatedAt) },
        update: fields,
      });
    }
    await tx.syncEvent.create({
      data: {
        at: new Date(event.at || syncedAt || Date.now()),
        status: event.status,
        error: event.error || null,
        detail: event.detail || undefined,
      },
    });
  });
  return readDb();
}

// ─── Authentication: single universal account ────────────────────────────────
// The whole application shares ONE seeded login account (server/seed-user.js).
// No registration, no profiles, no password reset, no device/IP tracking.
app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const email = cleanText(req.body.email).toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) {
    res.status(400).json({ ok: false, error: 'Email and password are required.' });
    return;
  }
  if (!hasDb()) {
    res.status(503).json({ ok: false, error: 'Login requires PostgreSQL to be configured.' });
    return;
  }
  try {
    const result = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, passwordHash: true },
    });
    const user = result && result.passwordHash ? { id: result.id, email: result.email, password_hash: result.passwordHash } : null;
    if (!user || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ ok: false, error: 'Incorrect email or password.' });
      return;
    }
    await prisma.user.updateMany({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    res.json({ ok: true, user: { email: user.email } });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Sign in failed on the server.' });
  }
}));

app.get('/api/records', asyncHandler(async (_req, res) => {
  const db = await readDb();
  res.json(db);
}));

app.put('/api/shift-order', asyncHandler(async (req, res) => {
  const order = req.body?.order;
  if (!isCompleteShiftOrder(order)) {
    res.status(400).json({ ok: false, error: 'Order must contain each of the four shifts exactly once.' });
    return;
  }

  if (hasDb()) {
    await ensureSchema();
    await prisma.$transaction(async (tx) => {
      for (const shift of ORDERABLE_SHIFT_KEYS) {
        const displayOrder = order.indexOf(shift) + 1;
        await tx.shiftOrder.upsert({
          where: { shift },
          create: { shift, displayOrder },
          update: { displayOrder },
        });
      }
    });
    const saved = await prisma.shiftOrder.findMany({ orderBy: [{ displayOrder: 'asc' }, { shift: 'asc' }] });
    res.json({ ok: true, order: normalizeShiftOrder(saved.map((row) => row.shift)) });
    return;
  }

  const db = await readJsonDb();
  db.shiftOrder = order;
  await writeJsonDb(db);
  res.json({ ok: true, order: db.shiftOrder });
}));

app.put('/api/records', asyncHandler(async (req, res) => {
  try {
    const incoming = Array.isArray(req.body.records) ? req.body.records : [];
    const cleaned = incoming.map(cleanRecord).sort((a, b) => a.id.localeCompare(b.id));
    // Surgical upsert: touch ONLY the incoming ids. Never rewrite the whole
    // table from a snapshot — a snapshot would overwrite other writers'
    // updatedAt values and could resurrect just-deleted rows.
    let savedRecords = [];
    let acceptedRecords = [];
    if (hasDb()) {
      await ensureSchema();
      const now = new Date().toISOString();
      savedRecords = await prisma.$transaction(async (tx) => {
        const committed = [];
        acceptedRecords = [];
        for (const record of cleaned) {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${record.id})) IS NULL AS locked`;
          const existing = await tx.record.findUnique({ where: { id: record.id } });
          const incomingUpdatedAt = new Date(record.updatedAt);
          if (existing && incomingUpdatedAt.getTime() <= existing.updatedAt.getTime()) {
            committed.push(prismaRecordToApi(existing));
            continue;
          }
          const date = new Date(`${record.date}T00:00:00.000Z`);
          const quantity = record.quantity === '' || record.quantity === null || record.quantity === undefined
            ? null
            : Number(record.quantity);
          // Prisma-only upsert (idempotent on client-generated id → safe to
          // retry offline queue flushes without duplicates). clock_timestamp()
          // is still the updated_at authority, set via a targeted raw update
          // inside the same transaction; no snapshot rewrite, no mass delete.
          const saved = await tx.record.upsert({
            where: { id: record.id },
            create: {
              id: record.id,
              date,
              shift: record.shift,
              material: record.material || '',
              color: record.color || '',
              rowKey: record.rowKey || '',
              quantity,
              laundryPersonnel: record.laundryPersonnel || '',
              verifiedBy: record.verifiedBy || '',
              signature: record.signature || '',
              status: record.status || 'received',
              syncStatus: 'pending',
              syncError: '',
              createdAt: new Date(record.createdAt || now),
              updatedAt: incomingUpdatedAt,
              syncedAt: null,
            },
            update: {
              date,
              shift: record.shift,
              material: record.material || '',
              color: record.color || '',
              rowKey: record.rowKey || '',
              quantity,
              laundryPersonnel: record.laundryPersonnel || '',
              verifiedBy: record.verifiedBy || '',
              signature: record.signature || '',
              status: record.status || 'received',
              updatedAt: incomingUpdatedAt,
              syncStatus: 'pending',
              syncError: '',
              syncedAt: null,
            },
          });
          await tx.dailyForm.upsert({
            where: { date },
            create: { date, createdAt: new Date(record.createdAt || now) },
            update: {},
          });
          const refreshed = await tx.record.findUnique({ where: { id: record.id } });
          committed.push(prismaRecordToApi(refreshed || saved));
          acceptedRecords.push(record);
        }
        return committed;
      });
    } else {
      const db = await readJsonDb();
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
        if (!formDateExists(db.dailyForms, [], record.date)) {
          db.dailyForms = [...(db.dailyForms || []), { date: record.date, createdAt: record.createdAt || new Date().toISOString() }];
        }
      }
      db.records = Array.from(byId.values()).sort((a, b) => `${a.date}${a.shift}`.localeCompare(`${b.date}${b.shift}`));
      await writeJsonDb(db);
    }
    const db = hasDb() ? null : await readJsonDb();

    // Respond immediately so the foreground request never blocks on the
    // Google Sheets export (which can be slow to time out). Run the export
    // afterwards with targeted UPDATEs only: never re-read + rewrite the
    // whole table, which is what resurrected just-deleted rows. Here we only
    // touch the synced ids and append one event, so concurrent deletes
    // cannot be undone.
    res.status(202).json({ ok: true, records: hasDb() ? savedRecords : db.records, sync: { status: 'pending' } });

    if (!hasDb()) {
      // Local-dev fallback: same bookkeeping against the JSON store. Never
      // touch Prisma here — with no DATABASE_URL the client cannot connect.
      try {
        const result = await syncRecordsToGoogle(cleaned);
        const syncedAt = new Date().toISOString();
        const latest = await readJsonDb();
        const ids = new Set(cleaned.map((record) => record.id));
        latest.records = (latest.records || []).map((record) => (ids.has(record.id)
          ? { ...record, syncStatus: 'synced', syncError: '', syncedAt }
          : record));
        latest.syncEvents = [...(latest.syncEvents || []), { at: syncedAt, status: 'synced', detail: result }].slice(-200);
        await writeJsonDb(latest);
      } catch (error) {
        const latest = await readJsonDb();
        const ids = new Set(cleaned.map((record) => record.id));
        latest.records = (latest.records || []).map((record) => (ids.has(record.id)
          ? { ...record, syncStatus: 'pending', syncError: error.message }
          : record));
        latest.syncEvents = [...(latest.syncEvents || []), { at: new Date().toISOString(), status: 'pending', error: error.message }].slice(-200);
        await writeJsonDb(latest);
      }
      return;
    }

    if (!acceptedRecords.length) return;

    try {
      const result = await syncRecordsToGoogle(acceptedRecords);
      const syncedAt = new Date().toISOString();
      const syncedIds = new Set(acceptedRecords.map((record) => record.id));
      await prisma.$transaction(async (tx) => {
        for (const id of syncedIds) {
          await tx.record.updateMany({
            where: { id },
            data: { syncStatus: 'synced', syncError: '', syncedAt: new Date(syncedAt) },
          });
        }
        await tx.syncEvent.create({
          data: { at: new Date(syncedAt), status: 'synced', detail: result },
        });
        await pruneSyncEvents(tx);
      });
    } catch (error) {
      await prisma.$transaction(async (tx) => {
        for (const rec of acceptedRecords) {
          await tx.record.updateMany({
            where: { id: rec.id },
            data: { syncStatus: 'pending', syncError: error.message },
          });
        }
        await tx.syncEvent.create({
          data: { at: new Date(), status: 'pending', error: error.message },
        });
        await pruneSyncEvents(tx);
      });
    }
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
}));

app.delete('/api/records/:id', asyncHandler(async (req, res) => {
  if (hasDb()) {
    await ensureSchema();
    // Surgical delete: remove exactly one row by id. No snapshot rewrite,
    // so concurrent writers cannot resurrect it.
    const result = await prisma.record.deleteMany({ where: { id: req.params.id } });
    res.json({ ok: true, deleted: result.count });
    return;
  }
  const db = await readJsonDb();
  const before = db.records.length;
  db.records = db.records.filter((record) => record.id !== req.params.id);
  await writeJsonDb(db);
  res.json({ ok: true, deleted: before - db.records.length });
}));

app.post('/api/locks', asyncHandler(async (req, res) => {
  const date = cleanText(req.body.date);
  const shift = normalizeShift(req.body.shift);
  if (!isValidFormDate(date) || !shifts.has(shift)) {
    res.status(400).json({ ok: false, error: 'Valid date and shift are required.' });
    return;
  }
  const key = lockKey(date, shift);
  if (hasDb()) {
    const lockDate = new Date(`${date}T00:00:00.000Z`);
    await prisma.lock.upsert({
      where: { date_shift: { date: lockDate, shift } },
      create: { date: lockDate, shift, reason: 'Shift closed' },
      update: {},
    });
    const db = await readDb();
    res.json({ ok: true, locks: db.locks });
    return;
  }
  const db = await readJsonDb();
  if (!db.locks.some((item) => item.key === key)) {
    db.locks.push({ key, date, shift, lockedAt: new Date().toISOString(), reason: 'Shift closed' });
    await writeJsonDb(db);
  }
  res.json({ ok: true, locks: db.locks });
}));

// ─── Daily forms: one independent record per calendar day ──────────────────
// POST /api/daily-forms { date } → 201 created | 200 already exists
// (frontend shows "A form already exists for this date." with Open/Cancel).
// An explicit row is stored even when the form has zero entries, so empty
// days exist, cannot be duplicated, and appear in Daily Records / navigation.
app.post('/api/daily-forms', asyncHandler(async (req, res) => {
  const date = cleanText(req.body?.date);
  if (!isValidFormDate(date)) {
    res.status(400).json({ ok: false, error: 'A valid date is required.' });
    return;
  }
  const createdAt = new Date().toISOString();
  if (hasDb()) {
    await ensureSchema();
    const existing = await prisma.dailyForm.findUnique({
      where: { date: new Date(`${date}T00:00:00.000Z`) },
      select: { date: true, createdAt: true },
    });
    const recordOnDate = existing ? null : await prisma.record.findFirst({
      where: { date: new Date(`${date}T00:00:00.000Z`) },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true },
    });
    if (existing || recordOnDate) {
      const stamp = existing?.createdAt || recordOnDate?.createdAt || createdAt;
      res.status(200).json({ ok: false, exists: true, form: { date, createdAt: stamp } });
      return;
    }
    await prisma.dailyForm.upsert({
      where: { date: new Date(`${date}T00:00:00.000Z`) },
      create: { date: new Date(`${date}T00:00:00.000Z`), createdAt: new Date(createdAt) },
      update: {},
    });
  } else {
    const db = await readJsonDb();
    if (formDateExists(db.dailyForms, db.records, date)) {
      res.status(200).json({ ok: false, exists: true, form: { date, createdAt } });
      return;
    }
    db.dailyForms = [...(db.dailyForms || []), { date, createdAt }];
    await writeJsonDb(db);
  }
  res.status(201).json({ ok: true, exists: false, form: { date, createdAt } });
}));

app.get('/api/daily-forms', asyncHandler(async (_req, res) => {
  const db = await readDb();
  res.json({ ok: true, forms: db.dailyForms || [] });
}));

app.post('/api/sync/retry', asyncHandler(async (_req, res) => {
  const db = await readDb();
  const pending = db.records.filter((record) => record.syncStatus !== 'synced');
  if (hasDb()) {
    try {
      const result = await syncRecordsToGoogle(pending);
      const remoteRecords = await pullRecordsFromGoogle();
      const syncedAt = new Date().toISOString();
      const latest = await mergeGoogleRecordsIntoPostgres(db.records, remoteRecords, syncedAt, {
        at: syncedAt,
        status: 'synced',
        detail: { ...result, pulled: remoteRecords.length },
      });
      res.json({ ok: true, sync: { status: 'synced', ...result, pulled: remoteRecords.length }, records: latest.records });
    } catch (error) {
      const latest = await mergeGoogleRecordsIntoPostgres(db.records, [], null, {
        status: 'pending',
        error: error.message,
      });
      res.status(202).json({ ok: true, sync: { status: 'pending', error: error.message }, records: latest.records });
    }
    return;
  }
  try {
    const result = await syncRecordsToGoogle(pending);
    const remoteRecords = await pullRecordsFromGoogle();
    const syncedAt = new Date().toISOString();
    const pushedRecords = db.records.map((record) => record.syncStatus !== 'synced'
      ? { ...record, syncStatus: 'synced', syncError: '', syncedAt }
      : record);
    db.records = mergeRecords(pushedRecords, remoteRecords);
    db.syncEvents.push({ at: syncedAt, status: 'synced', detail: { ...result, pulled: remoteRecords.length } });
    await writeJsonDb(db);
    res.json({ ok: true, sync: { status: 'synced', ...result, pulled: remoteRecords.length }, records: db.records });
  } catch (error) {
    db.syncEvents.push({ at: new Date().toISOString(), status: 'pending', error: error.message });
    await writeJsonDb(db);
    res.status(202).json({ ok: true, sync: { status: 'pending', error: error.message }, records: db.records });
  }
}));

app.post('/api/sync/pull', asyncHandler(async (_req, res) => {
  const db = await readDb();
  if (hasDb()) {
    try {
      const remoteRecords = await pullRecordsFromGoogle();
      const pulledAt = new Date().toISOString();
      const latest = await mergeGoogleRecordsIntoPostgres(db.records, remoteRecords, null, {
        at: pulledAt,
        status: 'pulled',
        detail: { pulled: remoteRecords.length },
      });
      res.json({ ok: true, sync: { status: 'pulled', pulled: remoteRecords.length }, records: latest.records });
    } catch (error) {
      const latest = await mergeGoogleRecordsIntoPostgres(db.records, [], null, {
        status: 'pull-failed',
        error: error.message,
      });
      res.status(202).json({ ok: true, sync: { status: 'pending', error: error.message }, records: latest.records });
    }
    return;
  }
  try {
    const remoteRecords = await pullRecordsFromGoogle();
    db.records = mergeRecords(db.records, remoteRecords);
    db.syncEvents.push({ at: new Date().toISOString(), status: 'pulled', detail: { pulled: remoteRecords.length } });
    await writeJsonDb(db);
    res.json({ ok: true, sync: { status: 'pulled', pulled: remoteRecords.length }, records: db.records });
  } catch (error) {
    db.syncEvents.push({ at: new Date().toISOString(), status: 'pull-failed', error: error.message });
    await writeJsonDb(db);
    res.status(202).json({ ok: true, sync: { status: 'pending', error: error.message }, records: db.records });
  }
}));

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Central error handler: always answer JSON so the frontend never hangs on
// a rejected readDb()/writeDb() (previously: unhandled rejection + retry loop).
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('API error:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: err?.message || 'Server error.' });
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
  // NOTE: this is NOT a working fallback. hasDb() is still true, so every API
  // request re-runs ensureSchema() and answers 500 until the schema is fixed.
  // Only a missing DATABASE_URL switches this process to the JSON store.
  console.warn('⚠ PostgreSQL unreachable — API requests will fail with 500 until the schema is applied (run: npm run prisma:deploy or apply server/schema.sql).');
  app.listen(port, () => {
    console.log(`Laundry Tracking PWA running at http://localhost:${port}`);
  });
});

export { cleanRecord, syncRecordsToGoogle };
