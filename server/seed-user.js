/**
 * Seeds the ONE universal login account for the whole application.
 *
 * - Applies the schema first (creates the users table if missing).
 * - Upserts the universal account with a scrypt-hashed password.
 * - Deletes ANY other user rows, guaranteeing exactly one account.
 *
 * Credentials come from UNIVERSAL_EMAIL / UNIVERSAL_PASSWORD env vars, with
 * the documented defaults. Usage: npm run seed:user
 */
import 'dotenv/config';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, 'schema.sql');

const EMAIL = (process.env.UNIVERSAL_EMAIL || 'qwerty@gmail.com').toLowerCase();
const PASSWORD = process.env.UNIVERSAL_PASSWORD || '123456789';

const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('✖ DATABASE_URL (or DIRECT_URL) is not set in the environment.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString, max: 1 });
const client = await pool.connect();

try {
  console.log('→ Applying schema...');
  await client.query(await readFile(schemaPath, 'utf8'));
  console.log('  Schema applied.');

  await client.query('BEGIN');

  // 1. Remove any other accounts (the system has exactly one shared login).
  const removed = await client.query('DELETE FROM users WHERE email <> $1', [EMAIL]);

  // 2. Upsert the universal account.
  await client.query(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       updated_at = NOW()`,
    [EMAIL, hashPassword(PASSWORD)]
  );

  const count = await client.query('SELECT COUNT(*) AS c, COALESCE(string_agg(email, \', \'), \'-\') AS emails FROM users');
  await client.query('COMMIT');

  console.log(`→ Removed ${removed.rowCount} other account(s).`);
  console.log(`✓ Universal account ready: ${EMAIL}`);
  console.log(`✓ Users in database: ${count.rows[0].c} (${count.rows[0].emails})`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('✖ Seeding failed:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
