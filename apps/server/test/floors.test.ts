import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileScanner, ScanResult } from '../src/services/scanner.js';
import { loadConfig } from '../src/config.js';
import { createTestApp, loginAs, ORIGIN, write, type TestContext } from './helpers.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR fake image data')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

class TestScanner implements FileScanner {
  next: ScanResult = { status: 'clean' };
  async scan(): Promise<ScanResult> {
    return this.next;
  }
}

let ctx: TestContext;
let scanner: TestScanner;
let admin: string;
let officer: string;
let bIn: string;
let bOut: string;

beforeEach(async () => {
  scanner = new TestScanner();
  ctx = await createTestApp({ scanner });
  admin = await loginAs(ctx.app, 'admin@campus.example', ['FireAdmin']);
  officer = await loginAs(ctx.app, 'officer@campus.example', ['SafetyOfficer']);
  const mk = async (code: string) =>
    (await ctx.app.inject({ method: 'POST', url: '/api/admin/buildings', headers: write(admin), payload: { name: code, code } })).json().id as string;
  bIn = await mk('IN');
  bOut = await mk('OUT');
  const officerId = (await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: officer } })).json().id;
  await ctx.app.inject({ method: 'PUT', url: `/api/admin/users/${officerId}/scope`, headers: write(admin), payload: { buildingIds: [bIn] } });
});
afterEach(async () => ctx.close());

const mkFloor = async (buildingId: string, name = 'קומה 1', level = 1) => {
  const r = await ctx.app.inject({ method: 'POST', url: `/api/admin/buildings/${buildingId}/floors`, headers: write(admin), payload: { name, level } });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
};
const upload = (floorId: string, body: Buffer, contentType = 'image/png', cookie = admin) =>
  ctx.app.inject({ method: 'PUT', url: `/api/admin/floors/${floorId}/plan`, headers: { ...write(cookie), 'content-type': contentType }, payload: body });

describe('floors', () => {
  it('CRUD with unique names per building and scope-filtered reads', async () => {
    const f1 = await mkFloor(bIn);
    await mkFloor(bIn, 'קומה 2', 2);
    const dup = await ctx.app.inject({ method: 'POST', url: `/api/admin/buildings/${bIn}/floors`, headers: write(admin), payload: { name: 'קומה 1', level: 9 } });
    expect(dup.statusCode).toBe(409);
    const fOut = await mkFloor(bOut);

    const list = await ctx.app.inject({ method: 'GET', url: `/api/buildings/${bIn}/floors`, headers: { cookie: officer } });
    expect(list.json().map((f: { level: number }) => f.level)).toEqual([1, 2]);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/buildings/${bOut}/floors`, headers: { cookie: officer } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/floors/${fOut}`, headers: { cookie: officer } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/floors/${f1}`, headers: { cookie: officer } })).statusCode).toBe(200);

    const upd = await ctx.app.inject({ method: 'PATCH', url: `/api/admin/floors/${f1}`, headers: write(admin), payload: { name: 'קרקע', level: 0 } });
    expect(upd.json()).toMatchObject({ name: 'קרקע', level: 0 });
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/admin/floors/${f1}`, headers: write(admin) })).statusCode).toBe(204);
  });

  it('floor admin endpoints are FireAdmin-only', async () => {
    const f = await mkFloor(bIn);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/admin/buildings/${bIn}/floors`, headers: write(officer), payload: { name: 'x', level: 3 } })).statusCode).toBe(403);
    expect((await upload(f, PNG, 'image/png', officer)).statusCode).toBe(403);
  });
});

describe('floor plan upload', () => {
  it('accepts PNG/JPEG by signature and serves it inertly within scope', async () => {
    const f = await mkFloor(bIn);
    const up = await upload(f, PNG);
    expect(up.statusCode).toBe(201);
    expect(up.json()).toMatchObject({ mime: 'image/png', scanStatus: 'clean' });
    const fileId = up.json().id;

    const res = await ctx.app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: { cookie: officer } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['cache-control']).toContain('private');
    expect(res.rawPayload.equals(PNG)).toBe(true);
    const cached = await ctx.app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: { cookie: officer, 'if-none-match': res.headers.etag as string } });
    expect(cached.statusCode).toBe(304);

    // Replacing the plan deletes the previous file.
    const up2 = await upload(f, JPEG, 'image/jpeg');
    expect(up2.json().mime).toBe('image/jpeg');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: { cookie: admin } })).statusCode).toBe(404);
  });

  it('decides the type by content, not by the declared Content-Type', async () => {
    const f = await mkFloor(bIn);
    const svg = await upload(f, SVG, 'image/png');
    expect(svg.statusCode).toBe(415);
    const disguised = await upload(f, PNG, 'application/octet-stream');
    expect(disguised.json().mime).toBe('image/png');
  });

  it('rejects unsupported content types and oversized bodies', async () => {
    const f = await mkFloor(bIn);
    expect((await upload(f, SVG, 'image/svg+xml')).statusCode).toBe(415);
    const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
    expect((await upload(f, big)).statusCode).toBe(413);
  });

  it('blocks infected uploads: content discarded, nothing served, security event audited', async () => {
    const f = await mkFloor(bIn);
    scanner.next = { status: 'infected', signature: 'Eicar-Test-Signature' };
    const res = await upload(f, PNG);
    expect(res.statusCode).toBe(422);
    const { rows } = await ctx.db.query('SELECT scan_status, content IS NULL AS purged FROM stored_file');
    expect(rows).toEqual([{ scan_status: 'infected', purged: true }]);
    const floor = (await ctx.app.inject({ method: 'GET', url: `/api/floors/${f}`, headers: { cookie: admin } })).json();
    expect(floor.floor.planFileId).toBeNull();
    const audit = await ctx.db.query("SELECT outcome, details FROM audit_log WHERE action = 'file.upload'");
    expect(audit.rows[0]).toMatchObject({ outcome: 'failure', details: { reason: 'malware_detected' } });
  });

  it('fails closed when the scanner is unavailable', async () => {
    const f = await mkFloor(bIn);
    scanner.next = { status: 'error', detail: 'down' };
    expect((await upload(f, PNG)).statusCode).toBe(503);
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM stored_file')).rows[0].n).toBe(0);
  });

  it('files of out-of-scope buildings are 404', async () => {
    const f = await mkFloor(bOut);
    const fileId = (await upload(f, PNG)).json().id;
    expect((await ctx.app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: { cookie: officer } })).statusCode).toBe(404);
  });

  it('requires our Origin for uploads (CSRF)', async () => {
    const f = await mkFloor(bIn);
    const res = await ctx.app.inject({ method: 'PUT', url: `/api/admin/floors/${f}/plan`, headers: { cookie: admin, 'content-type': 'image/png' }, payload: PNG });
    expect(res.statusCode).toBe(403);
  });

  it('production config requires the ClamAV scanner', () => {
    const env = {
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://fs.example',
      DATABASE_URL: 'postgres://x',
      AUDIT_IP_PEPPER: 'x'.repeat(32),
      OIDC_ISSUER: 'https://login.microsoftonline.com/t/v2.0',
      OIDC_TENANT_ID: 't',
      OIDC_CLIENT_ID: 'c',
      OIDC_CLIENT_SECRET: 's',
    };
    expect(() => loadConfig(env)).toThrow(/UPLOAD_SCANNER must be clamav/);
    expect(() => loadConfig({ ...env, UPLOAD_SCANNER: 'clamav', SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') })).not.toThrow();
  });
});

describe('point placement and import', () => {
  let token: string;
  let pointIds: Record<number, string>;

  beforeEach(async () => {
    token = (await ctx.app.inject({ method: 'POST', url: '/api/admin/collectors', headers: write(admin), payload: { name: 'c' } })).json().token;
    const now = new Date().toISOString();
    await ctx.app.inject({
      method: 'POST',
      url: '/ingest/v1/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        epoch: 'epoch-floors',
        sentAt: now,
        collector: { version: 't', uptimeSeconds: 1, bufferDepth: 0 },
        points: [1, 2, 3].map((n) => ({ deviceInstance: 1001, objectType: 'life-safety-point', objectInstance: n, name: `DET-${n}` })),
        events: [{ seq: 1, deviceInstance: 1001, objectType: 'life-safety-point', objectInstance: 1, source: 'poll', observedAt: now, lifeSafetyState: 'alarm' }],
      },
    });
    const pts = (await ctx.app.inject({ method: 'GET', url: '/api/admin/points', headers: { cookie: admin } })).json().items;
    pointIds = Object.fromEntries(pts.map((p: { objectInstance: number; id: string }) => [p.objectInstance, p.id]));
  });

  it('placing a point on a floor assigns its building; floor view shows state and alarm', async () => {
    const f = await mkFloor(bIn);
    const r = await ctx.app.inject({ method: 'PATCH', url: `/api/admin/points/${pointIds[1]}`, headers: write(admin), payload: { floorId: f, x: 0.25, y: 0.5 } });
    expect(r.statusCode).toBe(200);
    const detail = (await ctx.app.inject({ method: 'GET', url: `/api/floors/${f}`, headers: { cookie: officer } })).json();
    expect(detail.points).toHaveLength(1);
    expect(detail.points[0]).toMatchObject({ label: 'DET-1', x: 0.25, y: 0.5, category: 'fire', acked: false });
    expect(detail.points[0].alarmId).toBeTruthy();
    const alarm = (await ctx.app.inject({ method: 'GET', url: '/api/alarms', headers: { cookie: officer } })).json().items[0];
    expect(alarm.floorId).toBe(f);
  });

  it('validates coordinates and floor/building consistency', async () => {
    const f = await mkFloor(bIn);
    const bad = await ctx.app.inject({ method: 'PATCH', url: `/api/admin/points/${pointIds[1]}`, headers: write(admin), payload: { floorId: f, x: 1.5, y: 0.5 } });
    expect(bad.statusCode).toBe(400);
    const onlyX = await ctx.app.inject({ method: 'PATCH', url: `/api/admin/points/${pointIds[1]}`, headers: write(admin), payload: { x: 0.5 } });
    expect(onlyX.statusCode).toBe(400);
    const mismatch = await ctx.app.inject({ method: 'PATCH', url: `/api/admin/points/${pointIds[1]}`, headers: write(admin), payload: { floorId: f, buildingId: bOut } });
    expect(mismatch.statusCode).toBe(400);
  });

  it('moving a point to another building detaches it from its floor', async () => {
    const f = await mkFloor(bIn);
    await ctx.app.inject({ method: 'PATCH', url: `/api/admin/points/${pointIds[1]}`, headers: write(admin), payload: { floorId: f, x: 0.1, y: 0.1 } });
    await ctx.app.inject({ method: 'PATCH', url: `/api/admin/points/${pointIds[1]}`, headers: write(admin), payload: { buildingId: bOut } });
    const { rows } = await ctx.db.query('SELECT floor_id, x, y, building_id FROM point WHERE id = $1', [pointIds[1]]);
    expect(rows[0]).toEqual({ floor_id: null, x: null, y: null, building_id: bOut });
  });

  const csv = (body: string, dryRun: boolean) =>
    ctx.app.inject({ method: 'POST', url: `/api/admin/points/import?dryRun=${dryRun ? 1 : 0}`, headers: { ...write(admin), 'content-type': 'text/csv' }, payload: body });

  it('CSV import: dry-run previews, apply updates, Hebrew headers and ";" delimiter', async () => {
    await mkFloor(bIn, 'קומה 2', 2);
    const body = '\uFEFFרכזת;סוג אובייקט;מספר אובייקט;קוד מבנה;קומה;שם תצוגה;מיקום;x;y\n1001;life-safety-point;1;IN;2;"גלאי ""מסדרון""";ליד 204;40%;0.3\n1001;life-safety-point;2;IN;;גלאי מטבח;;;\n';
    const dry = (await csv(body, true)).json();
    expect(dry).toMatchObject({ dryRun: true, rows: 2, applied: 0, errors: [] });
    expect(dry.preview[0].changes).toMatchObject({ label: 'גלאי "מסדרון"', x: 0.4, y: 0.3 });
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM point WHERE label IS NOT NULL')).rows[0].n).toBe(0);

    const applied = (await csv(body, false)).json();
    expect(applied.applied).toBe(2);
    const { rows } = await ctx.db.query('SELECT label, location, x, building_id FROM point WHERE id = $1', [pointIds[1]]);
    expect(rows[0]).toMatchObject({ label: 'גלאי "מסדרון"', location: 'ליד 204', building_id: bIn });
    expect(rows[0].x).toBeCloseTo(0.4);
    const audit = await ctx.db.query("SELECT details FROM audit_log WHERE action = 'points.import'");
    expect(audit.rows[0].details).toMatchObject({ applied: 2 });
  });

  it('CSV import is all-or-nothing and reports per-line errors', async () => {
    const body = [
      'device_instance,object_type,object_instance,building_code,floor_level,label,x,y',
      '1001,life-safety-point,1,IN,,ok,,',
      '1001,life-safety-point,99,IN,,missing,,',
      '1001,life-safety-point,2,NOPE,,bad building,,',
      '1001,life-safety-point,3,IN,7,no such floor,,',
      'abc,life-safety-point,3,IN,,bad number,,',
      '1001,life-safety-point,1,IN,,duplicate,,',
      '1001,life-safety-point,3,,,,0.5,0.5',
    ].join('\n');
    const r = (await csv(body, false)).json();
    expect(r.applied).toBe(0);
    expect(r.errors.map((e: { line: number }) => e.line)).toEqual([3, 4, 5, 6, 7, 8]);
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM point WHERE label IS NOT NULL')).rows[0].n).toBe(0);
  });

  it('CSV import rejects missing required columns and malformed CSV', async () => {
    expect((await csv('label\nx', true)).statusCode).toBe(400);
    expect((await csv('device_instance,object_type,object_instance\n"1001,life', true)).statusCode).toBe(400);
  });

  it('import requires FireAdmin', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/admin/points/import', headers: { ...write(officer), 'content-type': 'text/csv' }, payload: 'a' });
    expect(r.statusCode).toBe(403);
    expect(ORIGIN).toBeTruthy();
  });
});
