import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import type { AppConfig } from './config.js';
import type { Db } from './db/pool.js';
import { HttpError } from './lib/errors.js';
import { hashIp } from './lib/crypto.js';
import { AuditService } from './services/audit.js';
import { BuildingService } from './services/buildings.js';
import { SessionService } from './services/sessions.js';
import { UserService } from './services/users.js';
import { AlarmEngine } from './services/alarm-engine.js';
import { AlarmService } from './services/alarms.js';
import { CollectorService } from './services/collectors.js';
import { RealtimeHub } from './services/realtime.js';
import { FileService } from './services/files.js';
import { FloorService } from './services/floors.js';
import { PointImportService } from './services/point-import.js';
import { ClamdScanner, NoopScanner, type FileScanner } from './services/scanner.js';
import { EntraOidcProvider, type OidcProvider } from './auth/oidc.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { buildingRoutes } from './routes/buildings.js';
import { adminRoutes } from './routes/admin.js';
import { alarmRoutes } from './routes/alarms.js';
import { ingestRoutes } from './routes/ingest.js';
import { wsRoutes } from './routes/ws.js';
import { floorRoutes } from './routes/floors.js';

export interface Services {
  audit: AuditService;
  users: UserService;
  sessions: SessionService;
  buildings: BuildingService;
  alarms: AlarmService;
  engine: AlarmEngine;
  collectors: CollectorService;
  files: FileService;
  floors: FloorService;
  pointImport: PointImportService;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    db: Db;
    services: Services;
    oidc: OidcProvider | null;
    hub: RealtimeHub;
    /** Runs periodic jobs once (watchdog, WS session refresh, purge). Exposed for tests. */
    runJobs: () => Promise<void>;
    cookieNames: { session: string; login: string };
  }
}

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  oidc?: OidcProvider | null;
  logger?: FastifyServerOptions['logger'];
  /** Override the upload scanner (tests). */
  scanner?: FileScanner;
  /** Start interval timers for background jobs (disabled in tests). */
  backgroundJobs?: boolean;
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
    alarms: new AlarmService(db, config.COLLECTOR_STALE_SECONDS),
    engine: new AlarmEngine(db),
    collectors: new CollectorService(db, config.COLLECTOR_STALE_SECONDS),
    files: new FileService(
      db,
      opts.scanner ??
        (config.UPLOAD_SCANNER === 'clamav'
          ? new ClamdScanner(config.CLAMAV_HOST, config.CLAMAV_PORT, config.CLAMAV_TIMEOUT_MS)
          : new NoopScanner()),
    ),
    floors: new FloorService(db),
    pointImport: new PointImportService(db),
  });
  app.decorate('hub', new RealtimeHub(db, app.services.sessions));
  app.decorate('runJobs', async () => {
    app.hub.notify(await app.services.engine.checkCollectors(config.COLLECTOR_STALE_SECONDS));
    await app.hub.refresh();
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
  await app.register(websocket, { options: { maxPayload: 1024 } });
  await app.register(rateLimit, { max: config.RATE_LIMIT_MAX, timeWindow: '1 minute' });

  // Raw bodies for floor-plan uploads and CSV import (size limits are set per route).
  app.addContentTypeParser(['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.addContentTypeParser(['text/csv', 'text/plain'], { parseAs: 'string' }, (_req, body, done) => done(null, body));

  // CSRF defence in depth (on top of SameSite cookies): state-changing requests must come from our origin.
  app.addHook('onRequest', async (req) => {
    req.ipHash = hashIp(req.ip, config.AUDIT_IP_PEPPER);
    // Collectors are not browsers: no cookies, bearer-token auth (see routes/ingest.ts).
    if (SAFE_METHODS.has(req.method) || req.url.startsWith('/ingest/')) return;
    const origin = req.headers.origin;
    if (origin !== config.PUBLIC_ORIGIN) {
      throw new HttpError(403, 'bad_origin', 'Cross-origin request rejected');
    }
  });

  // Session resolution (onRequest so it is available to preValidation, e.g. the WebSocket upgrade).
  // Absence of a valid session is not an error here; guards decide.
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/ingest/')) return;
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
  await app.register(alarmRoutes, { prefix: '/api' });
  await app.register(wsRoutes, { prefix: '/api' });
  await app.register(floorRoutes, { prefix: '/api' });
  await app.register(ingestRoutes);

  if (opts.backgroundJobs ?? true) {
    const jobs = setInterval(() => {
      app.runJobs().catch((err: unknown) => app.log.error({ err }, 'background job failed'));
    }, 10_000);
    jobs.unref();
    app.addHook('onClose', async () => clearInterval(jobs));
  }
  app.addHook('preClose', async () => app.hub.closeAll());

  return app;
}
