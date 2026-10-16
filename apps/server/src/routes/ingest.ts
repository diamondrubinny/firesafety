import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { ingestBatchSchema, type IngestResponse } from '@firesafety/shared';
import { HttpError, parse } from '../lib/errors.js';
import type { CollectorIdentity } from '../services/alarm-engine.js';

declare module 'fastify' {
  interface FastifyRequest {
    collector?: CollectorIdentity;
  }
}

const TOKEN_RE = /^Bearer (fsc_[A-Za-z0-9_-]{20,100})$/;

/**
 * Machine-to-machine endpoint for on-site collectors. Authenticated by a per-collector
 * bearer token; cookies are ignored and the browser Origin check does not apply.
 * The token is checked in onRequest, before the (up to 5MB) body is read or parsed.
 */
export const ingestRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/ingest/v1/batch',
    {
      bodyLimit: 5 * 1024 * 1024,
      config: {
        rateLimit: {
          // Per collector (token), not per IP: a stolen token cannot flood from many addresses.
          max: 120,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => createHash('sha256').update(req.headers.authorization ?? req.ip).digest('base64url'),
        },
      },
      onRequest: async (req) => {
        const match = TOKEN_RE.exec(req.headers.authorization ?? '');
        const collector = match ? await app.services.collectors.authenticate(match[1]!) : null;
        if (!collector) {
          // Throttled: repeated failures from the same source produce one audit row per minute.
          await app.services.audit.writeThrottled(`ingest.auth:${req.ipHash}`, { action: 'ingest.auth', outcome: 'denied', ipHash: req.ipHash });
          throw new HttpError(401, 'unauthorized', 'Invalid collector credentials');
        }
        req.collector = collector;
      },
    },
    async (req): Promise<IngestResponse> => {
      const batch = parse(ingestBatchSchema, req.body);
      const { ackedSeq, changes } = await app.services.engine.ingest(req.collector!, batch);
      app.hub.notify(changes);
      return { ackedSeq };
    },
  );
};
