// Temporary diagnostic: apply single DDL statements verbosely (additive only).
import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();
const stmts = [
  "SELECT current_database() AS db, current_schema() AS sch, current_user AS usr, (SELECT string_agg(rolname, ',') FROM pg_roles WHERE rolname = current_user) AS role",
  "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='records' ORDER BY ordinal_position",
  "ALTER TABLE public.records ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE public.records ADD COLUMN IF NOT EXISTS row_key TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE public.records ADD COLUMN IF NOT EXISTS signature TEXT NOT NULL DEFAULT ''",
  "CREATE TABLE IF NOT EXISTS public.daily_forms (date DATE PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
  "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='records' AND column_name IN ('color','row_key','signature')",
  "SELECT to_regclass('public.daily_forms') AS daily_forms",
  "CREATE INDEX IF NOT EXISTS idx_records_monthly ON public.records (date, material, color)",
];
try {
  for (const stmt of stmts) {
    try {
      const res = await client.query(stmt);
      const brief = Array.isArray(res.rows) && res.rows.length
        ? JSON.stringify(res.rows).slice(0, 300)
        : `(rows=${res.rowCount})`;
      console.log('OK  ', stmt.slice(0, 80), '=>', brief);
    } catch (err) {
      console.log('FAIL', stmt.slice(0, 80), '=>', err.code, err.message);
    }
  }
} finally {
  client.release();
  await pool.end();
}
