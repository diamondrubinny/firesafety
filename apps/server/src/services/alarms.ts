import {
  ALARM_CATEGORIES,
  type AlarmCategory,
  type AlarmDetail,
  type AlarmSummary,
  type AlarmView,
  type Page,
  type SystemStatus,
} from '@firesafety/shared';
import type { Db } from '../db/pool.js';
import type { Scope } from './scope.js';

/*
 * Effective building of an alarm: the point's building, falling back to the
 * panel's building. Collector alarms have no building and are visible only to
 * global-scope users (everyone sees the degraded banner via /system/status).
 */
const FROM = `
  FROM alarm a
  LEFT JOIN point p ON p.id = a.point_id
  LEFT JOIN bacnet_device d ON d.id = COALESCE(a.device_id, p.device_id)
  LEFT JOIN collector c ON c.id = a.collector_id
  LEFT JOIN building b ON b.id = COALESCE(p.building_id, d.building_id)
  LEFT JOIN app_user u ON u.id = a.acked_by`;

const COLUMNS = `
  a.id, a.kind, a.category, a.priority, a.message, a.raised_at, a.cleared_at, a.acked_at,
  u.display_name AS acked_by_name,
  b.id AS building_id, b.name AS building_name,
  p.id AS point_id,
  COALESCE(p.label, p.name, p.object_type || ':' || p.object_instance) AS point_label,
  COALESCE(p.location, p.description) AS location,
  COALESCE(d.name, 'device ' || d.device_instance, c.name) AS device_name,
  p.floor_id`;

/** Appends the scope predicate; returns the SQL fragment. */
function scopeClause(scope: Scope, params: unknown[]): string {
  if (scope.kind === 'all') return 'TRUE';
  params.push(scope.userId);
  return `EXISTS (SELECT 1 FROM user_building_scope s WHERE s.user_id = $${params.length} AND s.building_id = b.id)`;
}

interface Row {
  id: string;
  kind: AlarmView['kind'];
  category: AlarmCategory;
  priority: number;
  message: string | null;
  raised_at: Date;
  cleared_at: Date | null;
  acked_at: Date | null;
  acked_by_name: string | null;
  building_id: string | null;
  building_name: string | null;
  point_id: string | null;
  point_label: string | null;
  location: string | null;
  device_name: string | null;
  floor_id: string | null;
}

const toView = (r: Row): AlarmView => ({
  id: r.id,
  kind: r.kind,
  category: r.category,
  priority: r.priority,
  active: r.cleared_at === null,
  raisedAt: r.raised_at.toISOString(),
  clearedAt: r.cleared_at?.toISOString() ?? null,
  ackedAt: r.acked_at?.toISOString() ?? null,
  ackedBy: r.acked_by_name,
  buildingId: r.building_id,
  buildingName: r.building_name,
  pointId: r.point_id,
  pointLabel: r.point_label,
  location: r.location,
  deviceName: r.device_name,
  message: r.message,
  floorId: r.floor_id,
});

export class AlarmService {
  constructor(
    private readonly db: Db,
    private readonly collectorStaleSeconds: number,
  ) {}

  async list(
    scope: Scope,
    q: { state: 'active' | 'all'; category?: AlarmCategory; limit: number; offset: number },
  ): Promise<Page<AlarmView>> {
    const params: unknown[] = [];
    const where = [scopeClause(scope, params)];
    if (q.state === 'active') where.push('a.cleared_at IS NULL');
    if (q.category) {
      params.push(q.category);
      where.push(`a.category = $${params.length}`);
    }
    const whereSql = where.join(' AND ');
    const order =
      q.state === 'active'
        ? 'ORDER BY (a.acked_at IS NULL) DESC, a.priority, a.raised_at DESC'
        : 'ORDER BY a.raised_at DESC';
    const [items, total] = await Promise.all([
      this.db.query<Row>(`SELECT ${COLUMNS} ${FROM} WHERE ${whereSql} ${order} LIMIT ${q.limit} OFFSET ${q.offset}`, params),
      this.db.query<{ count: string }>(`SELECT count(*) ${FROM} WHERE ${whereSql}`, params),
    ]);
    return { items: items.rows.map(toView), total: Number(total.rows[0]?.count ?? 0) };
  }

  async get(id: string, scope: Scope): Promise<AlarmDetail | null> {
    const params: unknown[] = [id];
    const { rows } = await this.db.query<Row>(`SELECT ${COLUMNS} ${FROM} WHERE a.id = $1 AND ${scopeClause(scope, params)}`, params);
    const row = rows[0];
    if (!row) return null;
    const [notes, history] = await Promise.all([
      this.db.query(
        `SELECT n.id, n.ts, u.display_name AS author, n.text FROM alarm_note n LEFT JOIN app_user u ON u.id = n.user_id
          WHERE n.alarm_id = $1 ORDER BY n.ts`,
        [id],
      ),
      row.point_id
        ? this.db.query(
            `SELECT COALESCE(source_ts, observed_at) AS ts, category, event_state, life_safety_state, source
               FROM event_log WHERE point_id = $1 ORDER BY id DESC LIMIT 50`,
            [row.point_id],
          )
        : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
    ]);
    return {
      ...toView(row),
      notes: notes.rows.map((n) => ({ id: n.id, ts: (n.ts as Date).toISOString(), author: n.author, text: n.text })),
      history: history.rows.map((h) => ({
        ts: (h.ts as Date).toISOString(),
        category: h.category as string,
        eventState: (h.event_state as string | null) ?? null,
        lifeSafetyState: (h.life_safety_state as string | null) ?? null,
        source: h.source as string,
      })),
    };
  }

  /** Internal acknowledgement only; nothing is sent to the panel. Returns false if it was already acknowledged. */
  async ack(id: string, userId: string): Promise<boolean> {
    const r = await this.db.query('UPDATE alarm SET acked_at = now(), acked_by = $2 WHERE id = $1 AND acked_at IS NULL', [id, userId]);
    return r.rowCount === 1;
  }

  async addNote(alarmId: string, userId: string, text: string): Promise<void> {
    await this.db.query('INSERT INTO alarm_note (alarm_id, user_id, text) VALUES ($1, $2, $3)', [alarmId, userId, text]);
  }

  async summary(scope: Scope): Promise<AlarmSummary> {
    const params: unknown[] = [];
    const { rows } = await this.db.query<{ category: AlarmCategory; active: string; unacked: string }>(
      `SELECT a.category, count(*) AS active, count(*) FILTER (WHERE a.acked_at IS NULL) AS unacked
         ${FROM} WHERE a.cleared_at IS NULL AND ${scopeClause(scope, params)} GROUP BY a.category`,
      params,
    );
    const out = Object.fromEntries(ALARM_CATEGORIES.map((c) => [c, { active: 0, unacked: 0 }])) as AlarmSummary;
    for (const r of rows) out[r.category] = { active: Number(r.active), unacked: Number(r.unacked) };
    return out;
  }

  async systemStatus(): Promise<SystemStatus> {
    const { rows } = await this.db.query<{ total: string; online: string; dev_total: string; dev_online: string }>(
      `SELECT
         (SELECT count(*) FROM collector WHERE active) AS total,
         (SELECT count(*) FROM collector WHERE active AND last_seen_at > now() - make_interval(secs => $1)) AS online,
         (SELECT count(*) FROM bacnet_device d JOIN collector c ON c.id = d.collector_id WHERE c.active) AS dev_total,
         (SELECT count(*) FROM bacnet_device d JOIN collector c ON c.id = d.collector_id
           WHERE c.active AND d.online AND c.last_seen_at > now() - make_interval(secs => $1)) AS dev_online`,
      [this.collectorStaleSeconds],
    );
    const r = rows[0]!;
    const collectors = { total: Number(r.total), online: Number(r.online) };
    const devices = { total: Number(r.dev_total), online: Number(r.dev_online) };
    return {
      collectors,
      devices,
      // No collector at all also counts as degraded: nothing is being monitored.
      degraded: collectors.total === 0 || collectors.online < collectors.total || devices.online < devices.total,
      checkedAt: new Date().toISOString(),
    };
  }
}
