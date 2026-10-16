import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IngestBatch } from '@firesafety/shared';
import { createTestApp, loginAs, write, type TestContext } from './helpers.js';
import { toPrometheus } from '../src/routes/monitoring.js';

let ctx: TestContext;
let admin: string;
let token: string;
let collectorId: string;

const ilDate = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(Date.now() + offsetDays * 86_400_000));
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const RANGE = () => `from=${ilDate(-1)}&to=${ilDate()}`;

function batch(partial: Partial<IngestBatch>): Partial<IngestBatch> {
  return { epoch: 'epoch-pilot1', sentAt: ago(0), collector: { version: 't', uptimeSeconds: 1, bufferDepth: 0 }, ...partial };
}
const ev = (seq: number, inst: number, observedMs: number, sourceMs?: number) => ({
  seq,
  deviceInstance: 1001,
  objectType: 'life-safety-point',
  objectInstance: inst,
  source: 'notification' as const,
  observedAt: ago(observedMs),
  ...(sourceMs !== undefined ? { sourceTs: ago(sourceMs) } : {}),
  lifeSafetyState: 'quiet',
});
async function send(b: Partial<IngestBatch>) {
  const r = await ctx.app.inject({ method: 'POST', url: '/ingest/v1/batch', headers: { authorization: `Bearer ${token}` }, payload: batch(b) });
  expect(r.statusCode).toBe(200);
  return r.json();
}
const report = async (cookie = admin, q = RANGE()) => ctx.app.inject({ method: 'GET', url: `/api/reports/pilot?${q}`, headers: { cookie } });

beforeEach(async () => {
  ctx = await createTestApp({ config: { MONITORING_TOKEN: 'm'.repeat(40) } });
  admin = await loginAs(ctx.app, 'admin@campus.example', ['FireAdmin']);
  const c = (await ctx.app.inject({ method: 'POST', url: '/api/admin/collectors', headers: write(admin), payload: { name: 'lab' } })).json();
  token = c.token;
  collectorId = c.collector.id;
});
afterEach(async () => ctx.close());

describe('pilot report', () => {
  it('measures latency, separates panel clock skew, and proves completeness across events, snapshots and inventory', async () => {
    await send({
      devices: [{ instance: 1001, address: '10.0.0.5', online: true }],
      events: [ev(1, 7, 1500, 2500), ev(2, 8, 1500, 2500), ev(5, 9, 1500)],
      snapshots: [{ seq: 3, deviceInstance: 1001, takenAt: ago(1000), nonNormal: [] }],
      inventorySeqs: [4],
      points: [{ deviceInstance: 1001, objectType: 'life-safety-point', objectInstance: 7 }],
    });
    await send({ events: [ev(6, 10, 1500, -60_000)] }); // panel clock one minute ahead
    const r = (await report()).json();
    expect(r.ingest.events).toBe(4);
    expect(r.ingest.clockSkewCount).toBe(1);
    expect(r.ingest.collectorToServer.count).toBe(4);
    expect(r.ingest.collectorToServer.p50Ms).toBeGreaterThanOrEqual(1400);
    expect(r.ingest.collectorToServer.p50Ms).toBeLessThan(3000);
    // e2e excludes the skewed event: two from panel time (~2.5 s), one from collector time (~1.5 s)
    expect(r.ingest.endToEnd.count).toBe(3);
    expect(r.ingest.endToEnd.maxMs).toBeGreaterThanOrEqual(2400);
    expect(r.completeness).toEqual([{ collectorName: 'lab', epoch: 'epoch-pilot1', received: 6, firstSeq: 1, lastSeq: 6, missing: 0 }]);
    expect(r.targets.find((t: { id: string }) => t.id === 'completeness')).toMatchObject({ met: true, actual: '0' });
    expect(r.targets.find((t: { id: string }) => t.id === 'ingest_p95').met).toBe(true);

    // A lost item (seq 7 never arrives) is detected.
    await send({ events: [ev(8, 7, 100)] });
    const r2 = (await report()).json();
    expect(r2.completeness[0].missing).toBe(1);
    expect(r2.targets.find((t: { id: string }) => t.id === 'completeness')).toMatchObject({ met: false, actual: '1' });
  });

  it('first-notification latency per alarm, per-channel counts, and availability clipped to the range', async () => {
    await send({ devices: [{ instance: 1001, address: '10.0.0.5', online: true }], events: [{ ...ev(1, 7, 100), lifeSafetyState: 'alarm' }] });
    const userId = (await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: admin } })).json().id;
    const alarmId = (await ctx.db.query(`SELECT id FROM alarm WHERE kind = 'point'`)).rows[0].id;
    await ctx.db.query(`UPDATE alarm SET received_at = now() - interval '10 seconds' WHERE id = $1`, [alarmId]);
    await ctx.db.query(
      `INSERT INTO notification (alarm_id, user_id, channel, stage, status, sent_at) VALUES
         ($1, $2, 'push', 'initial', 'sent', now() - interval '6 seconds'),
         ($1, $2, 'sms', 'initial', 'sent', now() - interval '2 seconds'),
         ($1, $2, 'email', 'initial', 'failed', NULL),
         ($1, $2, 'whatsapp', 'initial', 'skipped', NULL)`,
      [alarmId, userId],
    );
    // A 10-minute collector outage, plus a device outage still open since 5 minutes ago.
    await ctx.db.query(
      `INSERT INTO alarm (kind, collector_id, category, priority, raised_at, cleared_at) VALUES ('collector_comm', $1, 'fault', 3, now() - interval '20 minutes', now() - interval '10 minutes')`,
      [collectorId],
    );
    const dev = (await ctx.db.query('SELECT id FROM bacnet_device')).rows[0].id;
    await ctx.db.query(`INSERT INTO alarm (kind, device_id, category, priority, raised_at) VALUES ('device_comm', $1, 'fault', 3, now() - interval '5 minutes')`, [dev]);
    // Also an old outage entirely outside the range: ignored.
    await ctx.db.query(
      `INSERT INTO alarm (kind, collector_id, category, priority, raised_at, cleared_at) VALUES ('collector_comm', $1, 'fault', 3, now() - interval '9 days', now() - interval '8 days')`,
      [collectorId],
    );
    await ctx.db.query(`UPDATE collector SET created_at = now() - interval '30 days'`);

    const r = (await report()).json();
    expect(r.firstNotification.count).toBe(1);
    expect(r.firstNotification.p50Ms).toBeGreaterThanOrEqual(3900);
    expect(r.firstNotification.p50Ms).toBeLessThan(4500);
    const byCh = Object.fromEntries(r.notifications.map((n: { channel: string }) => [n.channel, n]));
    expect([byCh.push.sent, byCh.sms.sent, byCh.email.failed, byCh.whatsapp.skipped]).toEqual([1, 1, 1, 1]);
    expect(byCh.sms.latency.p50Ms).toBeGreaterThanOrEqual(7900);

    const col = r.availability.find((a: { kind: string }) => a.kind === 'collector');
    expect(col.outages).toBe(1);
    expect(col.downtimeSeconds).toBeGreaterThanOrEqual(599);
    expect(col.downtimeSeconds).toBeLessThanOrEqual(601);
    expect(col.availabilityPct).toBeLessThan(100);
    const device = r.availability.find((a: { kind: string }) => a.kind === 'device');
    expect(device.downtimeSeconds).toBeGreaterThanOrEqual(299);
    expect(r.targets.find((t: { id: string }) => t.id === 'notify_p95').met).toBe(true);
  });

  it('is for administrators only and validates the range', async () => {
    const officer = await loginAs(ctx.app, 'officer@campus.example', ['SafetyOfficer']);
    expect((await report(officer)).statusCode).toBe(403);
    expect((await report(admin, 'from=2026-01-01&to=2026-06-01')).statusCode).toBe(400);
    const empty = (await report()).json();
    expect(empty.targets.map((t: { met: boolean | null }) => t.met)).toEqual([null, null, null, true]);
  });

  it('retention purges old sequence records with the event log', async () => {
    await send({ snapshots: [{ seq: 1, deviceInstance: 1001, takenAt: ago(0), nonNormal: [] }] });
    await ctx.db.query(`UPDATE ingest_aux_seq SET received_at = now() - interval '800 days'`);
    const purged = await ctx.app.runRetention();
    expect(purged.ingestSeq).toBe(1);
  });
});

describe('monitoring endpoint', () => {
  const mon = (auth?: string, q = '') => ctx.app.inject({ method: 'GET', url: `/monitoring/v1/status${q}`, headers: auth ? { authorization: auth } : {} });

  it('requires the bearer token, and is absent when not configured', async () => {
    expect((await mon()).statusCode).toBe(401);
    expect((await mon('Bearer wrong')).statusCode).toBe(401);
    expect((await mon(`Basic ${'m'.repeat(40)}`)).statusCode).toBe(401);
    const audits = (await ctx.db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'monitoring.auth'`)).rows[0].n;
    expect(audits).toBe(1); // throttled
    const off = await createTestApp();
    expect((await off.app.inject({ method: 'GET', url: '/monitoring/v1/status', headers: { authorization: `Bearer ${'m'.repeat(40)}` } })).statusCode).toBe(404);
    await off.close();
  });

  it('503 while degraded, 200 when healthy; reports counts only; Prometheus format', async () => {
    const auth = `Bearer ${'m'.repeat(40)}`;
    // Collector registered but silent: degraded.
    const d = await mon(auth);
    expect(d.statusCode).toBe(503);
    expect(d.json()).toMatchObject({ status: 'degraded', db: 'ok', collectors: { total: 1, online: 0 } });
    expect(d.headers['cache-control']).toBe('no-store');

    await send({ devices: [{ instance: 1001, address: '10.0.0.5', online: true }] });
    const ok = await mon(auth);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'ok', collectors: { total: 1, online: 1 }, devices: { total: 1, online: 1 }, unackedFire: 0 });
    expect(ok.json().lastIngestAgeSeconds).toBeLessThan(5);
    expect(ok.body).not.toMatch(/lab|10\.0\.0\.5/); // no names or addresses

    // A stuck notification degrades the status.
    await send({ events: [{ ...ev(1, 7, 100), lifeSafetyState: 'alarm' }] });
    const userId = (await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: admin } })).json().id;
    const alarmId = (await ctx.db.query(`SELECT id FROM alarm`)).rows[0].id;
    await ctx.db.query(`INSERT INTO notification (alarm_id, user_id, channel, stage, status, next_attempt_at) VALUES ($1, $2, 'sms', 'initial', 'pending', now() - interval '5 minutes')`, [alarmId, userId]);
    const stuck = await mon(auth, '?format=prometheus');
    expect(stuck.statusCode).toBe(503);
    expect(stuck.headers['content-type']).toMatch(/text\/plain/);
    expect(stuck.body).toMatch(/^firesafety_up 0$/m);
    expect(stuck.body).toMatch(/^firesafety_unacked_fire_alarms 1$/m);
    expect(stuck.body).toMatch(/^firesafety_notifications_stale_pending 1$/m);
  });

  it('prometheus rendering of a down state', () => {
    const text = toPrometheus({ status: 'down', checkedAt: '', db: 'error', collectors: { total: 0, online: 0 }, devices: { total: 0, online: 0 }, unackedFire: 0, notifications: { stalePending: 0, failedLastHour: 0 }, lastIngestAgeSeconds: null });
    expect(text).toMatch(/^firesafety_db_up 0$/m);
    expect(text).toMatch(/^firesafety_last_ingest_age_seconds -1$/m);
  });
});
