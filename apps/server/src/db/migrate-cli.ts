import { loadConfig } from '../config.js';
import { createPool } from './pool.js';
import { lockAuditLog, migrate } from './migrate.js';

const config = loadConfig();
const db = createPool(config.MIGRATION_DATABASE_URL ? { DATABASE_URL: config.MIGRATION_DATABASE_URL, DATABASE_SSL: config.DATABASE_SSL } : config);
try {
  const applied = await migrate(db);
  if (config.MIGRATION_DATABASE_URL) await lockAuditLog(db);
  process.stdout.write(applied.length ? `Applied: ${applied.join(', ')}\n` : 'Database is up to date\n');
} finally {
  await db.end();
}
