import type { FloorDetail, FloorPointView, FloorView } from '@firesafety/shared';
import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { conflict, isUniqueViolation, notFound } from '../lib/errors.js';
import type { Scope } from './scope.js';

const FLOOR_COLUMNS = `
  f.id, f.building_id, f.name, f.level, f.plan_file_id, sf.scan_status AS plan_status,
  (SELECT count(*) FROM point p WHERE p.floor_id = f.id AND p.category <> 'normal')::int AS abnormal_count`;

interface FloorRow {
  id: string;
  building_id: string;
  name: string;
  level: number;
  plan_file_id: string | null;
  plan_status: FloorView['planStatus'];
  abnormal_count: number;
}

const toFloor = (r: FloorRow): FloorView => ({
  id: r.id,
  buildingId: r.building_id,
  name: r.name,
  level: r.level,
  planFileId: r.plan_file_id,
  planStatus: r.plan_status,
  abnormalCount: r.abnormal_count,
});

function scopeSql(scope: Scope, params: unknown[]): string {
  if (scope.kind === 'all') return 'TRUE';
  params.push(scope.userId);
  return `EXISTS (SELECT 1 FROM user_building_scope s WHERE s.user_id = $${params.length} AND s.building_id = f.building_id)`;
}

export class FloorService {
  constructor(private readonly db: Db) {}

  async listForBuilding(buildingId: string, scope: Scope): Promise<FloorView[]> {
    const params: unknown[] = [buildingId];
    const { rows } = await this.db.query<FloorRow>(
      `SELECT ${FLOOR_COLUMNS} FROM floor f LEFT JOIN stored_file sf ON sf.id = f.plan_file_id
        WHERE f.building_id = $1 AND ${scopeSql(scope, params)} ORDER BY f.level, f.name`,
      params,
    );
    return rows.map(toFloor);
  }

  async get(id: string, scope: Scope): Promise<FloorView | null> {
    const params: unknown[] = [id];
    const { rows } = await this.db.query<FloorRow>(
      `SELECT ${FLOOR_COLUMNS} FROM floor f LEFT JOIN stored_file sf ON sf.id = f.plan_file_id
        WHERE f.id = $1 AND ${scopeSql(scope, params)}`,
      params,
    );
    return rows[0] ? toFloor(rows[0]) : null;
  }

  async detail(id: string, scope: Scope): Promise<FloorDetail | null> {
    const floor = await this.get(id, scope);
    if (!floor) return null;
    const [b, pts] = await Promise.all([
      this.db.query<{ id: string; name: string }>('SELECT id, name FROM building WHERE id = $1', [floor.buildingId]),
      this.db.query(
        `SELECT p.id, COALESCE(p.label, p.name, p.object_type || ':' || p.object_instance) AS label,
                COALESCE(p.location, p.description) AS location, p.x, p.y, p.category,
                a.id AS alarm_id, (a.acked_at IS NOT NULL) AS acked
           FROM point p
           LEFT JOIN alarm a ON a.point_id = p.id AND a.kind = 'point' AND a.cleared_at IS NULL
          WHERE p.floor_id = $1
          ORDER BY (p.category = 'normal'), label`,
        [id],
      ),
    ]);
    const points: FloorPointView[] = pts.rows.map((r) => ({
      id: r.id,
      label: r.label,
      location: r.location,
      x: r.x,
      y: r.y,
      category: r.category,
      alarmId: r.alarm_id,
      acked: r.alarm_id ? r.acked : null,
    }));
    return { floor, building: b.rows[0]!, points };
  }

  /** Building that owns a stored file (for authorising downloads). */
  async buildingOfFile(fileId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ building_id: string }>('SELECT building_id FROM floor WHERE plan_file_id = $1', [fileId]);
    return rows[0]?.building_id ?? null;
  }

  async create(buildingId: string, input: { name: string; level: number }): Promise<FloorView> {
    try {
      const { rows } = await this.db.query<{ id: string }>(
        'INSERT INTO floor (building_id, name, level) VALUES ($1, $2, $3) RETURNING id',
        [buildingId, input.name, input.level],
      );
      return (await this.get(rows[0]!.id, { kind: 'all' }))!;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A floor with this name already exists in the building');
      if ((err as { code?: string }).code === '23503') throw notFound('Building');
      throw err;
    }
  }

  async update(id: string, patch: { name?: string; level?: number }): Promise<FloorView> {
    try {
      const r = await this.db.query(
        'UPDATE floor SET name = COALESCE($2, name), level = COALESCE($3, level) WHERE id = $1',
        [id, patch.name ?? null, patch.level ?? null],
      );
      if (r.rowCount === 0) throw notFound('Floor');
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A floor with this name already exists in the building');
      throw err;
    }
    return (await this.get(id, { kind: 'all' }))!;
  }

  /** Deletes the floor and its plan file; points are detached (floor_id → NULL) but keep their building. */
  async remove(id: string): Promise<void> {
    await withTransaction(this.db, async (c) => {
      await c.query('UPDATE point SET x = NULL, y = NULL WHERE floor_id = $1', [id]);
      const { rows } = await c.query<{ plan_file_id: string | null }>('DELETE FROM floor WHERE id = $1 RETURNING plan_file_id', [id]);
      if (!rows[0]) throw notFound('Floor');
      if (rows[0].plan_file_id) await c.query('DELETE FROM stored_file WHERE id = $1', [rows[0].plan_file_id]);
    });
  }

  /** Points the floor at a new plan and deletes the previous file. */
  async setPlan(floorId: string, fileId: string): Promise<void> {
    const { rows } = await this.db.query<{ old: string | null }>(
      `UPDATE floor f SET plan_file_id = $2 FROM (SELECT plan_file_id AS old FROM floor WHERE id = $1) o
        WHERE f.id = $1 RETURNING o.old`,
      [floorId, fileId],
    );
    if (!rows[0]) throw notFound('Floor');
    if (rows[0].old && rows[0].old !== fileId) await this.db.query('DELETE FROM stored_file WHERE id = $1', [rows[0].old]);
  }
}
