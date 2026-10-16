import type { AlarmProcedureView, ProcedureCategory, ProcedureInput, ProcedureRunView, ProcedureView } from '@firesafety/shared';
import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { badRequest, conflict, isUniqueViolation, notFound } from '../lib/errors.js';

interface RunRow {
  id: string;
  procedure_name: string;
  version: number;
  steps_snapshot: string[];
  state: Record<string, { done: boolean; by: string; at: string }>;
  started_at: Date;
  completed_at: Date | null;
}

const toRunView = (r: RunRow): ProcedureRunView => ({
  procedureName: r.procedure_name,
  version: r.version,
  steps: r.steps_snapshot.map((text, i) => {
    const s = r.state[String(i)];
    return { text, done: !!s?.done, by: s?.done ? s.by : null, at: s?.done ? s.at : null };
  }),
  startedAt: r.started_at.toISOString(),
  completedAt: r.completed_at?.toISOString() ?? null,
});

export class ProcedureService {
  constructor(private readonly db: Db) {}

  async list(): Promise<ProcedureView[]> {
    const { rows } = await this.db.query(
      `SELECT p.*, b.name AS building_name FROM procedure p LEFT JOIN building b ON b.id = p.building_id
        ORDER BY p.active DESC, p.category, b.name NULLS FIRST, p.name`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      buildingId: r.building_id,
      buildingName: r.building_name,
      steps: r.steps,
      version: r.version,
      active: r.active,
      updatedAt: (r.updated_at as Date).toISOString(),
    }));
  }

  async create(input: ProcedureInput, userId: string): Promise<string> {
    try {
      const { rows } = await this.db.query<{ id: string }>(
        `INSERT INTO procedure (name, category, building_id, steps, active, updated_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [input.name, input.category, input.buildingId, JSON.stringify(input.steps), input.active, userId],
      );
      return rows[0]!.id;
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /** Every edit bumps the version; runs keep their own frozen copy of the steps. */
  async update(id: string, input: ProcedureInput, userId: string): Promise<void> {
    try {
      const r = await this.db.query(
        `UPDATE procedure SET name = $2, category = $3, building_id = $4, steps = $5, active = $6,
                version = version + 1, updated_by = $7, updated_at = now() WHERE id = $1`,
        [id, input.name, input.category, input.buildingId, JSON.stringify(input.steps), input.active, userId],
      );
      if (r.rowCount === 0) throw notFound('Procedure');
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async remove(id: string): Promise<void> {
    const r = await this.db.query('DELETE FROM procedure WHERE id = $1', [id]);
    if (r.rowCount === 0) throw notFound('Procedure');
  }

  private mapError(err: unknown): unknown {
    if (isUniqueViolation(err)) return conflict('An active procedure already exists for this category and building');
    if ((err as { code?: string }).code === '23503') return notFound('Building');
    return err;
  }

  /** Building-specific procedure wins over the global one. */
  private async template(c: Db | import('pg').PoolClient, category: ProcedureCategory, buildingId: string | null) {
    const { rows } = await c.query<{ id: string; name: string; version: number; steps: string[] }>(
      `SELECT id, name, version, steps FROM procedure
        WHERE active AND category = $1 AND (building_id = $2 OR building_id IS NULL)
        ORDER BY building_id IS NULL LIMIT 1`,
      [category, buildingId],
    );
    return rows[0] ?? null;
  }

  async forAlarm(alarm: { id: string; category: string; kind: string; buildingId: string | null }): Promise<AlarmProcedureView> {
    const run = await this.db.query<RunRow>('SELECT * FROM procedure_run WHERE alarm_id = $1', [alarm.id]);
    if (run.rows[0]) return { template: null, run: toRunView(run.rows[0]) };
    const cat = (alarm.kind === 'point' ? alarm.category : 'comm') as ProcedureCategory;
    return { template: await this.template(this.db, cat, alarm.buildingId), run: null };
  }

  /** Marks a step; creates the run (with a frozen snapshot) on the first change. */
  async setStep(
    alarm: { id: string; category: string; kind: string; buildingId: string | null },
    index: number,
    done: boolean,
    user: { id: string; displayName: string },
  ): Promise<ProcedureRunView> {
    return withTransaction(this.db, async (c) => {
      let { rows } = await c.query<RunRow>('SELECT * FROM procedure_run WHERE alarm_id = $1 FOR UPDATE', [alarm.id]);
      if (!rows[0]) {
        const cat = (alarm.kind === 'point' ? alarm.category : 'comm') as ProcedureCategory;
        const t = await this.template(c, cat, alarm.buildingId);
        if (!t) throw notFound('Procedure');
        ({ rows } = await c.query<RunRow>(
          `INSERT INTO procedure_run (alarm_id, procedure_id, procedure_name, version, steps_snapshot, started_by)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (alarm_id) DO UPDATE SET alarm_id = EXCLUDED.alarm_id RETURNING *`,
          [alarm.id, t.id, t.name, t.version, JSON.stringify(t.steps), user.id],
        ));
      }
      const run = rows[0]!;
      if (index < 0 || index >= run.steps_snapshot.length) throw badRequest('Invalid step');
      const state = { ...run.state, [String(index)]: { done, by: user.displayName, at: new Date().toISOString() } };
      const complete = run.steps_snapshot.every((_, i) => state[String(i)]?.done);
      const { rows: updated } = await c.query<RunRow>(
        `UPDATE procedure_run SET state = $2, completed_at = CASE WHEN $3 THEN COALESCE(completed_at, now()) END
          WHERE id = $1 RETURNING *`,
        [run.id, JSON.stringify(state), complete],
      );
      await c.query('INSERT INTO procedure_step_log (run_id, step_index, done, user_id) VALUES ($1, $2, $3, $4)', [run.id, index, done, user.id]);
      return toRunView(updated[0]!);
    });
  }
}
