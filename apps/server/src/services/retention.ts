import type { Db } from '../db/pool.js';

export interface RetentionPolicy {
  eventLogDays: number;
  notificationDays: number;
  alarmDays: number;
}

/** Deletes data past its retention period. The audit log is intentionally not touched (append-only). */
export async function purgeExpired(db: Db, p: RetentionPolicy): Promise<Record<string, number>> {
  const run = async (sql: string, days: number) => (await db.query(sql, [days])).rowCount ?? 0;
  return {
    eventLog: await run(`DELETE FROM event_log WHERE received_at < now() - make_interval(days => $1)`, p.eventLogDays),
    ingestSeq: await run(`DELETE FROM ingest_aux_seq WHERE received_at < now() - make_interval(days => $1)`, p.eventLogDays),
    notifications: await run(`DELETE FROM notification WHERE created_at < now() - make_interval(days => $1) AND status IN ('sent','failed','skipped')`, p.notificationDays),
    // Only finished alarms; notes, procedure runs and notifications cascade.
    alarms: await run(`DELETE FROM alarm WHERE cleared_at IS NOT NULL AND cleared_at < now() - make_interval(days => $1)`, p.alarmDays),
  };
}
