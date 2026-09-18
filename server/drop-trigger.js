/**
 * One-off cleanup: drop the legacy `trg_update_records_updated_at` trigger.
 *
 * That trigger (from an earlier version of schema.sql) rewrote updated_at to
 * NOW() on EVERY record UPDATE — including bulk upserts and sync-status
 * flips — so unrelated rows looked freshly edited and last-write-wins merge
 * logic broke. schema.sql no longer creates it; this script removes it from
 * databases that already have it.
 *
 * Usage:  npm run db:drop-trigger
 */
import 'dotenv/config';
import pg from 'pg';

const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('✖ DATABASE_URL (or DIRECT_URL) is not set in the environment.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString, max: 1 });
try {
  await pool.query('DROP TRIGGER IF EXISTS trg_update_records_updated_at ON records');
  await pool.query('DROP FUNCTION IF EXISTS update_updated_at_column()');
  console.log('✓ Legacy updated_at trigger removed (if it existed).');
} catch (err) {
  console.error('✖ Cleanup failed:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
