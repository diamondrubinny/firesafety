import type pg from 'pg';
import {
  CATEGORY_PRIORITY,
  categorize,
  type AlarmCategory,
  type IngestBatch,
  type IngestEvent,
  type PointCategory,
} from '@firesafety/shared';
import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';

/** A change that connected clients may need to know about. Contains no alarm content. */
export interface AlarmChange {
  buildingId: string | null;
  category: AlarmCategory | 'normal';
  kind: 'point' | 'device_comm' | 'collector_comm';
}

export interface CollectorIdentity {
  id: string;
  name: string;
}

const DEVICE_COMM_MESSAGE = 'אין תקשורת לרכזת';
const COLLECTOR_COMM_MESSAGE = 'אין קשר ל-Collector: הניטור אינו פעיל';

type Client = pg.PoolClient;

/**
 * Applies collector batches to the database. Every batch is processed in a single
 * transaction, so a crash never leaves a half-applied batch; with the (epoch, seq)
 * uniqueness this makes delivery idempotent (at-least-once on the wire, exactly-once in the DB).
 */
export class AlarmEngine {
  constructor(private readonly db: Db) {}

  async ingest(collector: CollectorIdentity, batch: IngestBatch): Promise<{ ackedSeq: number; changes: AlarmChange[] }> {
    return withTransaction(this.db, async (c) => {
      const changes: AlarmChange[] = [];
      // Serialise batches of the same collector.
      const { rows: crow } = await c.query<{ epoch: string | null; acked_seq: string }>(
        'SELECT epoch, acked_seq FROM collector WHERE id = $1 FOR UPDATE',
        [collector.id],
      );
      let ackedSeq = crow[0]?.epoch === batch.epoch ? Number(crow[0].acked_seq) : 0;

      const deviceIds = new Map<number, string>();
      const deviceId = async (instance: number): Promise<string> => {
        const cached = deviceIds.get(instance);
        if (cached) return cached;
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO bacnet_device (collector_id, device_instance, address)
           VALUES ($1, $2, 'unknown')
           ON CONFLICT (collector_id, device_instance) DO UPDATE SET device_instance = EXCLUDED.device_instance
           RETURNING id`,
          [collector.id, instance],
        );
        deviceIds.set(instance, rows[0]!.id);
        return rows[0]!.id;
      };

      for (const d of batch.devices) {
        const { rows } = await c.query<{ id: string; building_id: string | null }>(
          `INSERT INTO bacnet_device (collector_id, device_instance, address, name, vendor, model, online, last_error, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $7 THEN now() END)
           ON CONFLICT (collector_id, device_instance) DO UPDATE SET
             address = EXCLUDED.address,
             name = COALESCE(EXCLUDED.name, bacnet_device.name),
             vendor = COALESCE(EXCLUDED.vendor, bacnet_device.vendor),
             model = COALESCE(EXCLUDED.model, bacnet_device.model),
             online = EXCLUDED.online,
             last_error = EXCLUDED.last_error,
             last_seen_at = COALESCE(EXCLUDED.last_seen_at, bacnet_device.last_seen_at)
           RETURNING id, building_id`,
          [collector.id, d.instance, d.address, d.name ?? null, d.vendor ?? null, d.model ?? null, d.online, d.error ?? null],
        );
        const dev = rows[0]!;
        deviceIds.set(d.instance, dev.id);
        const changed = d.online
          ? await this.clearComm(c, 'device_comm', 'device_id', dev.id)
          : await this.raiseComm(c, 'device_comm', 'device_id', dev.id, `${DEVICE_COMM_MESSAGE}${d.name ? ` ${d.name}` : ''}`);
        if (changed) changes.push({ buildingId: dev.building_id, category: d.online ? 'normal' : 'fault', kind: 'device_comm' });
      }

      for (const p of batch.points) {
        await c.query(
          `INSERT INTO point (device_id, object_type, object_instance, name, description)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (device_id, object_type, object_instance) DO UPDATE SET
             name = COALESCE(EXCLUDED.name, point.name),
             description = COALESCE(EXCLUDED.description, point.description)`,
          [await deviceId(p.deviceInstance), p.objectType, p.objectInstance, p.name ?? null, p.description ?? null],
        );
      }

      // Events and snapshots share one sequence; apply them strictly in order.
      type Item = { seq: number } & ({ t: 'event'; e: IngestEvent } | { t: 'snapshot'; s: IngestBatch['snapshots'][number] });
      const items: Item[] = [
        ...batch.events.map((e) => ({ seq: e.seq, t: 'event' as const, e })),
        ...batch.snapshots.map((s) => ({ seq: s.seq, t: 'snapshot' as const, s })),
      ].sort((a, b) => a.seq - b.seq);

      for (const item of items) {
        if (item.seq <= ackedSeq) continue; // already applied (retransmission)
        if (item.t === 'event') {
          const e = item.e;
          const dev = await deviceId(e.deviceInstance);
          const pointId = await this.upsertPoint(c, dev, e.objectType, e.objectInstance);
          const category = categorize(e);
          const ins = await c.query(
            `INSERT INTO event_log (collector_id, epoch, seq, point_id, source, source_ts, observed_at, category, event_state, life_safety_state, raw)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (collector_id, epoch, seq) DO NOTHING`,
            [collector.id, batch.epoch, e.seq, pointId, e.source, e.sourceTs ?? null, e.observedAt, category, e.eventState ?? null, e.lifeSafetyState ?? null, JSON.stringify(e)],
          );
          if (ins.rowCount === 1) {
            const ch = await this.applyPointState(c, pointId, category, {
              eventState: e.eventState ?? null,
              lifeSafetyState: e.lifeSafetyState ?? null,
              outOfService: e.outOfService ?? null,
              raisedAt: e.sourceTs ?? e.observedAt,
              message: e.messageText ?? null,
            });
            if (ch) changes.push(ch);
          }
        } else {
          changes.push(...(await this.reconcile(c, collector.id, batch.epoch, await deviceId(item.s.deviceInstance), item.s)));
        }
        ackedSeq = Math.max(ackedSeq, item.seq);
      }

      await c.query(
        `UPDATE collector SET last_seen_at = now(), version = $2, buffer_depth = $3, epoch = $4, acked_seq = $5 WHERE id = $1`,
        [collector.id, batch.collector.version, batch.collector.bufferDepth, batch.epoch, ackedSeq],
      );
      if (await this.clearComm(c, 'collector_comm', 'collector_id', collector.id)) {
        changes.push({ buildingId: null, category: 'normal', kind: 'collector_comm' });
      }
      return { ackedSeq, changes };
    });
  }

  /** Raises a collector_comm alarm for every active collector silent for longer than staleSeconds. */
  async checkCollectors(staleSeconds: number): Promise<AlarmChange[]> {
    const { rows } = await this.db.query<{ id: string; name: string }>(
      `SELECT id, name FROM collector
        WHERE active AND COALESCE(last_seen_at, created_at) < now() - make_interval(secs => $1)`,
      [staleSeconds],
    );
    const changes: AlarmChange[] = [];
    for (const col of rows) {
      const raised = await withTransaction(this.db, (c) =>
        this.raiseComm(c, 'collector_comm', 'collector_id', col.id, `${COLLECTOR_COMM_MESSAGE} (${col.name})`),
      );
      if (raised) changes.push({ buildingId: null, category: 'fault', kind: 'collector_comm' });
    }
    return changes;
  }

  private async upsertPoint(c: Client, deviceId: string, objectType: string, objectInstance: number): Promise<string> {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO point (device_id, object_type, object_instance) VALUES ($1, $2, $3)
       ON CONFLICT (device_id, object_type, object_instance) DO UPDATE SET object_type = EXCLUDED.object_type
       RETURNING id`,
      [deviceId, objectType, objectInstance],
    );
    return rows[0]!.id;
  }

  /**
   * Moves a point to a new category. A change of category closes the current
   * occurrence and opens a new one, so e.g. prealarm → fire requires a fresh acknowledgement.
   */
  private async applyPointState(
    c: Client,
    pointId: string,
    category: PointCategory,
    s: { eventState: string | null; lifeSafetyState: string | null; outOfService: boolean | null; raisedAt: string; message: string | null },
  ): Promise<AlarmChange | null> {
    const { rows } = await c.query<{ category: string; building_id: string | null }>(
      `SELECT p.category, COALESCE(p.building_id, d.building_id) AS building_id
         FROM point p JOIN bacnet_device d ON d.id = p.device_id WHERE p.id = $1 FOR UPDATE OF p`,
      [pointId],
    );
    const current = rows[0]!;
    await c.query(
      `UPDATE point SET event_state = $2, life_safety_state = $3, out_of_service = $4,
              category = $5, state_changed_at = CASE WHEN category <> $5 THEN now() ELSE state_changed_at END
        WHERE id = $1`,
      [pointId, s.eventState, s.lifeSafetyState, s.outOfService, category],
    );
    if (current.category === category) return null;

    await c.query(`UPDATE alarm SET cleared_at = now() WHERE point_id = $1 AND kind = 'point' AND cleared_at IS NULL`, [pointId]);
    if (category !== 'normal') {
      await c.query(
        `INSERT INTO alarm (kind, point_id, category, priority, message, raised_at) VALUES ('point', $1, $2, $3, $4, $5)`,
        [pointId, category, CATEGORY_PRIORITY[category], s.message, s.raisedAt],
      );
    }
    return { buildingId: current.building_id, category, kind: 'point' };
  }

  /** Returns to normal every abnormal point of the device that the panel no longer reports. */
  private async reconcile(
    c: Client,
    collectorId: string,
    epoch: string,
    deviceId: string,
    snap: IngestBatch['snapshots'][number],
  ): Promise<AlarmChange[]> {
    const keep = new Set(snap.nonNormal.map((o) => `${o.objectType}:${o.objectInstance}`));
    const { rows } = await c.query<{ id: string; object_type: string; object_instance: number }>(
      `SELECT id, object_type, object_instance FROM point WHERE device_id = $1 AND category <> 'normal'`,
      [deviceId],
    );
    const changes: AlarmChange[] = [];
    for (const p of rows) {
      if (keep.has(`${p.object_type}:${p.object_instance}`)) continue;
      await c.query(
        `INSERT INTO event_log (collector_id, epoch, seq, point_id, source, observed_at, category, raw)
         VALUES ($1, $2, NULL, $3, 'snapshot', $4, 'normal', $5)`,
        [collectorId, epoch, p.id, snap.takenAt, JSON.stringify({ reconcile: true, snapshotSeq: snap.seq })],
      );
      const ch = await this.applyPointState(c, p.id, 'normal', {
        eventState: 'normal',
        lifeSafetyState: null,
        outOfService: null,
        raisedAt: snap.takenAt,
        message: null,
      });
      if (ch) changes.push(ch);
    }
    return changes;
  }

  private async raiseComm(c: Client, kind: 'device_comm' | 'collector_comm', col: 'device_id' | 'collector_id', id: string, message: string): Promise<boolean> {
    const r = await c.query(
      `INSERT INTO alarm (kind, ${col}, category, priority, message, raised_at)
       VALUES ($1, $2, 'fault', $3, $4, now())
       ON CONFLICT DO NOTHING`,
      [kind, id, CATEGORY_PRIORITY.fault, message],
    );
    return r.rowCount === 1;
  }

  private async clearComm(c: Client, kind: 'device_comm' | 'collector_comm', col: 'device_id' | 'collector_id', id: string): Promise<boolean> {
    const r = await c.query(`UPDATE alarm SET cleared_at = now() WHERE kind = $1 AND ${col} = $2 AND cleared_at IS NULL`, [kind, id]);
    return (r.rowCount ?? 0) > 0;
  }
}
