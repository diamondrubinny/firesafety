import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { idParamSchema, procedureInputSchema, procedureStepSchema } from '@firesafety/shared';
import { requireAuth, requireRole, requireUser } from '../auth/guards.js';
import { notFound, parse } from '../lib/errors.js';
import { scopeFor } from '../services/scope.js';

/** Procedure checklist on an alarm (scoped like the alarm itself). */
export const alarmProcedureRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  app.addHook('preHandler', requireAuth);

  async function alarmInScope(req: Parameters<typeof requireUser>[0], id: string) {
    const user = requireUser(req);
    const alarm = await services.alarms.get(id, scopeFor(user));
    if (!alarm) throw notFound('Alarm');
    return { id: alarm.id, category: alarm.category, kind: alarm.kind, buildingId: alarm.buildingId };
  }

  app.get('/alarms/:id/procedure', async (req) => {
    const { id } = parse(idParamSchema, req.params);
    return services.procedures.forAlarm(await alarmInScope(req, id));
  });

  app.post('/alarms/:id/procedure/steps/:index', { preHandler: requireRole('Operator', 'SafetyOfficer', 'FireAdmin') }, async (req) => {
    const user = requireUser(req);
    const { id, index } = parse(z.object({ id: z.uuid(), index: z.coerce.number().int().min(0).max(29) }), req.params);
    const { done } = parse(procedureStepSchema, req.body);
    const alarm = await alarmInScope(req, id);
    const run = await services.procedures.setStep(alarm, index, done, user);
    await services.audit.write({ userId: user.id, action: 'procedure.step', entity: 'alarm', entityId: id, outcome: 'success', ipHash: req.ipHash, details: { index, done } });
    return run;
  });
};

export const adminProcedureRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  app.addHook('preHandler', requireRole('FireAdmin'));

  app.get('/procedures', async () => services.procedures.list());

  app.post('/procedures', async (req, reply) => {
    const user = requireUser(req);
    const input = parse(procedureInputSchema, req.body);
    const id = await services.procedures.create(input, user.id);
    await services.audit.write({ userId: user.id, action: 'procedure.create', entity: 'procedure', entityId: id, outcome: 'success', ipHash: req.ipHash, details: { category: input.category, steps: input.steps.length } });
    return reply.status(201).send({ id });
  });

  app.put('/procedures/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParamSchema, req.params);
    const input = parse(procedureInputSchema, req.body);
    await services.procedures.update(id, input, user.id);
    await services.audit.write({ userId: user.id, action: 'procedure.update', entity: 'procedure', entityId: id, outcome: 'success', ipHash: req.ipHash });
    return { ok: true };
  });

  app.delete('/procedures/:id', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParamSchema, req.params);
    await services.procedures.remove(id);
    await services.audit.write({ userId: user.id, action: 'procedure.delete', entity: 'procedure', entityId: id, outcome: 'success', ipHash: req.ipHash });
    return reply.status(204).send();
  });
};
