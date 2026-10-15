import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from './config.js';
import type { Db } from './db/pool.js';
import { HttpError } from './lib/errors.js';
import { hashIp } from './lib/crypto.js';
import { AuditService } from './services/audit.js';
import { BuildingService } from './services/buildings.js';
import { SessionService } from './services/sessions.js';
import { UserService } from './services/users.js';
import { EntraOidcProvider, type OidcProvider } from './auth/oidc.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { buildingRoutes } from './routes/buildings.js';
import { adminRoutes } from './routes/admin.js';

export interface Services {
  audit: AuditService;
  users: UserService;
  sessions: SessionService;
  buildings: BuildingService;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    db: Db;
    services: Services;
    oidc: OidcProvider | null;
    cookieNames: { session: string; login: string };
  }
}

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  oidc?: OidcProvider | null;
  logger?: FastifyServerOptions['logger'];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { config, db } = opts;
  const app = Fastify({
    logger: opts.logger ?? {
      level: config.LOG_LEVEL,
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
        censor: '[redacted]',
      },
    },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 100 * 1024,
  });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('services', {
    audit: new AuditService(db),
    users: new UserService(db),
    sessions: new SessionService(db, {
      idleMinutes: config.SESSION_IDLE_MINUTES,
      absoluteHours: config.SESSION_ABSOLUTE_HOURS,
    }),
    buildings: new BuildingService(db),
  });
  app.decorate(
    'oidc',
    opts.oidc !== undefined ? opts.oidc : config.AUTH_MODE === 'oidc' ? new EntraOidcProvider(config) : null,
  );
  // "__Host-" cookies require Secure, Path=/ and no Domain: they cannot be set by sibling subdomains.
  app.decorate(
    'cookieNames',
    config.COOKIE_SECURE ? { session: '__Host-fs_sid', login: '__Host-fs_login' } : { session: 'fs_sid', login: 'fs_login' },
  );
  app.decorateRequest('user', null);
  app.decorateRequest('ipHash', null);

  await app.register(helmet, {
    // API returns JSON only; the web app's CSP is set by the reverse proxy.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: config.RATE_LIMIT_MAX, timeWindow: '1 minute' });

  // CSRF defence in depth (on top of SameSite cookies): state-changing requests must come from our origin.
  app.addHook('onRequest', async (req) => {
    req.ipHash = hashIp(req.ip, config.AUDIT_IP_PEPPER);
    if (SAFE_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin !== config.PUBLIC_ORIGIN) {
      throw new HttpError(403, 'bad_origin', 'Cross-origin request rejected');
    }
  });

  // Session resolution. Absence of a valid session is not an error here; guards decide.
  app.addHook('preHandler', async (req) => {
    const token = req.cookies[app.cookieNames.session];
    if (token) req.user = await app.services.sessions.resolve(token);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      // Fastify/plugin client errors (body too large, rate limit, malformed JSON...). Messages are safe.
      return reply.status(status).send({ error: (err as { code?: string }).code ?? 'client_error', message: (err as Error).message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal', message: 'An unexpected error occurred' });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found', message: 'Not found' }));

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(meRoutes, { prefix: '/api' });
  await app.register(buildingRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api/admin' });

  return app;
}
