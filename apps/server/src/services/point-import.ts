import { z } from 'zod';
import type { ImportReport } from '@firesafety/shared';
import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { CsvError, parseCsv } from '../lib/csv.js';
import { badRequest } from '../lib/errors.js';

/** Accepted header names (English and Hebrew) → canonical field. */
const ALIASES: Record<string, Field> = {
  device_instance: 'device_instance', device: 'device_instance', 'רכזת': 'device_instance',
  object_type: 'object_type', type: 'object_type', 'סוג אובייקט': 'object_type',
  object_instance: 'object_instance', instance: 'object_instance', 'מספר אובייקט': 'object_instance',
  building_code: 'building_code', building: 'building_code', 'קוד מבנה': 'building_code',
  floor_level: 'floor_level', floor: 'floor_level', 'קומה': 'floor_level',
  label: 'label', 'שם': 'label', 'שם תצוגה': 'label',
  location: 'location', 'מיקום': 'location',
  x: 'x', y: 'y',
};
type Field = 'device_instance' | 'object_type' | 'object_instance' | 'building_code' | 'floor_level' | 'label' | 'location' | 'x' | 'y';

const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v === '' ? undefined : v));
const optionalNumber = (schema: z.ZodNumber) =>
  z.string().trim().optional().transform((v, ctx) => {
    if (v === undefined || v === '') return undefined;
    const n = Number(v.replace('%', ''));
    const scaled = v.endsWith('%') ? n / 100 : n;
    const r = schema.safeParse(scaled);
    if (!r.success) {
      ctx.addIssue({ code: 'custom', message: r.error.issues[0]?.message ?? 'invalid number' });
      return z.NEVER;
    }
    return r.data;
  });

const rowSchema = z.object({
  device_instance: z.string().trim().regex(/^\d{1,7}$/, 'device_instance must be a number'),
  object_type: z.string().trim().regex(/^[a-z-]{3,40}$/, 'object_type must look like life-safety-point'),
  object_instance: z.string().trim().regex(/^\d{1,7}$/, 'object_instance must be a number'),
  building_code: optionalText(32),
  floor_level: optionalNumber(z.number().int().min(-20).max(300)),
  label: optionalText(160),
  location: optionalText(240),
  x: optionalNumber(z.number().min(0).max(1)),
  y: optionalNumber(z.number().min(0).max(1)),
});

export class PointImportService {
  constructor(private readonly db: Db) {}

  /**
   * Validates every row first; applies only if there are no errors (all or nothing).
   * Only points already reported by a collector are updated.
   */
  async run(csvText: string, dryRun: boolean): Promise<ImportReport> {
    let parsed;
    try {
      parsed = parseCsv(csvText);
    } catch (err) {
      if (err instanceof CsvError) throw badRequest(`CSV: ${err.message}`);
      throw err;
    }
    const fields = parsed.header.map((h) => ALIASES[h.toLowerCase()] ?? ALIASES[h]);
    for (const required of ['device_instance', 'object_type', 'object_instance'] as const) {
      if (!fields.includes(required)) throw badRequest(`CSV: missing required column "${required}"`);
    }

    const errors: ImportReport['errors'] = [];
    const planned: { line: number; pointId: string; changes: Record<string, unknown> }[] = [];

    const buildings = new Map<string, string>(
      (await this.db.query<{ id: string; code: string }>('SELECT id, lower(code) AS code FROM building')).rows.map((r) => [r.code, r.id]),
    );
    const floors = new Map<string, string>(
      (await this.db.query<{ id: string; building_id: string; level: number }>('SELECT id, building_id, level FROM floor')).rows.map((r) => [
        `${r.building_id}:${r.level}`,
        r.id,
      ]),
    );
    const seen = new Set<string>();

    for (const row of parsed.rows) {
      const raw: Record<string, string> = {};
      fields.forEach((f, i) => {
        if (f) raw[f] = row.cells[i] ?? '';
      });
      const v = rowSchema.safeParse(raw);
      if (!v.success) {
        errors.push({ line: row.line, message: v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
        continue;
      }
      const r = v.data;
      const key = `${r.device_instance}:${r.object_type}:${r.object_instance}`;
      if (seen.has(key)) {
        errors.push({ line: row.line, message: 'duplicate point in file' });
        continue;
      }
      seen.add(key);

      const { rows: pts } = await this.db.query<{ id: string }>(
        `SELECT p.id FROM point p JOIN bacnet_device d ON d.id = p.device_id
          WHERE d.device_instance = $1 AND p.object_type = $2 AND p.object_instance = $3`,
        [Number(r.device_instance), r.object_type, Number(r.object_instance)],
      );
      if (pts.length === 0) {
        errors.push({ line: row.line, message: 'point not found (not yet reported by a collector)' });
        continue;
      }
      if (pts.length > 1) {
        errors.push({ line: row.line, message: 'ambiguous: the same device instance exists under more than one collector' });
        continue;
      }

      const changes: Record<string, unknown> = {};
      let buildingId: string | undefined;
      if (r.building_code !== undefined) {
        buildingId = buildings.get(r.building_code.toLowerCase());
        if (!buildingId) {
          errors.push({ line: row.line, message: `unknown building code "${r.building_code}"` });
          continue;
        }
        changes.building_id = buildingId;
      }
      if (r.floor_level !== undefined) {
        if (!buildingId) {
          errors.push({ line: row.line, message: 'floor_level requires building_code' });
          continue;
        }
        const floorId = floors.get(`${buildingId}:${r.floor_level}`);
        if (!floorId) {
          errors.push({ line: row.line, message: `no floor with level ${r.floor_level} in building "${r.building_code}"` });
          continue;
        }
        changes.floor_id = floorId;
      }
      if ((r.x === undefined) !== (r.y === undefined)) {
        errors.push({ line: row.line, message: 'x and y must be given together' });
        continue;
      }
      if (r.x !== undefined && !changes.floor_id) {
        errors.push({ line: row.line, message: 'x/y require floor_level' });
        continue;
      }
      if (r.label !== undefined) changes.label = r.label;
      if (r.location !== undefined) changes.location = r.location;
      if (r.x !== undefined) {
        changes.x = r.x;
        changes.y = r.y;
      }
      if (Object.keys(changes).length === 0) {
        errors.push({ line: row.line, message: 'nothing to update' });
        continue;
      }
      planned.push({ line: row.line, pointId: pts[0]!.id, changes });
    }

    const report: ImportReport = {
      dryRun,
      rows: parsed.rows.length,
      applied: 0,
      errors,
      preview: planned.slice(0, 100),
    };
    if (dryRun || errors.length > 0) return report;

    const allowed = new Set(['building_id', 'floor_id', 'label', 'location', 'x', 'y']);
    await withTransaction(this.db, async (c) => {
      for (const p of planned) {
        const cols = Object.keys(p.changes).filter((k) => allowed.has(k));
        const sets = cols.map((k, i) => `${k} = $${i + 2}`);
        if (p.changes.building_id && !p.changes.floor_id) {
          // Same rule as the admin API: moving to another building detaches the point from its floor.
          const b = cols.indexOf('building_id') + 2;
          const detach = `(floor_id IS NOT NULL AND (SELECT f.building_id FROM floor f WHERE f.id = point.floor_id) IS DISTINCT FROM $${b}::uuid)`;
          sets.push(`floor_id = CASE WHEN ${detach} THEN NULL ELSE floor_id END`);
          if (!cols.includes('x')) sets.push(`x = CASE WHEN ${detach} THEN NULL ELSE x END`, `y = CASE WHEN ${detach} THEN NULL ELSE y END`);
        }
        await c.query(`UPDATE point SET ${sets.join(', ')} WHERE id = $1`, [p.pointId, ...cols.map((k) => p.changes[k])]);
      }
    });
    report.applied = planned.length;
    return report;
  }
}
