/**
 * Clears ALL application data (test/demo/seed records) from the database
 * while keeping the schema, tables, relationships and migrations intact.
 *
 * Clears: records, locks, sync_events, daily_forms. Keeps: users (login accounts).
 * Usage: npm run db:clear
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('✖ DATABASE_URL (or DIRECT_URL) is not set in the environment.');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: connectionString } } });

try {
  const [records, locks, syncEvents, dailyForms] = await prisma.$transaction([
    prisma.record.deleteMany(),
    prisma.lock.deleteMany(),
    prisma.syncEvent.deleteMany(),
    prisma.dailyForm.deleteMany(),
  ]);
  for (const [table, result] of Object.entries({ records, locks, sync_events: syncEvents, daily_forms: dailyForms })) {
    console.log(`→ Cleared ${table}: ${result.count} row(s) removed`);
  }

  console.log('→ Verification after clearing:');
  const counts = await Promise.all([
    prisma.record.count(),
    prisma.lock.count(),
    prisma.syncEvent.count(),
    prisma.dailyForm.count(),
  ]);
  for (const [table, count] of Object.entries({ records: counts[0], locks: counts[1], sync_events: counts[2], daily_forms: counts[3] })) {
    console.log(`  ${table}=${count}`);
  }
  console.log('✓ Application data cleared. Schema intact.');
} catch (err) {
  console.error('✖ Clearing failed:', err.message);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
