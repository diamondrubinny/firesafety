import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = createPool(config);
await migrate(db);
const app = await buildApp({ config, db });

const purge = setInterval(() => {
  app.services.sessions.purgeExpired().catch((err: unknown) => app.log.error({ err }, 'session purge failed'));
}, 15 * 60 * 1000);
purge.unref();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  clearInterval(purge);
  await app.close();
  await db.end();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
