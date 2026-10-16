import type { AlarmReport, AlarmReportRow, OpenIssueRow, ReportQuery } from '@firesafety/shared';
import type { Db } from '../db/pool.js';
import type { Scope } from './scope.js';

const BASE = `
  FROM alarm a
  LEFT JOIN point p ON p.id = a.point_id
  LEFT JOIN bacnet_device d ON d.id = COALESCE(a.device_id, p.device_id)
  LEFT JOIN building b ON b.id = COALESCE(p.building_id, d.building_id)
  LEFT JOIN app_user u ON u.id = a.acked_by`;

const TZ = 'Asia/Jerusalem';

/** WHERE clause for a report query. Dates are whole days in Israel time, inclusive. */
function where(scope: Scope, q: ReportQuery, params: unknown[]): string {
  params.push(q.from, q.to);
  const conds = [`a.raised_at >= ($1::date)::timestamp AT TIME ZONE '${TZ}'`, `a.raised_at < ($2::date + 1)::timestamp AT TIME ZONE '${TZ}'`];
  if (q.buildingId) {
    params.push(q.buildingId);
    conds.push(`b.id = $${params.length}`);
  }
  if (q.category) {
    params.push(q.category);
    conds.push(`a.category = $${params.length}`);
  }
  if (scope.kind === 'assigned') {
    params.push(scope.userId);
    conds.push(`EXISTS (SELECT 1 FROM user_building_scope s WHERE s.user_id = $${params.length} AND s.building_id = b.id)`);
  }
  return conds.join(' AND ');
}

export class ReportService {
  constructor(private readonly db: Db) {}

  async alarms(scope: Scope, q: ReportQuery, limit: number): Promise<AlarmReport> {
    const params: unknown[] = [];
    const w = where(scope, q, params);
    const [total, byCat, byBuilding, rt, items] = await Promise.all([
      this.db.query<{ n: string }>(`SELECT count(*) AS n ${BASE} WHERE ${w}`, params),
      this.db.query(`SELECT a.category, count(*)::int AS count ${BASE} WHERE ${w} GROUP BY a.category ORDER BY count DESC`, params),
      this.db.query(`SELECT b.name AS building_name, count(*)::int AS count ${BASE} WHERE ${w} GROUP BY b.name ORDER BY count DESC`, params),
      this.db.query(
        `SELECT a.category, count(*)::int AS count, count(a.acked_at)::int AS acked,
                count(*) FILTER (WHERE a.acked_at IS NULL)::int AS unacked,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM a.acked_at - a.raised_at)) AS median,
                avg(extract(epoch FROM a.acked_at - a.raised_at)) AS avg,
                max(extract(epoch FROM a.acked_at - a.raised_at)) AS max
           ${BASE} WHERE ${w} GROUP BY a.category ORDER BY min(a.priority)`,
        params,
      ),
      this.rows(w, params, limit),
    ]);
    const num = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v)));
    return {
      total: Number(total.rows[0]?.n ?? 0),
      byCategory: byCat.rows,
      byBuilding: byBuilding.rows.map((r) => ({ buildingName: r.building_name, count: r.count })),
      responseTimes: rt.rows.map((r) => ({
        category: r.category,
        count: r.count,
        acked: r.acked,
        unacked: r.unacked,
        medianSeconds: num(r.median),
        avgSeconds: num(r.avg),
        maxSeconds: num(r.max),
      })),
      items: await items,
    };
  }

  async alarmRows(scope: Scope, q: ReportQuery, limit: number): Promise<AlarmReportRow[]> {
    const params: unknown[] = [];
    return this.rows(where(scope, q, params), params, limit);
  }

  private async rows(w: string, params: unknown[], limit: number): Promise<AlarmReportRow[]> {
    const { rows } = await this.db.query(
      `SELECT a.id, a.raised_at, a.cleared_at, a.acked_at, a.category, a.kind, a.message,
              extract(epoch FROM a.acked_at - a.raised_at) AS ack_seconds,
              b.name AS building_name, u.display_name AS acked_by,
              COALESCE(p.label, p.name, p.object_type || ':' || p.object_instance) AS point_label,
              COALESCE(p.location, p.description) AS location
         ${BASE} WHERE ${w} ORDER BY a.raised_at DESC LIMIT ${Math.min(limit, 50_000)}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      raisedAt: (r.raised_at as Date).toISOString(),
      clearedAt: r.cleared_at ? (r.cleared_at as Date).toISOString() : null,
      ackedAt: r.acked_at ? (r.acked_at as Date).toISOString() : null,
      ackSeconds: r.ack_seconds === null ? null : Math.round(Number(r.ack_seconds)),
      category: r.category,
      kind: r.kind,
      buildingName: r.building_name,
      pointLabel: r.kind === 'point' ? r.point_label : r.message,
      location: r.location,
      ackedBy: r.acked_by,
    }));
  }

  /** Points currently disabled or in fault, oldest first. */
  async openIssues(scope: Scope): Promise<OpenIssueRow[]> {
    const params: unknown[] = [];
    let scopeSql = 'TRUE';
    if (scope.kind === 'assigned') {
      params.push(scope.userId);
      scopeSql = `EXISTS (SELECT 1 FROM user_building_scope s WHERE s.user_id = $1 AND s.building_id = COALESCE(p.building_id, d.building_id))`;
    }
    const { rows } = await this.db.query(
      `SELECT p.id, p.category, b.name AS building_name, p.state_changed_at,
              COALESCE(p.label, p.name, p.object_type || ':' || p.object_instance) AS point_label,
              COALESCE(p.location, p.description) AS location
         FROM point p JOIN bacnet_device d ON d.id = p.device_id
         LEFT JOIN building b ON b.id = COALESCE(p.building_id, d.building_id)
        WHERE p.category IN ('disabled','fault') AND ${scopeSql}
        ORDER BY p.state_changed_at NULLS FIRST, point_label LIMIT 5000`,
      params,
    );
    return rows.map((r) => ({
      pointId: r.id,
      category: r.category,
      buildingName: r.building_name,
      pointLabel: r.point_label,
      location: r.location,
      since: r.state_changed_at ? (r.state_changed_at as Date).toISOString() : null,
    }));
  }
}
