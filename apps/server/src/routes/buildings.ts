import type { FastifyPluginAsync } from 'fastify';
import { idParamSchema } from '@firesafety/shared';
import { requireAuth, requireUser } from '../auth/guards.js';
import { notFound, parse } from '../lib/errors.js';
import { scopeFor } from '../services/scope.js';

export const buildingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/faculties', async () => app.services.buildings.listFaculties());

  app.get('/buildings', async (req) => app.services.buildings.list(scopeFor(requireUser(req))));

  app.get('/buildings/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParamSchema, req.params);
    const building = await app.services.buildings.get(id, scopeFor(user));
    if (!building) {
      // Same 404 for "missing" and "not yours"; the attempt is still audited.
      await app.services.audit.write({ userId: user.id, action: 'building.read', entity: 'building', entityId: id, outcome: 'denied', ipHash: req.ipHash });
      throw notFound('Building');
    }
    return building;
  });
};
