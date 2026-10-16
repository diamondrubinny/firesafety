import type { Role } from './roles.js';

export interface Me {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
  globalScope: boolean;
  /** Session opened with an emergency (break-glass) account. */
  breakGlass: boolean;
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
  breakGlass: boolean;
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

export interface AlarmView {
  id: string;
  kind: import('./alarms.js').AlarmKind;
  category: import('./alarms.js').AlarmCategory;
  priority: number;
  active: boolean;
  raisedAt: string;
  clearedAt: string | null;
  ackedAt: string | null;
  ackedBy: string | null;
  buildingId: string | null;
  buildingName: string | null;
  pointId: string | null;
  pointLabel: string | null;
  location: string | null;
  deviceName: string | null;
  message: string | null;
  floorId: string | null;
}

export interface AlarmDetail extends AlarmView {
  notes: { id: string; ts: string; author: string | null; text: string }[];
  history: { ts: string; category: string; eventState: string | null; lifeSafetyState: string | null; source: string }[];
}

export type AlarmSummary = Record<import('./alarms.js').AlarmCategory, { active: number; unacked: number }>;

export interface SystemStatus {
  collectors: { total: number; online: number };
  devices: { total: number; online: number };
  degraded: boolean;
  checkedAt: string;
}

export interface CollectorView {
  id: string;
  name: string;
  active: boolean;
  online: boolean;
  lastSeenAt: string | null;
  version: string | null;
  bufferDepth: number | null;
}

export interface PointView {
  id: string;
  deviceName: string | null;
  deviceInstance: number;
  objectType: string;
  objectInstance: number;
  name: string | null;
  description: string | null;
  buildingId: string | null;
  label: string | null;
  location: string | null;
  category: string;
  floorId: string | null;
  x: number | null;
  y: number | null;
}

export interface FloorView {
  id: string;
  buildingId: string;
  name: string;
  level: number;
  planFileId: string | null;
  planStatus: 'pending' | 'clean' | 'infected' | 'error' | 'unscanned' | null;
  abnormalCount: number;
}

export interface FloorPointView {
  id: string;
  label: string;
  location: string | null;
  x: number | null;
  y: number | null;
  category: import('./alarms.js').PointCategory;
  alarmId: string | null;
  acked: boolean | null;
}

export interface FloorDetail {
  floor: FloorView;
  building: { id: string; name: string };
  points: FloorPointView[];
}

export interface ImportReport {
  dryRun: boolean;
  rows: number;
  applied: number;
  errors: { line: number; message: string }[];
  preview: { line: number; pointId: string; changes: Record<string, unknown> }[];
}
