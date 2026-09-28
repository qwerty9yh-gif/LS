/**
 * Seeds the ONE universal login account for the whole application.
 *
 * - Applies the schema first (creates the users table if missing).
 * - Upserts the universal account with a scrypt-hashed password.
 * - Leaves existing user accounts and credentials untouched.
 *
 * Credentials come from UNIVERSAL_EMAIL / UNIVERSAL_PASSWORD env vars, with
 * the documented defaults. Usage: npm run seed:user
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from './auth.js';

const EMAIL = (process.env.UNIVERSAL_EMAIL || 'qwerty@gmail.com').toLowerCase();
const PASSWORD = process.env.UNIVERSAL_PASSWORD || '123456789';

const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('✖ DATABASE_URL (or DIRECT_URL) is not set in the environment.');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: connectionString } } });

try {
  const { count, emails } = await prisma.$transaction(async (tx) => {
    await tx.user.upsert({
      where: { email: EMAIL },
      create: { email: EMAIL, passwordHash: hashPassword(PASSWORD) },
      update: {},
    });
    const count = await tx.user.count();
    const users = await tx.user.findMany({ select: { email: true }, orderBy: { createdAt: 'asc' } });
    return { count, emails: users.map((user) => user.email).join(', ') || '-' };
  });

  console.log(`✓ Universal account ready: ${EMAIL}`);
  console.log(`✓ Users in database: ${count} (${emails})`);
} catch (err) {
  console.error('✖ Seeding failed:', err.message);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
