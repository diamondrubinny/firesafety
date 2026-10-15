import type { Role } from './roles.js';

export interface Me {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
  globalScope: boolean;
}

export interface Faculty {
  id: string;
  name: string;
}

export interface Building {
  id: string;
  name: string;
  code: string;
  facultyId: string | null;
  facultyName: string | null;
  address: string | null;
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
  active: boolean;
  lastLoginAt: string | null;
  buildingIds: string[];
}

export interface AuditEntry {
  id: string;
  ts: string;
  userId: string | null;
  userEmail: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  outcome: 'success' | 'denied' | 'failure';
  details: Record<string, unknown>;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}
