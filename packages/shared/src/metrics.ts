import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const pilotQuerySchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: 'from must be before to' })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 120, { message: 'range is limited to 120 days' });
export type PilotQuery = z.infer<typeof pilotQuerySchema>;

/** Pilot exit targets (docs/08 §6), on the 95th percentile. */
export const PILOT_TARGETS = { ingestP95Ms: 3000, notifyP95Ms: 10_000, availabilityPct: 99.5 } as const;

export interface LatencyStats {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

export interface CompletenessRow {
  collectorName: string;
  epoch: string;
  received: number;
  firstSeq: number;
  lastSeq: number;
  missing: number;
}

export interface NotificationMetricsRow {
  channel: string;
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
  latency: LatencyStats;
}

export interface AvailabilityRow {
  kind: 'collector' | 'device';
  name: string;
  outages: number;
  downtimeSeconds: number;
  availabilityPct: number;
}

export interface PilotTarget {
  id: 'ingest_p95' | 'notify_p95' | 'completeness' | 'availability';
  target: string;
  actual: string | null;
  met: boolean | null;
}

export interface PilotReport {
  from: string;
  to: string;
  periodSeconds: number;
  ingest: {
    events: number;
    /** Panel timestamp (or collector time when the panel gives none) to server receipt. */
    endToEnd: LatencyStats;
    collectorToServer: LatencyStats;
    /** Events whose panel timestamp is later than the collector's observation (panel clock ahead): excluded from endToEnd. */
    clockSkewCount: number;
  };
  completeness: CompletenessRow[];
  /** Per alarm: first successful delivery on any channel, measured from server receipt. */
  firstNotification: LatencyStats;
  notifications: NotificationMetricsRow[];
  availability: AvailabilityRow[];
  targets: PilotTarget[];
}

export interface MonitoringStatus {
  status: 'ok' | 'degraded' | 'down';
  checkedAt: string;
  db: 'ok' | 'error';
  collectors: { total: number; online: number };
  devices: { total: number; online: number };
  unackedFire: number;
  notifications: { stalePending: number; failedLastHour: number };
  lastIngestAgeSeconds: number | null;
}
