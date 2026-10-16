import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { MonitoringStatus } from '@firesafety/shared';
import { sha256 } from '../lib/crypto.js';

/** Prometheus text exposition (no labels with user data: counts only). */
export function toPrometheus(s: MonitoringStatus): string {
  const g = (name: string, help: string, value: number) => `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}\n`;
  return [
    g('firesafety_up', '1 when the status is ok, 0 when degraded or down', s.status === 'ok' ? 1 : 0),
    g('firesafety_db_up', 'Database reachable', s.db === 'ok' ? 1 : 0),
    g('firesafety_collectors_total', 'Active collectors', s.collectors.total),
    g('firesafety_collectors_online', 'Collectors that reported recently', s.collectors.online),
    g('firesafety_devices_total', 'Fire panels (BACnet devices)', s.devices.total),
    g('firesafety_devices_online', 'Fire panels responding', s.devices.online),
    g('firesafety_unacked_fire_alarms', 'Fire alarms not yet acknowledged', s.unackedFire),
    g('firesafety_notifications_stale_pending', 'Notifications pending for more than 60 s', s.notifications.stalePending),
    g('firesafety_notifications_failed_last_hour', 'Notifications that failed in the last hour', s.notifications.failedLastHour),
    g('firesafety_last_ingest_age_seconds', 'Seconds since any collector last reported (-1 = never)', s.lastIngestAgeSeconds ?? -1),
  ].join('');
}

/**
 * External uptime monitoring: GET /monitoring/v1/status with a bearer token.
 * 200 = ok, 503 = degraded or down, so any uptime checker works on the status code alone.
 * Registered only when MONITORING_TOKEN is configured; Caddy also restricts the source networks.
 */
export const monitoringRoutes: FastifyPluginAsync = async (app) => {
  const { config, services } = app;
  if (!config.MONITORING_TOKEN) return;
  const expected = sha256(config.MONITORING_TOKEN);

  app.get('/monitoring/v1/status', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m || !timingSafeEqual(sha256(m[1]!), expected)) {
      await services.audit.writeThrottled(`monitoring.auth:${req.ipHash}`, { action: 'monitoring.auth', outcome: 'denied', ipHash: req.ipHash });
      return reply.status(401).send({ error: 'unauthorized', message: 'Unauthorized' });
    }
    const status = await services.alarms.monitoringStatus();
    reply.header('Cache-Control', 'no-store').status(status.status === 'ok' ? 200 : 503);
    if ((req.query as Record<string, unknown>).format === 'prometheus') {
      return reply.type('text/plain; version=0.0.4; charset=utf-8').send(toPrometheus(status));
    }
    return status;
  });
};
