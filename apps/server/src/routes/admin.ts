import type { FastifyPluginAsync } from 'fastify';
import {
  buildingInputSchema,
  collectorInputSchema,
  devicePatchSchema,
  pointListQuerySchema,
  pointPatchSchema,
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
    await app.hub.refresh();
    return { buildingIds: [...new Set(buildingIds)] };
  });

  // Collectors: the token is returned once and never stored in plaintext.
  app.get('/collectors', async () => services.collectors.list());

  app.post('/collectors', async (req, reply) => {
    const { name } = parse(collectorInputSchema, req.body);
    const { collector, token } = await services.collectors.create(name);
    await audit(req, 'collector.create', 'collector', collector.id, { name });
    reply.header('Cache-Control', 'no-store');
    return reply.status(201).send({ collector, token });
  });

  app.post('/collectors/:id/rotate-token', async (req, reply) => {
    const { id } = parse(idParamSchema, req.params);
    const token = await services.collectors.rotateToken(id);
    await audit(req, 'collector.rotate_token', 'collector', id);
    reply.header('Cache-Control', 'no-store');
    return { token };
  });

  app.post('/collectors/:id/deactivate', async (req) => {
    const { id } = parse(idParamSchema, req.params);
    await services.collectors.setActive(id, false);
    await audit(req, 'collector.deactivate', 'collector', id);
    app.hub.broadcast({ type: 'status' });
    return { ok: true };
  });

  // BACnet devices and points: mapping to buildings drives alarm visibility (scope).
  app.get('/devices', async () => services.collectors.listDevices());

  app.patch('/devices/:id', async (req) => {
    const { id } = parse(idParamSchema, req.params);
    const { buildingId } = parse(devicePatchSchema, req.body);
    await services.collectors.patchDevice(id, buildingId);
    await audit(req, 'device.update', 'device', id, { buildingId });
    return { ok: true };
  });

  app.get('/points', async (req) => {
    const q = parse(pointListQuerySchema, req.query);
    return services.collectors.listPoints({ unmapped: q.unmapped === '1', limit: q.limit, offset: q.offset });
  });

  app.patch('/points/:id', async (req) => {
    const { id } = parse(idParamSchema, req.params);
    const patch = parse(pointPatchSchema, req.body);
    await services.collectors.patchPoint(id, patch);
    await audit(req, 'point.update', 'point', id, { fields: Object.keys(patch) });
    return { ok: true };
  });

  // Audit
  app.get('/audit', async (req) => {
    const { limit, offset } = parse(paginationSchema, req.query);
    return services.audit.list(limit, offset);
  });
};
