// Read-only production connectivity + schema audit.
// Runs SELECTs only — it never writes, never runs DDL. Safe to run on prod.
//   node server/db-audit.js
import 'dotenv/config';
import pg from 'pg';

function mask(url) {
  if (!url) return '(unset)';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username || '?'}:***@${u.hostname}:${u.port || 5432}${u.pathname}${u.search || ''}`;
  } catch {
    return url.replace(/:[^:@/]+@/, ':***@');
  }
}

async function audit(label, url) {
  console.log(`\n=== ${label} ===`);
  console.log('target:', mask(url));
  if (!url) {
    console.log('(skipped: not configured)');
    return;
  }
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15000 });
  try {
    const info = await pool.query(
      `SELECT current_database() AS db, current_user AS usr, version() AS v`,
    );
    const { db, usr, v } = info.rows[0];
    console.log(`connected: db=${db} user=${usr}`);
    console.log(`server: ${String(v).split(',')[0]}`);

    const cols = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'records'
        ORDER BY ordinal_position`,
    );
    if (!cols.rows.length) {
      console.log('✖ public.records does NOT exist yet on this database');
    } else {
      const expected = ['id', 'date', 'shift', 'material', 'color', 'row_key', 'quantity',
        'laundry_personnel', 'verified_by', 'signature', 'status', 'sync_status',
        'sync_error', 'created_at', 'updated_at', 'synced_at'];
      const present = new Set(cols.rows.map((r) => r.column_name));
      const missing = expected.filter((c) => !present.has(c));
      const extra = [...present].filter((c) => !expected.includes(c));
      console.log(`records columns: ${present.size} present` +
        (missing.length ? ` | MISSING: ${missing.join(', ')}` : ' | all expected columns present') +
        (extra.length ? ` | extra: ${extra.join(', ')}` : ''));
    }

    for (const t of ['records', 'locks', 'daily_forms', 'shift_orders', 'sync_events', 'users']) {
      try {
        const r = await pool.query(`SELECT COUNT(*)::int AS c FROM public.${t}`);
        console.log(`rows ${t} = ${r.rows[0].c}`);
      } catch (err) {
        console.log(`rows ${t} = ERROR ${err.message}`);
      }
    }

    try {
      const order = await pool.query(
        `SELECT shift, display_order FROM public.shift_orders ORDER BY display_order, shift`,
      );
      console.log('shift order:', JSON.stringify(order.rows));
    } catch (err) {
      console.log('shift order: ERROR', err.message);
    }

    try {
      const span = await pool.query(
        `SELECT to_char(MIN(date), 'YYYY-MM-DD') AS first_day,
                to_char(MAX(date), 'YYYY-MM-DD') AS last_day,
                COUNT(DISTINCT date)::int AS days,
                SUM(CASE WHEN sync_status = 'synced' THEN 1 ELSE 0 END)::int AS synced,
                SUM(CASE WHEN sync_status = 'pending' THEN 1 ELSE 0 END)::int AS pending
           FROM public.records`,
      );
      console.log('records span:', JSON.stringify(span.rows[0]));
    } catch (err) {
      console.log('records span: ERROR', err.message);
    }

    const idx = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'records' ORDER BY indexname`,
    );
    console.log('records indexes:', idx.rows.map((r) => r.indexname).join(', ') || '(none)');

    const trg = await pool.query(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
         AND tgrelid = 'public.records'::regclass`,
    ).catch(() => ({ rows: [] }));
    console.log('records triggers:', trg.rows.length ? trg.rows.map((r) => r.tgname).join(', ') : '(none — expected)');
  } finally {
    await pool.end();
  }
}

await audit('DIRECT_URL', process.env.DIRECT_URL);
if (process.env.DATABASE_URL && process.env.DATABASE_URL !== process.env.DIRECT_URL) {
  await audit('DATABASE_URL', process.env.DATABASE_URL);
} else if (!process.env.DIRECT_URL) {
  await audit('DATABASE_URL', process.env.DATABASE_URL);
}
console.log('\nAudit is read-only: no writes were issued.');
