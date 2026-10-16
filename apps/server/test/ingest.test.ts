import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IngestBatch } from '@firesafety/shared';
import { createTestApp, loginAs, write, type TestContext } from './helpers.js';

let ctx: TestContext;
let admin: string;
let token: string;
let collectorId: string;

const now = () => new Date().toISOString();

function batch(partial: Partial<IngestBatch> = {}): IngestBatch {
  return {
    epoch: 'epoch-0001',
    sentAt: now(),
    collector: { version: '0.2.0', uptimeSeconds: 10, bufferDepth: 0 },
    devices: [],
    points: [],
    events: [],
    snapshots: [],
    ...partial,
  };
}

const ev = (seq: number, objectInstance: number, lifeSafetyState: string, extra: Record<string, unknown> = {}) => ({
  seq,
  deviceInstance: 1001,
  objectType: 'life-safety-point',
  objectInstance,
  source: 'notification' as const,
  observedAt: now(),
  eventState: lifeSafetyState === 'quiet' ? 'normal' : lifeSafetyState === 'alarm' ? 'life-safety-alarm' : 'offnormal',
  lifeSafetyState,
  ...extra,
});

async function send(b: IngestBatch, auth = token) {
  return ctx.app.inject({ method: 'POST', url: '/ingest/v1/batch', headers: { authorization: `Bearer ${auth}` }, payload: b });
}

async function activeAlarms(cookie = admin) {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/alarms', headers: { cookie } });
  return res.json().items as { id: string; category: string; kind: string; ackedAt: string | null; buildingId: string | null }[];
}

beforeEach(async () => {
  ctx = await createTestApp();
  admin = await loginAs(ctx.app, 'admin@campus.example', ['FireAdmin']);
  const res = await ctx.app.inject({ method: 'POST', url: '/api/admin/collectors', headers: write(admin), payload: { name: 'site-a' } });
  expect(res.statusCode).toBe(201);
  expect(res.headers['cache-control']).toBe('no-store');
  token = res.json().token;
  collectorId = res.json().collector.id;
});
afterEach(async () => ctx.close());

describe('ingest authentication', () => {
  it('rejects missing, malformed and unknown tokens and audits them', async () => {
    for (const auth of ['', 'nonsense', 'fsc_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']) {
      const res = await send(batch(), auth);
      expect(res.statusCode).toBe(401);
    }
    // Unauthenticated failures are throttled: one audit row per source per minute.
    const { rows } = await ctx.db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'ingest.auth'");
    expect(rows[0].n).toBe(1);
  });

  it('rejects an unauthenticated request before reading a large body', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/batch',
      headers: { authorization: 'Bearer fsc_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'content-type': 'application/json' },
      payload: '{' + 'x'.repeat(4 * 1024 * 1024),
    });
    expect(res.statusCode).toBe(401); // not 400: the malformed body was never parsed
  });

  it('caps the number of devices per collector', async () => {
    const devices = Array.from({ length: 201 }, (_, i) => ({ instance: 5000 + i, address: '10.0.0.1', online: true }));
    const res = await send(batch({ devices }));
    expect(res.statusCode).toBe(422);
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM bacnet_device')).rows[0].n).toBe(0); // transaction rolled back
  });

  it('stores only a hash of the collector token', async () => {
    const { rows } = await ctx.db.query('SELECT token_hash FROM collector');
    expect(Buffer.from(rows[0].token_hash).toString('utf8')).not.toContain(token);
  });

  it('rejects a deactivated collector', async () => {
    await ctx.app.inject({ method: 'POST', url: `/api/admin/collectors/${collectorId}/deactivate`, headers: write(admin) });
    expect((await send(batch())).statusCode).toBe(401);
  });

  it('a rotated token invalidates the old one', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: `/api/admin/collectors/${collectorId}/rotate-token`, headers: write(admin) });
    expect((await send(batch())).statusCode).toBe(401);
    expect((await send(batch(), res.json().token)).statusCode).toBe(200);
  });

  it('does not require a browser Origin header', async () => {
    expect((await send(batch())).statusCode).toBe(200);
  });

  it('validates the payload', async () => {
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...batch(), events: [{ seq: 0, objectType: 'DROP TABLE' }] },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('alarm lifecycle', () => {
  it('raises a fire alarm and is idempotent on retransmission', async () => {
    const b = batch({ events: [ev(1, 7, 'alarm')] });
    expect((await send(b)).json()).toEqual({ ackedSeq: 1 });
    expect((await send(b)).json()).toEqual({ ackedSeq: 1 });
    const alarms = await activeAlarms();
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({ category: 'fire', kind: 'point', ackedAt: null });
    const { rows } = await ctx.db.query('SELECT count(*)::int AS n FROM event_log');
    expect(rows[0].n).toBe(1);
  });

  it('prealarm -> fire opens a new occurrence; normal clears it', async () => {
    await send(batch({ events: [ev(1, 7, 'pre-alarm')] }));
    expect((await activeAlarms()).map((a) => a.category)).toEqual(['prealarm']);
    await send(batch({ events: [ev(2, 7, 'alarm')] }));
    expect((await activeAlarms()).map((a) => a.category)).toEqual(['fire']);
    await send(batch({ events: [ev(3, 7, 'quiet')] }));
    expect(await activeAlarms()).toEqual([]);
    const { rows } = await ctx.db.query('SELECT category, cleared_at IS NOT NULL AS cleared FROM alarm ORDER BY raised_at, category');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.cleared)).toBe(true);
  });

  it('applies events in seq order even if delivered out of order within a batch', async () => {
    await send(batch({ events: [ev(2, 7, 'quiet'), ev(1, 7, 'alarm')] }));
    expect(await activeAlarms()).toEqual([]);
  });

  it('snapshot reconcile clears points the panel no longer reports', async () => {
    await send(batch({ events: [ev(1, 7, 'alarm'), ev(2, 8, 'fault', { eventState: 'fault' })] }));
    expect(await activeAlarms()).toHaveLength(2);
    await send(batch({ snapshots: [{ seq: 3, deviceInstance: 1001, takenAt: now(), nonNormal: [{ objectType: 'life-safety-point', objectInstance: 7 }] }] }));
    expect((await activeAlarms()).map((a) => a.category)).toEqual(['fire']);
  });

  it('a new outbox epoch restarts sequence tracking without losing events', async () => {
    await send(batch({ events: [ev(1, 7, 'alarm'), ev(2, 7, 'quiet')] }));
    const res = await send(batch({ epoch: 'epoch-0002', events: [ev(1, 9, 'alarm')] }));
    expect(res.json()).toEqual({ ackedSeq: 1 });
    expect((await activeAlarms()).length).toBe(1);
  });

  it('raises and clears a device communication alarm', async () => {
    await send(batch({ devices: [{ instance: 1001, address: '10.0.0.5', online: false, error: 'timeout' }] }));
    expect((await activeAlarms()).map((a) => a.kind)).toEqual(['device_comm']);
    await send(batch({ devices: [{ instance: 1001, address: '10.0.0.5', online: true }] }));
    expect(await activeAlarms()).toEqual([]);
  });

  it('watchdog raises a collector alarm when the collector goes silent, cleared by the next batch', async () => {
    await send(batch());
    await ctx.db.query("UPDATE collector SET last_seen_at = now() - interval '5 minutes'");
    await ctx.app.runJobs();
    await ctx.app.runJobs(); // idempotent
    expect((await activeAlarms()).map((a) => a.kind)).toEqual(['collector_comm']);
    const status = (await ctx.app.inject({ method: 'GET', url: '/api/system/status', headers: { cookie: admin } })).json();
    expect(status).toMatchObject({ degraded: true, collectors: { total: 1, online: 0 } });
    await send(batch());
    expect(await activeAlarms()).toEqual([]);
  });

  it('reports degraded when no collector exists', async () => {
    await ctx.app.inject({ method: 'POST', url: `/api/admin/collectors/${collectorId}/deactivate`, headers: write(admin) });
    const status = (await ctx.app.inject({ method: 'GET', url: '/api/system/status', headers: { cookie: admin } })).json();
    expect(status.degraded).toBe(true);
  });
});

describe('alarm scope and acknowledgement', () => {
  let officer: string;
  let viewer: string;
  let bIn: string;

  beforeEach(async () => {
    const mk = async (code: string) =>
      (await ctx.app.inject({ method: 'POST', url: '/api/admin/buildings', headers: write(admin), payload: { name: code, code } })).json().id as string;
    bIn = await mk('IN');
    const bOut = await mk('OUT');
    officer = await loginAs(ctx.app, 'officer@campus.example', ['SafetyOfficer']);
    viewer = await loginAs(ctx.app, 'viewer@campus.example', ['Viewer']);
    for (const c of [officer, viewer]) {
      const id = (await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: c } })).json().id;
      await ctx.app.inject({ method: 'PUT', url: `/api/admin/users/${id}/scope`, headers: write(admin), payload: { buildingIds: [bIn] } });
    }
    // Point 1 → IN (point mapping), point 2 → OUT, point 3 unmapped on a device mapped to IN? no: device stays unmapped.
    await send(batch({ events: [ev(1, 1, 'alarm'), ev(2, 2, 'alarm'), ev(3, 3, 'alarm')] }));
    const points = (await ctx.app.inject({ method: 'GET', url: '/api/admin/points', headers: { cookie: admin } })).json().items as { id: string; objectInstance: number }[];
    const byInst = (n: number) => points.find((p) => p.objectInstance === n)!.id;
    await ctx.app.inject({ method: 'PATCH', url: `/api/admin/points/${byInst(1)}`, headers: write(admin), payload: { buildingId: bIn, label: 'גלאי מסדרון' } });
    await ctx.app.inject({ method: 'PATCH', url: `/api/admin/points/${byInst(2)}`, headers: write(admin), payload: { buildingId: bOut } });
  });

  it('officer sees only alarms of in-scope buildings; admin sees all', async () => {
    expect(await activeAlarms()).toHaveLength(3);
    const mine = await activeAlarms(officer);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.buildingId).toBe(bIn);
    const summary = (await ctx.app.inject({ method: 'GET', url: '/api/alarms/summary', headers: { cookie: officer } })).json();
    expect(summary.fire).toEqual({ active: 1, unacked: 1 });
  });

  it('unmapped points inherit the device building', async () => {
    const devices = (await ctx.app.inject({ method: 'GET', url: '/api/admin/devices', headers: { cookie: admin } })).json();
    await ctx.app.inject({ method: 'PATCH', url: `/api/admin/devices/${devices[0].id}`, headers: write(admin), payload: { buildingId: bIn } });
    // point 1 (IN) + point 3 (unmapped → device → IN); point 2 explicitly OUT stays hidden
    expect(await activeAlarms(officer)).toHaveLength(2);
  });

  it('out-of-scope alarm: 404 on read, ack and notes', async () => {
    const outId = (await activeAlarms()).find((a) => a.buildingId && a.buildingId !== bIn)!.id;
    for (const [method, url] of [['GET', `/api/alarms/${outId}`], ['POST', `/api/alarms/${outId}/ack`], ['POST', `/api/alarms/${outId}/notes`]] as const) {
      const res = await ctx.app.inject({ method, url, headers: write(officer), payload: method === 'POST' ? { text: 'x' } : undefined });
      expect(res.statusCode).toBe(404);
    }
    const { rows } = await ctx.db.query('SELECT acked_at FROM alarm WHERE id = $1', [outId]);
    expect(rows[0].acked_at).toBeNull();
  });

  it('viewer cannot acknowledge', async () => {
    const id = (await activeAlarms(viewer))[0]!.id;
    const res = await ctx.app.inject({ method: 'POST', url: `/api/alarms/${id}/ack`, headers: write(viewer), payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it('officer acknowledges with a note, once; audited; detail shows note and history', async () => {
    const id = (await activeAlarms(officer))[0]!.id;
    const first = await ctx.app.inject({ method: 'POST', url: `/api/alarms/${id}/ack`, headers: write(officer), payload: { note: 'נשלח מאבטח' } });
    expect(first.json()).toEqual({ acked: true, alreadyAcked: false });
    const second = await ctx.app.inject({ method: 'POST', url: `/api/alarms/${id}/ack`, headers: write(officer), payload: {} });
    expect(second.json()).toEqual({ acked: false, alreadyAcked: true });

    const detail = (await ctx.app.inject({ method: 'GET', url: `/api/alarms/${id}`, headers: { cookie: officer } })).json();
    expect(detail).toMatchObject({ pointLabel: 'גלאי מסדרון', ackedBy: 'officer' });
    expect(detail.notes.map((n: { text: string }) => n.text)).toEqual(['נשלח מאבטח']);
    expect(detail.history[0]).toMatchObject({ category: 'fire', lifeSafetyState: 'alarm' });

    const { rows } = await ctx.db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'alarm.ack'");
    expect(rows[0].n).toBe(1);
  });

  it('ack requires our Origin (CSRF)', async () => {
    const id = (await activeAlarms(officer))[0]!.id;
    const res = await ctx.app.inject({ method: 'POST', url: `/api/alarms/${id}/ack`, headers: { cookie: officer }, payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it('admin collectors/points endpoints are FireAdmin-only', async () => {
    for (const url of ['/api/admin/collectors', '/api/admin/points', '/api/admin/devices']) {
      expect((await ctx.app.inject({ method: 'GET', url, headers: { cookie: officer } })).statusCode).toBe(403);
    }
  });
});
