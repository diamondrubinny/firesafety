import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, loginAs, write, type TestContext } from './helpers.js';

let ctx: TestContext;
let admin: string;
let officer: string;
let officerId: string;
let b1: string;
let b2: string;

beforeEach(async () => {
  ctx = await createTestApp();
  admin = await loginAs(ctx.app, 'admin@campus.example', ['FireAdmin']);
  officer = await loginAs(ctx.app, 'officer@campus.example', ['SafetyOfficer']);
  officerId = (await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: officer } })).json().id;

  const fac = await ctx.app.inject({ method: 'POST', url: '/api/admin/faculties', headers: write(admin), payload: { name: 'הנדסת חשמל' } });
  expect(fac.statusCode).toBe(201);
  const mk = async (code: string) => {
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/buildings',
      headers: write(admin),
      payload: { name: `בניין ${code}`, code, facultyId: fac.json().id },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };
  b1 = await mk('EE-1');
  b2 = await mk('EE-2');
  const scope = await ctx.app.inject({ method: 'PUT', url: `/api/admin/users/${officerId}/scope`, headers: write(admin), payload: { buildingIds: [b1] } });
  expect(scope.statusCode).toBe(200);
});
afterEach(async () => ctx.close());

describe('building scope (IDOR protection)', () => {
  it('admin sees all buildings', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/buildings', headers: { cookie: admin } });
    expect(res.json().map((b: { code: string }) => b.code).sort()).toEqual(['EE-1', 'EE-2']);
  });

  it('officer sees only assigned buildings', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/buildings', headers: { cookie: officer } });
    expect(res.json().map((b: { id: string }) => b.id)).toEqual([b1]);
  });

  it('officer gets 404 (not 403) for an out-of-scope building, and the attempt is audited', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/buildings/${b2}`, headers: { cookie: officer } });
    expect(res.statusCode).toBe(404);
    const { rows } = await ctx.db.query(
      "SELECT outcome FROM audit_log WHERE action = 'building.read' AND entity_id = $1 AND user_id = $2",
      [b2, officerId],
    );
    expect(rows).toEqual([{ outcome: 'denied' }]);
  });

  it('officer can read an in-scope building', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/buildings/${b1}`, headers: { cookie: officer } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ code: 'EE-1', facultyName: 'הנדסת חשמל' });
  });

  it('scope changes take effect immediately', async () => {
    await ctx.app.inject({ method: 'PUT', url: `/api/admin/users/${officerId}/scope`, headers: write(admin), payload: { buildingIds: [] } });
    const res = await ctx.app.inject({ method: 'GET', url: `/api/buildings/${b1}`, headers: { cookie: officer } });
    expect(res.statusCode).toBe(404);
  });
});

describe('admin authorization', () => {
  it.each([
    ['POST', '/api/admin/buildings'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/audit'],
  ])('officer is forbidden from %s %s', async (method, url) => {
    const res = await ctx.app.inject({ method: method as 'GET', url, headers: write(officer), payload: method === 'POST' ? { name: 'x', code: 'x' } : undefined });
    expect(res.statusCode).toBe(403);
  });

  it('officer cannot widen their own scope', async () => {
    const res = await ctx.app.inject({ method: 'PUT', url: `/api/admin/users/${officerId}/scope`, headers: write(officer), payload: { buildingIds: [b1, b2] } });
    expect(res.statusCode).toBe(403);
    const { rows } = await ctx.db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'authz.denied' AND user_id = $1", [officerId]);
    expect(rows[0].n).toBe(1);
  });
});

describe('admin CRUD and validation', () => {
  it('rejects invalid input with field-level details', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/admin/buildings', headers: write(admin), payload: { name: '', code: 'bad code!' } });
    expect(res.statusCode).toBe(400);
    const paths = res.json().details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['name', 'code']));
  });

  it('rejects malformed ids', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: "/api/buildings/1'%20OR%201=1", headers: { cookie: admin } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 on duplicate building code (case-insensitive)', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/admin/buildings', headers: write(admin), payload: { name: 'dup', code: 'ee-1' } });
    expect(res.statusCode).toBe(409);
  });

  it('returns 404 for an unknown faculty', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/buildings',
      headers: write(admin),
      payload: { name: 'x', code: 'X1', facultyId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('updates and deletes a building, auditing each action', async () => {
    const upd = await ctx.app.inject({ method: 'PATCH', url: `/api/admin/buildings/${b2}`, headers: write(admin), payload: { name: 'בניין חדש' } });
    expect(upd.json().name).toBe('בניין חדש');
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/admin/buildings/${b2}`, headers: write(admin) });
    expect(del.statusCode).toBe(204);
    const again = await ctx.app.inject({ method: 'DELETE', url: `/api/admin/buildings/${b2}`, headers: write(admin) });
    expect(again.statusCode).toBe(404);
    const audit = await ctx.app.inject({ method: 'GET', url: '/api/admin/audit?limit=200', headers: { cookie: admin } });
    const actions = audit.json().items.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['building.update', 'building.delete', 'user.scope.set', 'faculty.create']));
  });

  it('rejects scope assignment to non-existent buildings', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/admin/users/${officerId}/scope`,
      headers: write(admin),
      payload: { buildingIds: ['00000000-0000-4000-8000-000000000000'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists users with their scopes', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: admin } });
    const officerRow = res.json().items.find((u: { id: string }) => u.id === officerId);
    expect(officerRow.buildingIds).toEqual([b1]);
  });
});

describe('audit log', () => {
  it('is append-only at the database level', async () => {
    await expect(ctx.db.query("UPDATE audit_log SET action = 'tampered'")).rejects.toThrow(/append-only/);
    await expect(ctx.db.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
  });
});

describe('health', () => {
  it('reports readiness', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.json()).toEqual({ status: 'ready' });
  });
});
