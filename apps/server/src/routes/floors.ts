import type { FastifyPluginAsync } from 'fastify';
import { idParamSchema } from '@firesafety/shared';
import { requireAuth, requireUser } from '../auth/guards.js';
import { notFound, parse } from '../lib/errors.js';
import { scopeFor } from '../services/scope.js';

export const floorRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  app.addHook('preHandler', requireAuth);

  app.get('/buildings/:id/floors', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParamSchema, req.params);
    const scope = scopeFor(user);
    if (!(await services.buildings.get(id, scope))) throw notFound('Building');
    return services.floors.listForBuilding(id, scope);
  });

  app.get('/floors/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParamSchema, req.params);
    const detail = await services.floors.detail(id, scopeFor(user));
    if (!detail) {
      await services.audit.write({ userId: user.id, action: 'floor.read', entity: 'floor', entityId: id, outcome: 'denied', ipHash: req.ipHash });
      throw notFound('Floor');
    }
    return detail;
  });

  /** Floor-plan images: only scanned/clean files, only within building scope, served inertly. */
  app.get('/files/:id', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParamSchema, req.params);
    const buildingId = await services.floors.buildingOfFile(id);
    const allowed = buildingId && (await services.buildings.get(buildingId, scopeFor(user)));
    const file = allowed ? await services.files.getServable(id) : null;
    if (!file) throw notFound('File');
    const etag = `"${file.sha256.toString('base64url')}"`;
    reply
      .header('Content-Type', file.mime)
      .header('Content-Disposition', 'inline; filename="floor-plan"')
      .header('Cache-Control', 'private, max-age=300')
      .header('ETag', etag)
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('X-Content-Type-Options', 'nosniff');
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.send(file.content);
  });
};
