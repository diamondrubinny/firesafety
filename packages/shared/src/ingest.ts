import { z } from 'zod';

/** Wire format between the on-site collector and the server (POST /ingest/v1/batch). */

const bacnetEnum = z.string().regex(/^[a-z0-9-]{1,40}$/);
const objectType = bacnetEnum;
const instance = z.number().int().min(0).max(4_194_303);
const text = (max: number) => z.string().max(max);
const isoTime = z.iso.datetime({ offset: true });

export const ingestDeviceSchema = z.object({
  instance,
  address: text(64),
  online: z.boolean(),
  name: text(128).optional(),
  vendor: text(128).optional(),
  model: text(128).optional(),
  error: text(256).optional(),
});

export const ingestPointSchema = z.object({
  deviceInstance: instance,
  objectType,
  objectInstance: instance,
  name: text(256).optional(),
  description: text(512).optional(),
});

export const ingestEventSchema = z.object({
  seq: z.number().int().min(1),
  deviceInstance: instance,
  objectType,
  objectInstance: instance,
  source: z.enum(['notification', 'poll', 'inventory']),
  sourceTs: isoTime.nullable().optional(),
  observedAt: isoTime,
  eventState: bacnetEnum.nullable().optional(),
  fromState: bacnetEnum.nullable().optional(),
  toState: bacnetEnum.nullable().optional(),
  lifeSafetyState: bacnetEnum.nullable().optional(),
  outOfService: z.boolean().nullable().optional(),
  reliability: bacnetEnum.nullable().optional(),
  mode: bacnetEnum.nullable().optional(),
  priority: z.number().int().min(0).max(255).nullable().optional(),
  messageText: text(512).nullable().optional(),
});

export const ingestSnapshotSchema = z.object({
  deviceInstance: instance,
  takenAt: isoTime,
  /** Snapshots share the outbox sequence with events, so they are applied in order. */
  seq: z.number().int().min(1),
  nonNormal: z.array(z.object({ objectType, objectInstance: instance })).max(20_000),
});

export const ingestBatchSchema = z.object({
  epoch: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  sentAt: isoTime,
  collector: z.object({
    version: text(32),
    uptimeSeconds: z.number().int().min(0),
    bufferDepth: z.number().int().min(0),
  }),
  devices: z.array(ingestDeviceSchema).max(500).default([]),
  points: z.array(ingestPointSchema).max(5000).default([]),
  events: z.array(ingestEventSchema).max(2000).default([]),
  snapshots: z.array(ingestSnapshotSchema).max(500).default([]),
});

export type IngestBatch = z.infer<typeof ingestBatchSchema>;
export type IngestEvent = z.infer<typeof ingestEventSchema>;

export interface IngestResponse {
  /** Highest seq the server has durably stored for this epoch. */
  ackedSeq: number;
}
