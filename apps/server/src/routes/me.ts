import type { FastifyPluginAsync } from 'fastify';
import { hasGlobalScope, type Me } from '@firesafety/shared';
import { requireUser } from '../auth/guards.js';

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (req): Promise<Me> => {
    const u = requireUser(req);
    return { id: u.id, email: u.email, displayName: u.displayName, roles: u.roles, globalScope: hasGlobalScope(u.roles), breakGlass: u.breakGlass === true };
  });
};
