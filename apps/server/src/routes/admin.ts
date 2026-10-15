import type { FastifyPluginAsync } from 'fastify';
import {
  buildingInputSchema,
  buildingPatchSchema,
  facultyInputSchema,
  idParamSchema,
  paginationSchema,
  userScopeInputSchema,
} from '@firesafety/shared';
import { requireRole, requireUser } from '../auth/guards.js';
import { parse } from '../lib/errors.js';

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  app.addHook('preHandler', requireRole('FireAdmin'));

  const audit = (req: Parameters<typeof requireUser>[0], action: string, entity: string, entityId: string, details?: Record<string, unknown>) =>
    services.audit.write({ userId: requireUser(req).id, action, entity, entityId, outcome: 'success', ipHash: req.ipHash, details });

  // Faculties
  app.post('/faculties', async (req, reply) => {
    const input = parse(facultyInputSchema, req.body);
    const faculty = await services.buildings.createFaculty(input.name);
    await audit(req, 'faculty.create', 'faculty', faculty.id, { name: faculty.name });
    return reply.status(201).send(faculty);
  });

  app.delete('/faculties/:id', async (req, reply) => {
    const { id } = parse(idParamSchema, req.params);
    await services.buildings.removeFaculty(id);
    await audit(req, 'faculty.delete', 'faculty', id);
    return reply.status(204).send();
  });

  // Buildings
  app.post('/buildings', async (req, reply) => {
    const input = parse(buildingInputSchema, req.body);
    const building = await services.buildings.create(input);
    await audit(req, 'building.create', 'building', building.id, { code: building.code });
    return reply.status(201).send(building);
  });

  app.patch('/buildings/:id', async (req) => {
    const { id } = parse(idParamSchema, req.params);
    const patch = parse(buildingPatchSchema, req.body);
    const building = await services.buildings.update(id, patch);
    await audit(req, 'building.update', 'building', id, { fields: Object.keys(patch) });
    return building;
  });

  app.delete('/buildings/:id', async (req, reply) => {
    const { id } = parse(idParamSchema, req.params);
    await services.buildings.remove(id);
    await audit(req, 'building.delete', 'building', id);
    return reply.status(204).send();
  });

  // Users & scope
  app.get('/users', async (req) => {
    const { limit, offset } = parse(paginationSchema, req.query);
    return services.users.list(limit, offset);
  });

  app.put('/users/:id/scope', async (req) => {
    const { id } = parse(idParamSchema, req.params);
    const { buildingIds } = parse(userScopeInputSchema, req.body);
    const result = await services.users.setScope(id, buildingIds);
    await audit(req, 'user.scope.set', 'user', id, result);
    return { buildingIds: [...new Set(buildingIds)] };
  });

  // Audit
  app.get('/audit', async (req) => {
    const { limit, offset } = parse(paginationSchema, req.query);
    return services.audit.list(limit, offset);
  });
};
