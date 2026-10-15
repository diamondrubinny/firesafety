/**
 * Application roles. These names must match the App Roles defined on the
 * Entra ID App Registration (claim "roles" in the ID token).
 */
export const ROLES = ['FireAdmin', 'SafetyOfficer', 'Operator', 'Viewer'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** FireAdmin sees every building; all other roles are limited to assigned buildings. */
export function hasGlobalScope(roles: readonly Role[]): boolean {
  return roles.includes('FireAdmin');
}

export const ROLE_LABELS_HE: Record<Role, string> = {
  FireAdmin: 'מנהל מערכת',
  SafetyOfficer: 'ממונה בטיחות',
  Operator: 'מפעיל מוקד',
  Viewer: 'צופה',
};
