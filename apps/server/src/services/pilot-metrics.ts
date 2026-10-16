import { PILOT_TARGETS, type AvailabilityRow, type LatencyStats, type PilotQuery, type PilotReport, type PilotTarget } from '@firesafety/shared';
import type { Db } from '../db/pool.js';

const TZ = 'Asia/Jerusalem';
/** Range as two SQL expressions over $1/$2 (whole days in Israel time; the end is capped at now). */
const START = `(($1::date)::timestamp AT TIME ZONE '${TZ}')`;
const STOP = `LEAST((($2::date + 1)::timestamp AT TIME ZONE '${TZ}'), now())`;

/** Percentile columns over a numeric expression `ms`, optionally filtered. */
function stats(ms: string, filter = 'true'): string {
  return `count(*) FILTER (WHERE ${filter})::int AS n,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY ${ms}) FILTER (WHERE ${filter}) AS p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY ${ms}) FILTER (WHERE ${filter}) AS p95,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY ${ms}) FILTER (WHERE ${filter}) AS p99,
    max(${ms}) FILTER (WHERE ${filter}) AS max`;
}

interface StatRow { n: number; p50: number | null; p95: number | null; p99: number | null; max: number | null }
const round = (v: number | null) => (v === null ? null : Math.round(Number(v)));
const toStats = (r: StatRow | undefined, prefix = ''): LatencyStats => {
  const g = (k: string) => (r as unknown as Record<string, number | null> | undefined)?.[prefix + k] ?? null;
  return { count: Number(g('n') ?? 0), p50Ms: round(g('p50')), p95Ms: round(g('p95')), p99Ms: round(g('p99')), maxMs: round(g('max')) };
};
const seconds = (ms: number | null) => (ms === null ? null : `${(ms / 1000).toFixed(2)} שנ'`);

/** System-wide pilot metrics (FireAdmin only): latency, delivery completeness, notifications, availability. */
export class PilotMetricsService {
  constructor(private readonly db: Db) {}

  async report(q: PilotQuery): Promise<PilotReport> {
    const p = [q.from, q.to];
    const [period, ingest, completeness, firstNotif, notif, avail] = await Promise.all([
      this.db.query<{ s: number }>(`SELECT GREATEST(extract(epoch FROM ${STOP} - ${START}), 0)::float8 AS s`, p),
      // e2e: panel time when given and not ahead of the collector clock, else collector time.
      this.db.query(
        `WITH e AS (
           SELECT extract(epoch FROM received_at - observed_at) * 1000 AS c2s,
                  CASE WHEN source_ts IS NULL THEN extract(epoch FROM received_at - observed_at) * 1000
                       WHEN source_ts <= observed_at THEN extract(epoch FROM received_at - source_ts) * 1000 END AS e2e,
                  (source_ts IS NOT NULL AND source_ts > observed_at) AS skew
             FROM event_log WHERE seq IS NOT NULL AND received_at >= ${START} AND received_at < ${STOP})
         SELECT count(*)::int AS events, count(*) FILTER (WHERE skew)::int AS skew,
                ${stats('c2s')},
                ${stats('e2e', 'e2e IS NOT NULL').replace(/AS (n|p50|p95|p99|max)\b/g, 'AS e_$1')}
           FROM e`,
        p,
      ),
      this.db.query(
        `WITH s AS (
           SELECT collector_id, epoch, seq FROM event_log WHERE seq IS NOT NULL AND received_at >= ${START} AND received_at < ${STOP}
           UNION
           SELECT collector_id, epoch, seq FROM ingest_aux_seq WHERE received_at >= ${START} AND received_at < ${STOP})
         SELECT c.name, s.epoch, count(*)::int AS received, min(s.seq)::int AS first, max(s.seq)::int AS last,
                (max(s.seq) - min(s.seq) + 1 - count(*))::int AS missing
           FROM s JOIN collector c ON c.id = s.collector_id
          GROUP BY c.name, s.epoch ORDER BY c.name, min(s.seq)`,
        p,
      ),
      this.db.query(
        `WITH f AS (
           SELECT extract(epoch FROM min(n.sent_at) - a.received_at) * 1000 AS ms
             FROM alarm a JOIN notification n ON n.alarm_id = a.id AND n.status = 'sent' AND n.stage = 'initial'
            WHERE a.received_at >= ${START} AND a.received_at < ${STOP}
            GROUP BY a.id, a.received_at)
         SELECT ${stats('ms')} FROM f`,
        p,
      ),
      this.db.query(
        `SELECT n.channel,
                count(*) FILTER (WHERE n.status = 'sent')::int AS sent,
                count(*) FILTER (WHERE n.status = 'failed')::int AS failed,
                count(*) FILTER (WHERE n.status = 'skipped')::int AS skipped,
                count(*) FILTER (WHERE n.status IN ('pending', 'sending'))::int AS pending,
                ${stats('extract(epoch FROM n.sent_at - a.received_at) * 1000', "n.status = 'sent' AND n.stage = 'initial'")}
           FROM notification n JOIN alarm a ON a.id = n.alarm_id
          WHERE n.created_at >= ${START} AND n.created_at < ${STOP}
          GROUP BY n.channel ORDER BY n.channel`,
        p,
      ),
      // Downtime = communication alarms clipped to the range; each source has at most one open alarm at a time.
      this.db.query(
        `WITH src AS (
           SELECT 'collector' AS kind, c.id, c.name, c.created_at AS since FROM collector c WHERE c.active
           UNION ALL
           SELECT 'device', d.id, COALESCE(d.name, 'רכזת ' || d.device_instance), c.created_at
             FROM bacnet_device d JOIN collector c ON c.id = d.collector_id WHERE c.active),
         o AS (
           SELECT COALESCE(a.collector_id, a.device_id) AS id, count(*)::int AS outages,
                  sum(extract(epoch FROM LEAST(COALESCE(a.cleared_at, now()), ${STOP}) - GREATEST(a.raised_at, ${START}))) AS down
             FROM alarm a
            WHERE a.kind IN ('collector_comm', 'device_comm') AND a.raised_at < ${STOP} AND COALESCE(a.cleared_at, now()) > ${START}
            GROUP BY 1)
         SELECT src.kind, src.name, COALESCE(o.outages, 0) AS outages, COALESCE(o.down, 0)::float8 AS down,
                GREATEST(extract(epoch FROM ${STOP} - GREATEST(${START}, src.since)), 0)::float8 AS observed
           FROM src LEFT JOIN o ON o.id = src.id
          ORDER BY src.kind, src.name`,
        p,
      ),
    ]);

    const i = ingest.rows[0];
    const availability: AvailabilityRow[] = avail.rows.map((r) => ({
      kind: r.kind,
      name: r.name,
      outages: r.outages,
      downtimeSeconds: Math.round(r.down),
      availabilityPct: r.observed > 0 ? Math.max(0, Math.round((1 - r.down / r.observed) * 10_000) / 100) : 100,
    }));
    const completenessRows = completeness.rows.map((r) => ({ collectorName: r.name, epoch: r.epoch, received: r.received, firstSeq: r.first, lastSeq: r.last, missing: r.missing }));
    const endToEnd = toStats(i, 'e_');
    const first = toStats(firstNotif.rows[0]);
    const missing = completenessRows.reduce((s, r) => s + r.missing, 0);
    const minAvail = availability.length ? Math.min(...availability.map((a) => a.availabilityPct)) : null;

    const targets: PilotTarget[] = [
      { id: 'ingest_p95', target: `p95 < ${PILOT_TARGETS.ingestP95Ms / 1000} שנ'`, actual: seconds(endToEnd.p95Ms), met: endToEnd.p95Ms === null ? null : endToEnd.p95Ms < PILOT_TARGETS.ingestP95Ms },
      { id: 'notify_p95', target: `p95 < ${PILOT_TARGETS.notifyP95Ms / 1000} שנ'`, actual: seconds(first.p95Ms), met: first.p95Ms === null ? null : first.p95Ms < PILOT_TARGETS.notifyP95Ms },
      { id: 'completeness', target: '0 אירועים חסרים', actual: completenessRows.length ? String(missing) : null, met: completenessRows.length ? missing === 0 : null },
      { id: 'availability', target: `≥ ${PILOT_TARGETS.availabilityPct}%`, actual: minAvail === null ? null : `${minAvail}%`, met: minAvail === null ? null : minAvail >= PILOT_TARGETS.availabilityPct },
    ];

    return {
      from: q.from,
      to: q.to,
      periodSeconds: Math.round(period.rows[0]?.s ?? 0),
      ingest: { events: i?.events ?? 0, endToEnd, collectorToServer: toStats(i), clockSkewCount: i?.skew ?? 0 },
      completeness: completenessRows,
      firstNotification: first,
      notifications: notif.rows.map((r) => ({ channel: r.channel, sent: r.sent, failed: r.failed, skipped: r.skipped, pending: r.pending, latency: toStats(r) })),
      availability,
      targets,
    };
  }
}
