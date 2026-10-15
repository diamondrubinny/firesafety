import type { FastifyInstance } from 'fastify';
import type { Role } from '@firesafety/shared';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import type { OidcProvider } from '../src/auth/oidc.js';
import { TEST_DATABASE_URL } from './global-setup.js';

export const ORIGIN = 'https://firesafety.test';

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: ORIGIN,
    DATABASE_URL: TEST_DATABASE_URL,
    AUDIT_IP_PEPPER: 'test-pepper-test-pepper-test-pepper-0000',
    AUTH_MODE: 'dev',
    LOG_LEVEL: 'fatal',
    ...overrides,
  });
}

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  close: () => Promise<void>;
}

export async function createTestApp(
  opts: { config?: Record<string, string>; oidc?: OidcProvider | null } = {},
): Promise<TestContext> {
  const config = testConfig(opts.config);
  const db = createPool(config);
  await resetData(db);
  const app = await buildApp({ config, db, oidc: opts.oidc, logger: false });
  await app.ready();
  return {
    app,
    db,
    close: async () => {
      await app.close();
      await db.end();
    },
  };
}

/** TRUNCATE bypasses the append-only row trigger on audit_log; only the test role uses it. */
export async function resetData(db: Db): Promise<void> {
  await db.query(
    'TRUNCATE audit_log, user_building_scope, user_session, oidc_login_state, building, faculty, app_user RESTART IDENTITY CASCADE',
  );
}

/** Logs in through the dev endpoint and returns a Cookie header value. */
export async function loginAs(app: FastifyInstance, email: string, roles: Role[]): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/dev-login',
    headers: { origin: ORIGIN },
    payload: { email, displayName: email.split('@')[0], roles },
  });
  if (res.statusCode !== 204) throw new Error(`dev login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies[0];
  if (!cookie) throw new Error('no session cookie');
  return `${cookie.name}=${cookie.value}`;
}

export const write = (cookie: string) => ({ cookie, origin: ORIGIN });
