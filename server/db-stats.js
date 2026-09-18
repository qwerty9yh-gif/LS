// Reusable DB inspection helper. Usage: node server/db-stats.js
import 'dotenv/config';
import pg from 'pg';

for (const label of ['DIRECT_URL', 'DATABASE_URL']) {
  const cs = process.env[label];
  if (!cs) { console.log(`${label}=not set`); continue; }
  const pool = new pg.Pool({ connectionString: cs, max: 1 });
  try {
    const info = await pool.query(
      `SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS addr, inet_server_port() AS port`
    );
    console.log(`[${label}] db=${info.rows[0].db} user=${info.rows[0].usr} addr=${info.rows[0].addr}:${info.rows[0].port}`);
    for (const t of ['records', 'locks', 'sync_events', 'users']) {
      try {
        const r = await pool.query(`SELECT COUNT(*) AS c FROM ${t}`);
        console.log(`[${label}] rows ${t}=${r.rows[0].c}`);
      } catch (err) {
        console.log(`[${label}] rows ${t}=MISSING (${err.message.split('\n')[0]})`);
      }
    }
    if (label === 'DIRECT_URL') {
      const u = await pool.query('SELECT id, email, created_at FROM users ORDER BY created_at');
      for (const row of u.rows) console.log(`[${label}] user: ${row.email} (created ${row.created_at?.toISOString?.() || row.created_at})`);
    }
  } catch (err) {
    console.log(`[${label}] ERROR: ${err.message.split('\n')[0]}`);
  } finally {
    await pool.end();
  }
}
