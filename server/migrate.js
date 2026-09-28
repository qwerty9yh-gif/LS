/**
 * Migration script: JSON file → PostgreSQL
 *
 * Reads the existing data/records.json (the legacy file-based store) and
 * upserts all records, locks, and sync events into PostgreSQL.
 *
 * Usage:  node server/migrate.js
 */
import 'dotenv/config';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const dbPath = path.join(dataDir, 'records.json');
const schemaPath = path.join(__dirname, 'schema.sql');

/** Split SQL on semicolons, ignoring those inside quotes/comments/$$ blocks. */
function splitSchemaStatements(sql) {
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
  return statements.filter((stmt) => {
    const sql = stmt.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/g, '').trim();
    return sql.length > 0;
  });
}

async function main() {
  // `--schema-only` = apply the additive DDL and stop. Use this to heal a
  // production database (missing columns / missing daily_forms) WITHOUT
  // pushing the local data/records.json into it.
  const schemaOnly = process.argv.slice(2).includes('--schema-only');
  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('✖ DATABASE_URL (or DIRECT_URL) is not set in the environment.');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  const prisma = new PrismaClient({ datasources: { db: { url: connectionString } } });

  try {
    // 1. Ensure schema exists. Statements run one-by-one on this dedicated
    // client (never one multi-statement query) so a mid-file failure cannot
    // silently leave `records` without its `color` column on the pooler.
    // Indexes run last: an index may reference a column a later ALTER adds,
    // and failing that statement used to abort the whole schema apply.
    console.log('→ Applying schema...' + (schemaOnly ? ' (schema-only mode: no data is written)' : ''));
    const schema = await readFile(schemaPath, 'utf8');
    const statements = splitSchemaStatements(schema);
    const isIndex = (stmt) => /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(stmt);
    const runStatement = async (stmt, { tolerateMissingColumn = false } = {}) => {
      try {
        await client.query(stmt);
      } catch (stmtErr) {
        const code = stmtErr?.code;
        const msg = stmtErr?.message || '';
        if (code === '42P07' || code === '42710' || code === '42701' || /already exists/i.test(msg)) {
          return;
        }
        if (tolerateMissingColumn && code === '42703' && /does not exist/i.test(msg)) {
          console.warn('  ! skipped index (column missing):', String(stmt).replace(/\s+/g, ' ').slice(0, 90));
          return;
        }
        throw new Error(`Schema statement failed [${code || 'no-code'}]: ${msg}\nStatement: ${String(stmt).slice(0, 160)}`);
      }
    };
    for (const stmt of statements.filter((s) => !isIndex(s))) await runStatement(stmt);
    for (const stmt of statements.filter(isIndex)) await runStatement(stmt, { tolerateMissingColumn: true });
    console.log('  Schema applied.');

    if (schemaOnly) {
      const counts = await Promise.all([
        prisma.record.count(),
        prisma.lock.count(),
        prisma.dailyForm.count(),
        prisma.syncEvent.count(),
      ]);
      console.log(`✓ Schema healed. Untouched data counts: records=${counts[0]}, locks=${counts[1]}, daily_forms=${counts[2]}, sync_events=${counts[3]}`);
      console.log('  (run "npm run migrate" without --schema-only to also import data/records.json)');
      return;
    }

    // 2. Check for legacy JSON data
    if (!existsSync(dbPath)) {
      console.log('→ No legacy data/records.json found. Nothing to migrate.');
      console.log('✓ Migration complete (no data).');
      return;
    }

    const raw = await readFile(dbPath, 'utf8');
    const db = JSON.parse(raw);

    const records = db.records || [];
    const locks = db.locks || [];
    const syncEvents = db.syncEvents || [];
    const dailyForms = db.dailyForms || [];

    const migrationResult = await prisma.$transaction(async (tx) => {
      let migratedRecords = 0;
      let updatedRecords = 0;
      let migratedLocks = 0;
      let migratedForms = 0;
      let migratedSyncEvents = 0;

      for (const rec of records) {
        const existing = await tx.record.findUnique({ where: { id: rec.id }, select: { id: true } });
        const date = new Date(`${rec.date}T00:00:00.000Z`);
        await tx.record.upsert({
          where: { id: rec.id },
          create: {
            id: rec.id,
            date,
            shift: rec.shift,
            material: rec.material || '',
            color: rec.color || '',
            rowKey: rec.rowKey || '',
            quantity: rec.quantity === '' || rec.quantity === null || rec.quantity === undefined ? null : Number(rec.quantity),
            laundryPersonnel: rec.laundryPersonnel || '',
            verifiedBy: rec.verifiedBy || '',
            signature: rec.signature || '',
            status: rec.status || 'received',
            syncStatus: rec.syncStatus || 'pending',
            syncError: rec.syncError || '',
            createdAt: rec.createdAt ? new Date(rec.createdAt) : new Date(),
            updatedAt: rec.updatedAt ? new Date(rec.updatedAt) : new Date(),
            syncedAt: rec.syncedAt ? new Date(rec.syncedAt) : null,
          },
          update: {
            date,
            shift: rec.shift,
            material: rec.material || '',
            color: rec.color || '',
            rowKey: rec.rowKey || '',
            quantity: rec.quantity === '' || rec.quantity === null || rec.quantity === undefined ? null : Number(rec.quantity),
            laundryPersonnel: rec.laundryPersonnel || '',
            verifiedBy: rec.verifiedBy || '',
            signature: rec.signature || '',
            status: rec.status || 'received',
            syncStatus: rec.syncStatus || 'pending',
            syncError: rec.syncError || '',
            createdAt: rec.createdAt ? new Date(rec.createdAt) : new Date(),
            updatedAt: rec.updatedAt ? new Date(rec.updatedAt) : new Date(),
            syncedAt: rec.syncedAt ? new Date(rec.syncedAt) : null,
          },
        });
        if (existing) updatedRecords++;
        else migratedRecords++;
      }

      for (const lock of locks) {
        const date = new Date(`${lock.date}T00:00:00.000Z`);
        await tx.lock.upsert({
          where: { date_shift: { date, shift: lock.shift } },
          create: {
            date,
            shift: lock.shift,
            lockedAt: lock.lockedAt ? new Date(lock.lockedAt) : new Date(),
            reason: lock.reason || 'Shift closed',
          },
          update: {
            lockedAt: lock.lockedAt ? new Date(lock.lockedAt) : new Date(),
            reason: lock.reason || 'Shift closed',
          },
        });
        migratedLocks++;
      }

      for (const form of dailyForms) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(form.date || ''))) continue;
        const date = new Date(`${form.date}T00:00:00.000Z`);
        await tx.dailyForm.upsert({
          where: { date },
          create: { date, createdAt: form.createdAt ? new Date(form.createdAt) : new Date() },
          update: {},
        });
        migratedForms++;
      }

      for (const ev of syncEvents) {
        const at = ev.at ? new Date(ev.at) : new Date();
        const status = ev.status || '';
        const error = ev.error || null;
        const existing = await tx.syncEvent.findFirst({ where: { at, status, error }, select: { id: true } });
        if (existing) continue;
        await tx.syncEvent.create({
          data: { at, status, error, detail: ev.detail || undefined },
        });
        migratedSyncEvents++;
      }

      return { migratedRecords, updatedRecords, migratedLocks, migratedForms, migratedSyncEvents };
    }, { maxWait: 10000, timeout: 120000 });

    const { migratedRecords, updatedRecords, migratedLocks, migratedForms, migratedSyncEvents } = migrationResult;

    console.log(`→ Records: ${migratedRecords} new, ${updatedRecords} updated (out of ${records.length} total)`);
    console.log(`→ Locks: ${migratedLocks} migrated`);
    console.log(`→ Daily forms: ${migratedForms} migrated`);
    console.log(`→ Sync events: ${migratedSyncEvents} migrated`);

    // 6. Verify counts
    const verification = await Promise.all([
      prisma.record.count(),
      prisma.lock.count(),
      prisma.dailyForm.count(),
      prisma.syncEvent.count(),
    ]);
    console.log(`✓ Verification: records=${verification[0]}, locks=${verification[1]}, daily_forms=${verification[2]}, sync_events=${verification[3]}`);
    console.log('✓ Migration complete.');
  } catch (err) {
    console.error('✖ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
    client.release();
    await pool.end();
  }
}

main();
