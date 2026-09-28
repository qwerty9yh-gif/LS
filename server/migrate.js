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

async function main() {
  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('✖ DATABASE_URL (or DIRECT_URL) is not set in the environment.');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  const prisma = new PrismaClient({ datasources: { db: { url: connectionString } } });

  try {
    // 1. Ensure schema exists
    console.log('→ Applying schema...');
    const schema = await readFile(schemaPath, 'utf8');
    await client.query(schema);
    console.log('  Schema applied.');

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
