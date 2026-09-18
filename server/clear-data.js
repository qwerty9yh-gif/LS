/**
 * Clears ALL application data (test/demo/seed records) from the database
 * while keeping the schema, tables, relationships and migrations intact.
 *
 * Clears: records, locks, sync_events. Keeps: users (login accounts).
 * Usage: npm run db:clear
 */
import 'dotenv/config';
import pg from 'pg';

const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('✖ DATABASE_URL (or DIRECT_URL) is not set in the environment.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString, max: 1 });
const client = await pool.connect();

try {
  await client.query('BEGIN');
  for (const table of ['records', 'locks', 'sync_events']) {
    const r = await client.query(`DELETE FROM ${table}`);
    console.log(`→ Cleared ${table}: ${r.rowCount} row(s) removed`);
  }
  await client.query('COMMIT');

  console.log('→ Verification after clearing:');
  for (const table of ['records', 'locks', 'sync_events']) {
    const r = await client.query(`SELECT COUNT(*) AS c FROM ${table}`);
    console.log(`  ${table}=${r.rows[0].c}`);
  }
  console.log('✓ Application data cleared. Schema intact.');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('✖ Clearing failed:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
