import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@firesafety/shared';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { AuthUser } from '../services/users.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    ipHash: string | null;
  }
}

/** Returns the authenticated user or throws 401. */
export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** preHandler factory: authenticated + at least one of the given roles. Denials are audited. */
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const user = requireUser(req);
    if (!user.roles.some((r) => roles.includes(r))) {
      await req.server.services.audit.write({
        userId: user.id,
        action: 'authz.denied',
        entity: 'route',
        entityId: req.routeOptions.url ?? req.url,
        outcome: 'denied',
        ipHash: req.ipHash,
        details: { method: req.method, required: roles },
      });
      throw forbidden();
    }
  };
}

export const requireAuth = async (req: FastifyRequest): Promise<void> => {
  requireUser(req);
};
