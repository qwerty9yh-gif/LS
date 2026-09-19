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

    let migratedRecords = 0;
    let updatedRecords = 0;
    let migratedLocks = 0;
    let migratedSyncEvents = 0;

    // 3. Upsert records
    for (const rec of records) {
      const before = await client.query('SELECT id FROM records WHERE id = $1', [rec.id]);
      await client.query(
        `INSERT INTO records (id, date, shift, material, color, row_key, quantity, laundry_personnel, verified_by, signature, status, sync_status, sync_error, created_at, updated_at, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (id) DO UPDATE SET
           date = EXCLUDED.date,
           shift = EXCLUDED.shift,
           material = EXCLUDED.material,
           color = EXCLUDED.color,
           row_key = EXCLUDED.row_key,
           quantity = EXCLUDED.quantity,
           laundry_personnel = EXCLUDED.laundry_personnel,
           verified_by = EXCLUDED.verified_by,
           signature = EXCLUDED.signature,
           status = EXCLUDED.status,
           sync_status = EXCLUDED.sync_status,
           sync_error = EXCLUDED.sync_error,
           created_at = EXCLUDED.created_at,
           updated_at = EXCLUDED.updated_at,
           synced_at = EXCLUDED.synced_at`,
        [
          rec.id,
          rec.date,
          rec.shift,
          rec.material || '',
          rec.color || '',
          rec.rowKey || '',
          rec.quantity === '' || rec.quantity === null || rec.quantity === undefined ? null : Number(rec.quantity),
          rec.laundryPersonnel || '',
          rec.verifiedBy || '',
          rec.signature || '',
          rec.status || 'received',
          rec.syncStatus || 'pending',
          rec.syncError || '',
          rec.createdAt ? new Date(rec.createdAt) : new Date(),
          rec.updatedAt ? new Date(rec.updatedAt) : new Date(),
          rec.syncedAt ? new Date(rec.syncedAt) : null,
        ]
      );
      if (before.rowCount === 0) migratedRecords++;
      else updatedRecords++;
    }

    // 4. Upsert locks
    for (const lock of locks) {
      await client.query(
        `INSERT INTO locks (date, shift, locked_at, reason)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (date, shift) DO UPDATE SET
           locked_at = EXCLUDED.locked_at,
           reason = EXCLUDED.reason`,
        [
          lock.date,
          lock.shift,
          lock.lockedAt ? new Date(lock.lockedAt) : new Date(),
          lock.reason || 'Shift closed',
        ]
      );
      migratedLocks++;
    }

    // 5. Insert sync events (append-only, idempotent on re-runs)
    // Legacy JSON events have no unique key, so skip rows that already
    // exist with the same (at, status, error) to keep re-runs safe.
    // Events created by the running server AFTER a migration are kept.
    for (const ev of syncEvents) {
      const at = ev.at ? new Date(ev.at) : new Date();
      const status = ev.status || '';
      const error = ev.error || null;
      const existing = await client.query(
        `SELECT id FROM sync_events
          WHERE at = $1 AND status = $2 AND COALESCE(error, '') = COALESCE($3, '')
          LIMIT 1`,
        [at, status, error]
      );
      if (existing.rowCount > 0) continue;
      await client.query(
        `INSERT INTO sync_events (at, status, error, detail)
         VALUES ($1,$2,$3,$4)`,
        [
          at,
          status,
          error,
          ev.detail ? JSON.stringify(ev.detail) : null,
        ]
      );
      migratedSyncEvents++;
    }

    console.log(`→ Records: ${migratedRecords} new, ${updatedRecords} updated (out of ${records.length} total)`);
    console.log(`→ Locks: ${migratedLocks} migrated`);
    console.log(`→ Sync events: ${migratedSyncEvents} migrated`);

    // 6. Verify counts
    const recCount = await client.query('SELECT COUNT(*) FROM records');
    const lockCount = await client.query('SELECT COUNT(*) FROM locks');
    const syncCount = await client.query('SELECT COUNT(*) FROM sync_events');
    console.log(`✓ Verification: records=${recCount.rows[0].count}, locks=${lockCount.rows[0].count}, sync_events=${syncCount.rows[0].count}`);
    console.log('✓ Migration complete.');
  } catch (err) {
    console.error('✖ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
