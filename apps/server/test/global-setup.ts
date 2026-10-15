import pg from 'pg';
import { migrate } from '../src/db/migrate.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://firesafety:devpassword@localhost:5432/firesafety_test';

/** Recreates the test schema from scratch and applies all migrations once per run. */
export default async function setup(): Promise<void> {
  const db = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await db.query('DROP SCHEMA IF EXISTS public CASCADE');
    await db.query('CREATE SCHEMA public');
    await migrate(db);
  } finally {
    await db.end();
  }
}
