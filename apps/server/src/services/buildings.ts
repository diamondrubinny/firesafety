import type { Building, BuildingInput, BuildingPatch, Faculty } from '@firesafety/shared';
import type { Db } from '../db/pool.js';
import { conflict, isUniqueViolation, notFound } from '../lib/errors.js';
import type { Scope } from './scope.js';

const SELECT_BUILDING = `
  SELECT b.id, b.name, b.code, b.faculty_id, f.name AS faculty_name, b.address
    FROM building b LEFT JOIN faculty f ON f.id = b.faculty_id`;

interface BuildingRow {
  id: string;
  name: string;
  code: string;
  faculty_id: string | null;
  faculty_name: string | null;
  address: string | null;
}

const toBuilding = (r: BuildingRow): Building => ({
  id: r.id,
  name: r.name,
  code: r.code,
  facultyId: r.faculty_id,
  facultyName: r.faculty_name,
  address: r.address,
});

export class BuildingService {
  constructor(private readonly db: Db) {}

  /** Every read takes a Scope; the filter is applied in SQL so out-of-scope rows never leave the DB. */
  async list(scope: Scope): Promise<Building[]> {
    const { rows } =
      scope.kind === 'all'
        ? await this.db.query<BuildingRow>(`${SELECT_BUILDING} ORDER BY b.name`)
        : await this.db.query<BuildingRow>(
            `${SELECT_BUILDING}
              JOIN user_building_scope s ON s.building_id = b.id AND s.user_id = $1
             ORDER BY b.name`,
            [scope.userId],
          );
    return rows.map(toBuilding);
  }

  /** Returns null both when missing and when out of scope, so callers cannot distinguish (anti-enumeration). */
  async get(id: string, scope: Scope): Promise<Building | null> {
    const { rows } =
      scope.kind === 'all'
        ? await this.db.query<BuildingRow>(`${SELECT_BUILDING} WHERE b.id = $1`, [id])
        : await this.db.query<BuildingRow>(
            `${SELECT_BUILDING}
              JOIN user_building_scope s ON s.building_id = b.id AND s.user_id = $2
             WHERE b.id = $1`,
            [id, scope.userId],
          );
    return rows[0] ? toBuilding(rows[0]) : null;
  }

  async create(input: BuildingInput): Promise<Building> {
    try {
      const { rows } = await this.db.query<{ id: string }>(
        `INSERT INTO building (name, code, faculty_id, address) VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.name, input.code, input.facultyId ?? null, input.address || null],
      );
      return (await this.get(rows[0]!.id, { kind: 'all' }))!;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A building with this code already exists');
      throw mapFkError(err);
    }
  }

  async update(id: string, patch: BuildingPatch): Promise<Building> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (col: string, v: unknown) => {
      values.push(v);
      fields.push(`${col} = $${values.length}`);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.code !== undefined) set('code', patch.code);
    if (patch.facultyId !== undefined) set('faculty_id', patch.facultyId);
    if (patch.address !== undefined) set('address', patch.address || null);
    values.push(id);
    try {
      const r = await this.db.query(
        `UPDATE building SET ${fields.join(', ')}, updated_at = now() WHERE id = $${values.length}`,
        values,
      );
      if (r.rowCount === 0) throw notFound('Building');
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A building with this code already exists');
      throw mapFkError(err);
    }
    return (await this.get(id, { kind: 'all' }))!;
  }

  async remove(id: string): Promise<void> {
    const r = await this.db.query('DELETE FROM building WHERE id = $1', [id]);
    if (r.rowCount === 0) throw notFound('Building');
  }

  async listFaculties(): Promise<Faculty[]> {
    const { rows } = await this.db.query<Faculty>('SELECT id, name FROM faculty ORDER BY name');
    return rows;
  }

  async createFaculty(name: string): Promise<Faculty> {
    try {
      const { rows } = await this.db.query<Faculty>('INSERT INTO faculty (name) VALUES ($1) RETURNING id, name', [name]);
      return rows[0]!;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A faculty with this name already exists');
      throw err;
    }
  }

  async removeFaculty(id: string): Promise<void> {
    const r = await this.db.query('DELETE FROM faculty WHERE id = $1', [id]);
    if (r.rowCount === 0) throw notFound('Faculty');
  }
}

function mapFkError(err: unknown): unknown {
  if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23503') {
    return notFound('Faculty');
  }
  return err;
}
