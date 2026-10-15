import type { FastifyPluginAsync } from 'fastify';
import { alarmAckSchema, alarmListQuerySchema, alarmNoteSchema, idParamSchema } from '@firesafety/shared';
import { requireAuth, requireRole, requireUser } from '../auth/guards.js';
import { notFound, parse } from '../lib/errors.js';
import { scopeFor } from '../services/scope.js';

export const alarmRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  app.addHook('preHandler', requireAuth);

  app.get('/alarms', async (req) => services.alarms.list(scopeFor(requireUser(req)), parse(alarmListQuerySchema, req.query)));

  app.get('/alarms/summary', async (req) => services.alarms.summary(scopeFor(requireUser(req))));

  app.get('/alarms/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParamSchema, req.params);
    const alarm = await services.alarms.get(id, scopeFor(user));
    if (!alarm) {
      await services.audit.write({ userId: user.id, action: 'alarm.read', entity: 'alarm', entityId: id, outcome: 'denied', ipHash: req.ipHash });
      throw notFound('Alarm');
    }
    return alarm;
  });

  const canHandle = requireRole('Operator', 'SafetyOfficer', 'FireAdmin');

  /** Scope check shared by ack and notes: out-of-scope alarms are indistinguishable from missing ones. */
  async function loadInScope(id: string, userId: string, roles: Parameters<typeof scopeFor>[0]['roles']) {
    const alarm = await services.alarms.get(id, scopeFor({ id: userId, roles }));
    if (!alarm) throw notFound('Alarm');
    return alarm;
  }

  app.post('/alarms/:id/ack', { preHandler: canHandle }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParamSchema, req.params);
    const { note } = parse(alarmAckSchema, req.body ?? {});
    const alarm = await loadInScope(id, user.id, user.roles);
    const acked = await services.alarms.ack(id, user.id);
    if (note) await services.alarms.addNote(id, user.id, note);
    if (acked) {
      await services.audit.write({
        userId: user.id,
        action: 'alarm.ack',
        entity: 'alarm',
        entityId: id,
        outcome: 'success',
        ipHash: req.ipHash,
        details: { category: alarm.category, withNote: !!note },
      });
      app.hub.notify([{ buildingId: alarm.buildingId, category: alarm.category, kind: alarm.kind }]);
    }
    return { acked, alreadyAcked: !acked };
  });

  app.post('/alarms/:id/notes', { preHandler: canHandle }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParamSchema, req.params);
    const { text } = parse(alarmNoteSchema, req.body);
    await loadInScope(id, user.id, user.roles);
    await services.alarms.addNote(id, user.id, text);
    await services.audit.write({ userId: user.id, action: 'alarm.note', entity: 'alarm', entityId: id, outcome: 'success', ipHash: req.ipHash });
    return reply.status(201).send({ ok: true });
  });

  app.get('/system/status', async () => services.alarms.systemStatus());
};
