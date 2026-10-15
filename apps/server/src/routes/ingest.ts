import type { FastifyPluginAsync } from 'fastify';
import { ingestBatchSchema, type IngestResponse } from '@firesafety/shared';
import { HttpError, parse } from '../lib/errors.js';

/**
 * Machine-to-machine endpoint for on-site collectors. Authenticated by a per-collector
 * bearer token; cookies are ignored and the browser Origin check does not apply.
 */
export const ingestRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/ingest/v1/batch',
    { bodyLimit: 5 * 1024 * 1024, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req): Promise<IngestResponse> => {
      const header = req.headers.authorization ?? '';
      const match = /^Bearer (fsc_[A-Za-z0-9_-]{20,100})$/.exec(header);
      const collector = match ? await app.services.collectors.authenticate(match[1]!) : null;
      if (!collector) {
        await app.services.audit.write({ action: 'ingest.auth', outcome: 'denied', ipHash: req.ipHash });
        throw new HttpError(401, 'unauthorized', 'Invalid collector credentials');
      }
      const batch = parse(ingestBatchSchema, req.body);
      const { ackedSeq, changes } = await app.services.engine.ingest(collector, batch);
      app.hub.notify(changes);
      return { ackedSeq };
    },
  );
};
