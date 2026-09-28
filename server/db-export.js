// Read-only full export of the live database to a timestamped JSON backup.
// Runs SELECTs only. Use before any schema/migration work so a restore is
// always possible:  node server/db-export.js [--out data/backups]
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function main() {
  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('✖ DATABASE_URL (or DIRECT_URL) is not set.');
    process.exit(1);
  }
  const outArgIndex = process.argv.indexOf('--out');
  const outDir = path.resolve(rootDir, outArgIndex === -1 ? 'data/backups' : process.argv[outArgIndex + 1]);
  await mkdir(outDir, { recursive: true });

  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 15000 });
  try {
    const snapshot = { exportedAt: new Date().toISOString(), tables: {} };
    for (const table of ['records', 'locks', 'daily_forms', 'sync_events', 'users']) {
      try {
        const res = await pool.query(`SELECT * FROM public.${table}`);
        snapshot.tables[table] = res.rows;
        console.log(`→ ${table}: ${res.rowCount} rows`);
      } catch (err) {
        snapshot.tables[table] = { error: err.message };
        console.log(`→ ${table}: unavailable (${err.message})`);
      }
    }
    // Never write password hashes into a backup file.
    const users = snapshot.tables.users;
    if (Array.isArray(users)) {
      snapshot.tables.users = users.map(({ password_hash, ...rest }) => rest);
      snapshot.tables.usersNote = 'password_hash omitted from backup by design';
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(outDir, `db-backup-${stamp}.json`);
    await writeFile(file, JSON.stringify(snapshot, null, 2));
    const total = Object.values(snapshot.tables)
      .reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
    console.log(`✓ Backup written: ${path.relative(rootDir, file)} (${total} rows, read-only export)`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('✖ Export failed:', err.message);
  process.exit(1);
});
