import { hasGlobalScope } from '@firesafety/shared';
import type { AuthUser } from './users.js';

/** Data-access scope derived on the server from the authenticated user, never from client input. */
export type Scope = { kind: 'all' } | { kind: 'assigned'; userId: string };

export function scopeFor(user: AuthUser): Scope {
  return hasGlobalScope(user.roles) ? { kind: 'all' } : { kind: 'assigned', userId: user.id };
}
