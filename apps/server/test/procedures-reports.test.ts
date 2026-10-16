import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toCsv } from '../src/lib/csv-export.js';
import { createTestApp, loginAs, write, type TestContext } from './helpers.js';

let ctx: TestContext;
let admin: string;
let officer: string;
let viewer: string;
let operator: string;
let bIn: string;
let bOut: string;
let token: string;
let seq = 0;

async function event(objectInstance: number, ls: string) {
  seq++;
  await ctx.app.inject({
    method: 'POST', url: '/ingest/v1/batch', headers: { authorization: `Bearer ${token}` },
    payload: {
      epoch: 'epoch-p5', sentAt: new Date().toISOString(), collector: { version: 't', uptimeSeconds: 1, bufferDepth: 0 },
      events: [{ seq, deviceInstance: 1001, objectType: 'life-safety-point', objectInstance, source: 'poll', observedAt: new Date().toISOString(), lifeSafetyState: ls }],
    },
  });
}
const alarmOf = async (inst: number) =>
  (await ctx.db.query('SELECT a.id FROM alarm a JOIN point p ON p.id = a.point_id WHERE p.object_instance = $1 ORDER BY a.raised_at DESC LIMIT 1', [inst])).rows[0]!.id as string;
const proc = (payload: object, cookie = admin) => ctx.app.inject({ method: 'POST', url: '/api/admin/procedures', headers: write(cookie), payload });

beforeEach(async () => {
  seq = 0;
  ctx = await createTestApp();
  admin = await loginAs(ctx.app, 'admin@campus.example', ['FireAdmin']);
  officer = await loginAs(ctx.app, 'officer@campus.example', ['SafetyOfficer']);
  viewer = await loginAs(ctx.app, 'viewer@campus.example', ['Viewer']);
  operator = await loginAs(ctx.app, 'operator@campus.example', ['Operator']);
  const mk = async (code: string) => (await ctx.app.inject({ method: 'POST', url: '/api/admin/buildings', headers: write(admin), payload: { name: `בניין ${code}`, code } })).json().id as string;
  bIn = await mk('IN');
  bOut = await mk('OUT');
  for (const c of [officer, viewer, operator]) {
    const id = (await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: c } })).json().id;
    await ctx.app.inject({ method: 'PUT', url: `/api/admin/users/${id}/scope`, headers: write(admin), payload: { buildingIds: [bIn] } });
  }
  token = (await ctx.app.inject({ method: 'POST', url: '/api/admin/collectors', headers: write(admin), payload: { name: 'c' } })).json().token;
  await event(1, 'alarm'); // creates device + point 1
  await event(2, 'alarm');
  const pts = (await ctx.app.inject({ method: 'GET', url: '/api/admin/points', headers: { cookie: admin } })).json().items as { id: string; objectInstance: number }[];
  await ctx.app.inject({ method: 'PATCH', url: `/api/admin/points/${pts.find((p) => p.objectInstance === 1)!.id}`, headers: write(admin), payload: { buildingId: bIn, label: 'גלאי 1' } });
  await ctx.app.inject({ method: 'PATCH', url: `/api/admin/points/${pts.find((p) => p.objectInstance === 2)!.id}`, headers: write(admin), payload: { buildingId: bOut, label: 'גלאי 2' } });
});
afterEach(async () => ctx.close());

describe('procedures', () => {
  it('building-specific procedure wins over the global one; one active per scope', async () => {
    expect((await proc({ name: 'אש כללי', category: 'fire', steps: ['לשלוח מאבטח', 'לעדכן מוקד'] })).statusCode).toBe(201);
    expect((await proc({ name: 'אש כללי 2', category: 'fire', steps: ['x'] })).statusCode).toBe(409);
    expect((await proc({ name: 'אש בניין IN', category: 'fire', buildingId: bIn, steps: ['פינוי מעבדות', 'סגירת גז', 'דיווח'] })).statusCode).toBe(201);
    const a1 = await alarmOf(1);
    const view = (await ctx.app.inject({ method: 'GET', url: `/api/alarms/${a1}/procedure`, headers: { cookie: officer } })).json();
    expect(view).toMatchObject({ run: null, template: { name: 'אש בניין IN', steps: ['פינוי מעבדות', 'סגירת גז', 'דיווח'] } });
    const a2 = await alarmOf(2);
    const global = (await ctx.app.inject({ method: 'GET', url: `/api/alarms/${a2}/procedure`, headers: { cookie: admin } })).json();
    expect(global.template.name).toBe('אש כללי');
  });

  it('checking steps creates a frozen run; later edits do not change it; completion recorded', async () => {
    const id = (await proc({ name: 'אש', category: 'fire', steps: ['א', 'ב'] })).json().id;
    const a1 = await alarmOf(1);
    const step = (i: number, done: boolean, cookie = officer) =>
      ctx.app.inject({ method: 'POST', url: `/api/alarms/${a1}/procedure/steps/${i}`, headers: write(cookie), payload: { done } });
    let run = (await step(0, true)).json();
    expect(run.steps.map((s: { done: boolean }) => s.done)).toEqual([true, false]);
    expect(run.steps[0].by).toBe('officer');
    await ctx.app.inject({ method: 'PUT', url: `/api/admin/procedures/${id}`, headers: write(admin), payload: { name: 'אש', category: 'fire', steps: ['חדש 1', 'חדש 2', 'חדש 3'] } });
    run = (await step(1, true, operator)).json();
    expect(run.steps.map((s: { text: string }) => s.text)).toEqual(['א', 'ב']);
    expect(run.completedAt).not.toBeNull();
    expect(run.version).toBe(1);
    run = (await step(1, false)).json();
    expect(run.completedAt).toBeNull();
    const log = await ctx.db.query('SELECT count(*)::int AS n FROM procedure_step_log');
    expect(log.rows[0].n).toBe(3);
    expect((await step(5, true)).statusCode).toBe(400);
  });

  it('viewers cannot check steps; out-of-scope alarms are 404', async () => {
    await proc({ name: 'אש', category: 'fire', steps: ['א'] });
    const a1 = await alarmOf(1);
    const a2 = await alarmOf(2);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/alarms/${a1}/procedure/steps/0`, headers: write(viewer), payload: { done: true } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/alarms/${a2}/procedure`, headers: { cookie: officer } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/alarms/${a2}/procedure/steps/0`, headers: write(officer), payload: { done: true } })).statusCode).toBe(404);
  });

  it('procedure admin is FireAdmin-only and validated', async () => {
    expect((await proc({ name: 'x', category: 'fire', steps: ['a'] }, officer)).statusCode).toBe(403);
    expect((await proc({ name: 'x', category: 'fire', steps: [] })).statusCode).toBe(400);
    expect((await proc({ name: 'x', category: 'nope', steps: ['a'] })).statusCode).toBe(400);
  });

  it('no procedure: step returns 404', async () => {
    const a1 = await alarmOf(1);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/alarms/${a1}/procedure/steps/0`, headers: write(officer), payload: { done: true } })).statusCode).toBe(404);
  });
});

describe('reports', () => {
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

  it('alarm report is scoped, summarised and includes response times', async () => {
    const a1 = await alarmOf(1);
    await ctx.db.query("UPDATE alarm SET acked_at = raised_at + interval '90 seconds' WHERE id = $1", [a1]);
    const q = `from=${today()}&to=${today()}`;
    const adminR = (await ctx.app.inject({ method: 'GET', url: `/api/reports/alarms?${q}`, headers: { cookie: admin } })).json();
    expect(adminR.total).toBe(2);
    const officerR = (await ctx.app.inject({ method: 'GET', url: `/api/reports/alarms?${q}`, headers: { cookie: officer } })).json();
    expect(officerR.total).toBe(1);
    expect(officerR.items[0]).toMatchObject({ pointLabel: 'גלאי 1', buildingName: 'בניין IN', ackSeconds: 90 });
    expect(officerR.responseTimes[0]).toMatchObject({ category: 'fire', count: 1, acked: 1, unacked: 0, medianSeconds: 90 });
  });

  it('date range is applied in Israel time and validated', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/reports/alarms?from=2020-01-01&to=2020-01-02', headers: { cookie: admin } });
    expect(r.json().total).toBe(0);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/reports/alarms?from=2026-02-01&to=2025-01-01', headers: { cookie: admin } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/reports/alarms?from=2020-01-01&to=2026-01-01', headers: { cookie: admin } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: "/api/reports/alarms?from=2026-01-01'&to=2026-01-02", headers: { cookie: admin } })).statusCode).toBe(400);
  });

  it('CSV export: BOM, Hebrew, scoped, audited', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: `/api/reports/alarms.csv?from=${today()}&to=${today()}`, headers: { cookie: officer } });
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toContain('attachment');
    expect(r.body.startsWith('\uFEFF')).toBe(true);
    const lines = r.body.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('גלאי 1');
    expect(r.body).not.toContain('גלאי 2');
    const audit = await ctx.db.query("SELECT details FROM audit_log WHERE action = 'report.export'");
    expect(audit.rows[0].details).toMatchObject({ rows: 1 });
  });

  it('open issues lists disabled and fault points within scope', async () => {
    await event(1, 'fault');
    await event(2, 'fault');
    const rows = (await ctx.app.inject({ method: 'GET', url: '/api/reports/open-issues', headers: { cookie: officer } })).json();
    expect(rows.map((r: { pointLabel: string }) => r.pointLabel)).toEqual(['גלאי 1']);
    const csv = await ctx.app.inject({ method: 'GET', url: '/api/reports/open-issues.csv', headers: { cookie: admin } });
    expect(csv.body).toContain('תקלה');
  });

  it('reports are not available to viewers/operators', async () => {
    for (const c of [viewer, operator]) {
      expect((await ctx.app.inject({ method: 'GET', url: `/api/reports/open-issues`, headers: { cookie: c } })).statusCode).toBe(403);
    }
  });
});

describe('CSV safety', () => {
  it('neutralises formula injection and quotes properly', () => {
    const csv = toCsv(['a', 'b'], [['=HYPERLINK("http://evil")', '+1'], ['-2', '@x'], ['plain, "quoted"', null]]);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[1]).toBe(`"'=HYPERLINK(""http://evil"")","'+1"`);
    expect(lines[2]).toBe(`"'-2","'@x"`);
    expect(lines[3]).toBe('"plain, ""quoted""",');
  });
});

describe('retention', () => {
  it('purges old event log, notifications and finished alarms, never the audit log', async () => {
    await event(1, 'quiet'); // clears alarm 1
    await ctx.db.query("UPDATE event_log SET received_at = now() - interval '800 days'");
    await ctx.db.query("UPDATE alarm SET cleared_at = now() - interval '3000 days' WHERE cleared_at IS NOT NULL");
    const auditBefore = (await ctx.db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n;
    const r = await ctx.app.runRetention();
    expect(r.eventLog).toBeGreaterThan(0);
    expect(r.alarms).toBe(1);
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM alarm WHERE cleared_at IS NULL')).rows[0].n).toBe(1); // active alarm kept
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n).toBe(auditBefore);
  });
});
