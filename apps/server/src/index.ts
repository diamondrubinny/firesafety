import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { lockAuditLog, migrate } from './db/migrate.js';
import { buildApp } from './app.js';

const config = loadConfig();
if (config.OUTBOUND_PROXY_FROM_ENV) {
  // Organisation egress proxy for providers / Entra (HTTPS_PROXY, NO_PROXY).
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new EnvHttpProxyAgent());
}
const db = createPool(config);
if (config.MIGRATION_DATABASE_URL) {
  // Migrations run with the schema owner; the server itself uses the restricted app role.
  const owner = createPool({ DATABASE_URL: config.MIGRATION_DATABASE_URL, DATABASE_SSL: config.DATABASE_SSL });
  try {
    await migrate(owner);
    await lockAuditLog(owner);
  } finally {
    await owner.end();
  }
} else {
  await migrate(db);
}
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
