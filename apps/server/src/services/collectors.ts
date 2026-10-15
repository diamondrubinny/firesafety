import type { CollectorView, PointView, Page } from '@firesafety/shared';
import type { Db } from '../db/pool.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, conflict, isUniqueViolation, notFound } from '../lib/errors.js';
import type { CollectorIdentity } from './alarm-engine.js';

export class CollectorService {
  constructor(
    private readonly db: Db,
    private readonly staleSeconds: number,
  ) {}

  /** Returns the plaintext token exactly once; only its hash is stored. */
  async create(name: string): Promise<{ collector: CollectorView; token: string }> {
    const token = `fsc_${randomToken()}`;
    try {
      const { rows } = await this.db.query<{ id: string }>(
        'INSERT INTO collector (name, token_hash) VALUES ($1, $2) RETURNING id',
        [name, sha256(token)],
      );
      return { collector: (await this.get(rows[0]!.id))!, token };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A collector with this name already exists');
      throw err;
    }
  }

  async rotateToken(id: string): Promise<string> {
    const token = `fsc_${randomToken()}`;
    const r = await this.db.query('UPDATE collector SET token_hash = $2 WHERE id = $1', [id, sha256(token)]);
    if (r.rowCount === 0) throw notFound('Collector');
    return token;
  }

  async setActive(id: string, active: boolean): Promise<void> {
    const r = await this.db.query('UPDATE collector SET active = $2 WHERE id = $1', [id, active]);
    if (r.rowCount === 0) throw notFound('Collector');
    if (!active) {
      await this.db.query(
        `UPDATE alarm SET cleared_at = now() WHERE kind = 'collector_comm' AND collector_id = $1 AND cleared_at IS NULL`,
        [id],
      );
    }
  }

  async authenticate(token: string): Promise<CollectorIdentity | null> {
    const { rows } = await this.db.query<CollectorIdentity>('SELECT id, name FROM collector WHERE token_hash = $1 AND active', [sha256(token)]);
    return rows[0] ?? null;
  }

  async list(): Promise<CollectorView[]> {
    const { rows } = await this.db.query(this.selectSql() + ' ORDER BY name', [this.staleSeconds]);
    return rows.map(toCollector);
  }

  async get(id: string): Promise<CollectorView | null> {
    const { rows } = await this.db.query(this.selectSql() + ' WHERE id = $2', [this.staleSeconds, id]);
    return rows[0] ? toCollector(rows[0]) : null;
  }

  private selectSql(): string {
    return `SELECT id, name, active, last_seen_at, version, buffer_depth,
                   (active AND last_seen_at > now() - make_interval(secs => $1)) AS online
              FROM collector`;
  }

  async listPoints(q: { unmapped: boolean; buildingId?: string; limit: number; offset: number }): Promise<Page<PointView>> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (q.unmapped) conds.push('p.building_id IS NULL AND d.building_id IS NULL');
    if (q.buildingId) {
      params.push(q.buildingId);
      conds.push(`COALESCE(p.building_id, d.building_id) = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const [items, total] = await Promise.all([
      this.db.query(
        `SELECT p.id, d.name AS device_name, d.device_instance, p.object_type, p.object_instance, p.name, p.description,
                p.building_id, p.label, p.location, p.category, p.floor_id, p.x, p.y
           FROM point p JOIN bacnet_device d ON d.id = p.device_id ${where}
          ORDER BY d.device_instance, p.object_type, p.object_instance
          LIMIT ${q.limit} OFFSET ${q.offset}`,
        params,
      ),
      this.db.query<{ count: string }>(`SELECT count(*) FROM point p JOIN bacnet_device d ON d.id = p.device_id ${where}`, params),
    ]);
    return {
      items: items.rows.map((r) => ({
        id: r.id,
        deviceName: r.device_name,
        deviceInstance: r.device_instance,
        objectType: r.object_type,
        objectInstance: r.object_instance,
        name: r.name,
        description: r.description,
        buildingId: r.building_id,
        label: r.label,
        location: r.location,
        category: r.category,
        floorId: r.floor_id,
        x: r.x,
        y: r.y,
      })),
      total: Number(total.rows[0]?.count ?? 0),
    };
  }

  async patchPoint(
    id: string,
    patch: { buildingId?: string | null; label?: string | null; location?: string | null; floorId?: string | null; x?: number | null; y?: number | null },
  ): Promise<void> {
    if (patch.floorId) {
      // A point placed on a floor always belongs to that floor's building.
      const { rows } = await this.db.query<{ building_id: string }>('SELECT building_id FROM floor WHERE id = $1', [patch.floorId]);
      if (!rows[0]) throw notFound('Floor');
      if (patch.buildingId !== undefined && patch.buildingId !== rows[0].building_id) {
        throw badRequest('floorId belongs to a different building');
      }
      patch = { ...patch, buildingId: rows[0].building_id };
    } else if (patch.floorId === null) {
      patch = { ...patch, x: null, y: null };
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    const add = (col: string, v: unknown) => {
      values.push(v === '' ? null : v);
      sets.push(`${col} = $${values.length}`);
    };
    if (patch.buildingId !== undefined) add('building_id', patch.buildingId);
    if (patch.label !== undefined) add('label', patch.label);
    if (patch.location !== undefined) add('location', patch.location);
    if (patch.floorId !== undefined) add('floor_id', patch.floorId);
    if (patch.x !== undefined) sets.push(`x = $${values.push(patch.x)}`);
    if (patch.y !== undefined) sets.push(`y = $${values.push(patch.y)}`);
    if (patch.buildingId !== undefined && patch.floorId === undefined) {
      // Moving a point to another building detaches it from its floor.
      const b = values.push(patch.buildingId);
      const detach = `(floor_id IS NOT NULL AND (SELECT f.building_id FROM floor f WHERE f.id = point.floor_id) IS DISTINCT FROM $${b}::uuid)`;
      sets.push(`floor_id = CASE WHEN ${detach} THEN NULL ELSE floor_id END`);
      if (patch.x === undefined) {
        sets.push(`x = CASE WHEN ${detach} THEN NULL ELSE x END`, `y = CASE WHEN ${detach} THEN NULL ELSE y END`);
      }
    }
    values.push(id);
    try {
      const r = await this.db.query(`UPDATE point SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
      if (r.rowCount === 0) throw notFound('Point');
    } catch (err) {
      if ((err as { code?: string }).code === '23503') throw notFound('Building');
      throw err;
    }
  }

  async listDevices(): Promise<{ id: string; collectorName: string; instance: number; address: string; name: string | null; buildingId: string | null; online: boolean }[]> {
    const { rows } = await this.db.query(
      `SELECT d.id, c.name AS collector_name, d.device_instance, d.address, d.name, d.building_id, d.online
         FROM bacnet_device d JOIN collector c ON c.id = d.collector_id ORDER BY c.name, d.device_instance`,
    );
    return rows.map((r) => ({
      id: r.id,
      collectorName: r.collector_name,
      instance: r.device_instance,
      address: r.address,
      name: r.name,
      buildingId: r.building_id,
      online: r.online,
    }));
  }

  async patchDevice(id: string, buildingId: string | null): Promise<void> {
    try {
      const r = await this.db.query('UPDATE bacnet_device SET building_id = $2 WHERE id = $1', [id, buildingId]);
      if (r.rowCount === 0) throw notFound('Device');
    } catch (err) {
      if ((err as { code?: string }).code === '23503') throw notFound('Building');
      throw err;
    }
  }
}

function toCollector(r: Record<string, unknown>): CollectorView {
  return {
    id: r.id as string,
    name: r.name as string,
    active: r.active as boolean,
    online: !!r.online,
    lastSeenAt: r.last_seen_at ? (r.last_seen_at as Date).toISOString() : null,
    version: (r.version as string | null) ?? null,
    bufferDepth: (r.buffer_depth as number | null) ?? null,
  };
}
