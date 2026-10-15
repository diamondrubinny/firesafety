import type { FastifyPluginAsync } from 'fastify';
import {
  buildingInputSchema,
  collectorInputSchema,
  devicePatchSchema,
  floorInputSchema,
  floorPatchSchema,
  pointListQuerySchema,
  pointPatchSchema,
  buildingPatchSchema,
  facultyInputSchema,
  idParamSchema,
  paginationSchema,
  userScopeInputSchema,
} from '@firesafety/shared';
import { requireRole, requireUser } from '../auth/guards.js';
import { HttpError, badRequest, parse } from '../lib/errors.js';
import { detectImageType, MAX_PLAN_BYTES } from '../services/files.js';

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
    return services.collectors.listPoints({ unmapped: q.unmapped === '1', buildingId: q.buildingId, limit: q.limit, offset: q.offset });
  });

  app.patch('/points/:id', async (req) => {
    const { id } = parse(idParamSchema, req.params);
    const patch = parse(pointPatchSchema, req.body);
    await services.collectors.patchPoint(id, patch);
    await audit(req, 'point.update', 'point', id, { fields: Object.keys(patch) });
    return { ok: true };
  });

  // CSV import of point mapping (dry-run by default).
  app.post('/points/import', { bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    if (typeof req.body !== 'string') throw badRequest('Expected a text/csv body');
    const dryRun = (req.query as Record<string, unknown>).dryRun !== '0';
    const report = await services.pointImport.run(req.body, dryRun);
    if (!dryRun) {
      await audit(req, 'points.import', 'point', 'bulk', { rows: report.rows, applied: report.applied, errors: report.errors.length });
      app.hub.broadcast({ type: 'status' });
    }
    return report;
  });

  // Floors
  app.post('/buildings/:id/floors', async (req, reply) => {
    const { id } = parse(idParamSchema, req.params);
    const input = parse(floorInputSchema, req.body);
    const floor = await services.floors.create(id, input);
    await audit(req, 'floor.create', 'floor', floor.id, { buildingId: id, level: input.level });
    return reply.status(201).send(floor);
  });

  app.patch('/floors/:id', async (req) => {
    const { id } = parse(idParamSchema, req.params);
    const patch = parse(floorPatchSchema, req.body);
    const floor = await services.floors.update(id, patch);
    await audit(req, 'floor.update', 'floor', id, { fields: Object.keys(patch) });
    return floor;
  });

  app.delete('/floors/:id', async (req, reply) => {
    const { id } = parse(idParamSchema, req.params);
    await services.floors.remove(id);
    await audit(req, 'floor.delete', 'floor', id);
    return reply.status(204).send();
  });

  /** Raw image body (no multipart). Type is decided by the file signature, not by headers. */
  app.put('/floors/:id/plan', { bodyLimit: MAX_PLAN_BYTES, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParamSchema, req.params);
    if (!(await services.floors.get(id, { kind: 'all' }))) throw new HttpError(404, 'not_found', 'Floor not found');
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('Expected an image body');
    const mime = detectImageType(body);
    if (!mime) {
      await services.audit.write({ userId: user.id, action: 'file.upload', entity: 'floor', entityId: id, outcome: 'denied', ipHash: req.ipHash, details: { reason: 'type_not_allowed', size: body.length } });
      throw new HttpError(415, 'unsupported_media_type', 'Only PNG, JPEG or WebP images are allowed');
    }
    const { meta, scan } = await services.files.storePlan(body, mime, user.id);
    if (scan.status === 'infected') {
      await services.audit.write({ userId: user.id, action: 'file.upload', entity: 'file', entityId: meta.id, outcome: 'failure', ipHash: req.ipHash, details: { reason: 'malware_detected', signature: scan.signature, size: body.length } });
      req.log.warn({ fileId: meta.id }, 'SECURITY: infected upload blocked');
      throw new HttpError(422, 'file_rejected', 'The file was rejected by the security scan');
    }
    if (scan.status === 'error') {
      await services.audit.write({ userId: user.id, action: 'file.upload', entity: 'file', entityId: meta.id, outcome: 'failure', ipHash: req.ipHash, details: { reason: 'scan_error' } });
      await services.files.remove(meta.id);
      throw new HttpError(503, 'scan_unavailable', 'The security scan is unavailable; please try again later');
    }
    await services.floors.setPlan(id, meta.id);
    await audit(req, 'file.upload', 'file', meta.id, { floorId: id, mime, size: body.length, scan: scan.status });
    return reply.status(201).send(meta);
  });

  // Audit
  app.get('/audit', async (req) => {
    const { limit, offset } = parse(paginationSchema, req.query);
    return services.audit.list(limit, offset);
  });
};
